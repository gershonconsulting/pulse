// Pulse LinkedIn Collector - Background Service Worker
// Handles Airtable sync, storage, and auto-sync via alarms

const AIRTABLE_API_URL = "https://api.airtable.com/v0";

// Auto-sync alarm setup
const SYNC_ALARM_NAME = 'pulse-auto-sync';
const SYNC_INTERVAL_MINUTES = 24 * 60; // 24 hours
const PULSE_API_URL = 'https://pulse.gershoncrm.com';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM_NAME, {
    delayInMinutes: 1, // first sync 1 min after install
    periodInMinutes: SYNC_INTERVAL_MINUTES
  });
  console.log('[Pulse] Auto-sync alarm set for every 24h');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    console.log('[Pulse] Auto-sync triggered');
    await runAutoSync();
  }
});

async function runAutoSync() {
  const results = { linkedin: null, salesNav: null };

  try {
    // Step 1: Sync LinkedIn Messaging
    results.linkedin = await syncSource(
      'https://www.linkedin.com/messaging/',
      'https://www.linkedin.com/messaging/*',
      'linkedin-messaging'
    );

    // Step 2: Sync Sales Navigator
    results.salesNav = await syncSource(
      'https://www.linkedin.com/sales/inbox/',
      'https://www.linkedin.com/sales/inbox/*',
      'sales-navigator'
    );

    // Step 3: Trigger email report
    await triggerEmailReport();

    // Store sync results
    chrome.storage.local.set({
      lastAutoSync: new Date().toISOString(),
      lastAutoSyncResults: results
    });

    console.log('[Pulse] Auto-sync complete', results);
  } catch (err) {
    console.error('[Pulse] Auto-sync error:', err);
    chrome.storage.local.set({
      lastAutoSync: new Date().toISOString(),
      lastAutoSyncError: err.message
    });
  }
}

async function syncSource(url, matchPattern, sourceName) {
  // Find or create tab
  const tabs = await chrome.tabs.query({ url: matchPattern });
  let tab;

  if (tabs.length > 0) {
    tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: false }); // keep in background
  } else {
    tab = await chrome.tabs.create({ url, active: false });
  }

  // Wait for tab to load
  await waitForTab(tab.id);

  // Inject content script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch (e) {
    // Already injected
  }

  await new Promise(r => setTimeout(r, 2000));

  // Collect conversations
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: 'START_COLLECTION' }, async (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        resolve({ success: false, error: chrome.runtime.lastError?.message || 'No response' });
        return;
      }

      // POST to Pulse API
      try {
        const res = await fetch(`${PULSE_API_URL}/api/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversations: response.conversations,
            scanMeta: { source: sourceName, version: '1.4.0', autoSync: true }
          })
        });
        const data = await res.json();
        resolve({ success: true, count: response.conversations.length, apiResult: data });
      } catch (err) {
        resolve({ success: false, count: response.conversations.length, error: err.message });
      }

      // Close tab if we created it
      if (!tabs.length) {
        chrome.tabs.remove(tab.id).catch(() => {});
      }
    });
  });
}

function waitForTab(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 3000); // Extra time for JS rendering
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 3000);
      }
    });
  });
}

async function triggerEmailReport() {
  try {
    const res = await fetch(`${PULSE_API_URL}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'auto-sync' })
    });
    return await res.json();
  } catch (err) {
    console.error('[Pulse] Email report trigger failed:', err);
    return { success: false, error: err.message };
  }
}

// Push conversations to Airtable
async function syncToAirtable(conversations, settings) {
  const { airtableToken, airtableBaseId, airtableTableName } = settings;

  if (!airtableToken || !airtableBaseId) {
    return { success: false, error: "Airtable not configured" };
  }

  const tableName = airtableTableName || "LinkedIn Messages";
  const url = `${AIRTABLE_API_URL}/${airtableBaseId}/${encodeURIComponent(tableName)}`;

  // Airtable allows max 10 records per request
  const batches = [];
  for (let i = 0; i < conversations.length; i += 10) {
    batches.push(conversations.slice(i, i + 10));
  }

  let created = 0;
  let errors = [];

  for (const batch of batches) {
    const records = batch.map((c) => ({
      fields: {
        Name: c.name,
        "Last Message": c.snippet.substring(0, 500),
        "Last Sender": c.lastSender === "you" ? "Olivier" : c.name.split(" ")[0],
        Date: c.date,
        "Unread Count": c.unread,
        Status: c.status,
        Reason: c.reason,
        "Profile URL": c.profileUrl || "",
        "Collected At": c.collectedAt,
      },
    }));

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${airtableToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records }),
      });

      if (response.ok) {
        const data = await response.json();
        created += data.records.length;
      } else {
        const errData = await response.json();
        errors.push(errData.error?.message || `HTTP ${response.status}`);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  return { success: errors.length === 0, created, errors };
}

// Create the Airtable table structure (first-time setup)
async function setupAirtableTable(settings) {
  const { airtableToken, airtableBaseId } = settings;
  const tableName = settings.airtableTableName || "LinkedIn Messages";

  // Try to create a record to test if table exists
  const url = `${AIRTABLE_API_URL}/${airtableBaseId}/${encodeURIComponent(tableName)}`;

  try {
    const response = await fetch(`${url}?maxRecords=1`, {
      headers: { Authorization: `Bearer ${airtableToken}` },
    });

    if (response.ok) {
      return { success: true, message: "Table already exists" };
    }

    // Table doesn't exist - user needs to create it manually or via API
    return {
      success: false,
      message:
        'Table not found. Please create a table called "' +
        tableName +
        '" in your Airtable base with these fields: Name (text), Last Message (long text), Last Sender (text), Date (text), Unread Count (number), Status (single select: Green/Orange/Red), Reason (text), Profile URL (url), Collected At (text)',
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SYNC_AIRTABLE") {
    chrome.storage.local.get(["airtableToken", "airtableBaseId", "airtableTableName"], (settings) => {
      syncToAirtable(message.conversations, settings).then((result) => {
        sendResponse(result);
      });
    });
    return true;
  }

  if (message.type === "TEST_AIRTABLE") {
    chrome.storage.local.get(["airtableToken", "airtableBaseId", "airtableTableName"], (settings) => {
      setupAirtableTable(settings).then((result) => {
        sendResponse(result);
      });
    });
    return true;
  }

  if (message.type === "SCAN_PROGRESS") {
    // Forward progress to popup if open
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  if (message.type === "FORCE_AUTO_SYNC") {
    runAutoSync().then(() => sendResponse({ success: true }));
    return true;
  }
});

console.log("[Pulse] Background service worker loaded (v1.4.0)");
