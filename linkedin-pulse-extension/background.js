// Pulse LinkedIn Collector - Background Service Worker
// Handles Airtable sync and storage

const AIRTABLE_API_URL = "https://api.airtable.com/v0";

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
});

console.log("[Pulse] Background service worker loaded");
