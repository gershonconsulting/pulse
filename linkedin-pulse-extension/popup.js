// Pulse LinkedIn Collector - Popup Script

let collectedConversations = [];
const DEFAULT_PULSE_URL = "https://pulse.gershoncrm.com";

// Auto-sync to Pulse dashboard after every scan
async function syncToPulse(conversations) {
  try {
    const data = await chrome.storage.local.get(["pulseUrl"]);
    const pulseUrl = data.pulseUrl || DEFAULT_PULSE_URL;

    const res = await fetch(`${pulseUrl}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversations,
        scanMeta: { source: "chrome-extension", version: "1.2.0" },
      }),
    });

    if (res.ok) {
      const result = await res.json();
      console.log(`[Pulse] Synced ${result.received} messages to dashboard`);
      return { success: true, ...result };
    } else {
      console.error("[Pulse] Sync failed:", res.status);
      return { success: false, error: `HTTP ${res.status}` };
    }
  } catch (err) {
    console.error("[Pulse] Sync error:", err.message);
    return { success: false, error: err.message };
  }
}

// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("view-" + tab.dataset.tab).classList.add("active");
  });
});

// Update stats display
function updateStats(conversations) {
  const red = conversations.filter((c) => c.status === "Red").length;
  const orange = conversations.filter((c) => c.status === "Orange").length;
  const green = conversations.filter((c) => c.status === "Green").length;

  document.getElementById("count-red").textContent = red;
  document.getElementById("count-orange").textContent = orange;
  document.getElementById("count-green").textContent = green;
  document.getElementById("stats").style.display = "grid";
  document.getElementById("btn-sync").disabled = conversations.length === 0;
}

// Render conversation list
function renderConversations(conversations) {
  const list = document.getElementById("conv-list");

  if (conversations.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>No conversations collected yet.</p></div>';
    return;
  }

  // Sort: Red first, then Orange, then Green
  const sorted = [...conversations].sort((a, b) => {
    const order = { Red: 0, Orange: 1, Green: 2 };
    return (order[a.status] || 3) - (order[b.status] || 3);
  });

  list.innerHTML = sorted
    .map(
      (c) => `
    <div class="conv-item">
      <div class="conv-dot dot-${c.status.toLowerCase()}"></div>
      <div class="conv-info">
        <div class="conv-name">${escapeHtml(c.name)}</div>
        <div class="conv-snippet">${escapeHtml(c.snippet || "(no preview)")}</div>
        <div class="conv-meta">${escapeHtml(c.date)} &middot; ${c.status} &middot; ${escapeHtml(c.reason)}</div>
      </div>
    </div>
  `
    )
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showStatus(elementId, message, isError) {
  const el = document.getElementById(elementId);
  el.innerHTML = `<div class="status-msg ${isError ? "status-error" : "status-success"}">${escapeHtml(message)}</div>`;
  setTimeout(() => (el.innerHTML = ""), 5000);
}

// Auto-navigate: find or open LinkedIn Messaging, wait for load, return tab
async function ensureLinkedInMessaging(progress) {
  const MESSAGING_URL = "https://www.linkedin.com/messaging/";

  // 1. Check if any existing tab is already on LinkedIn messaging
  const existingTabs = await chrome.tabs.query({ url: "https://www.linkedin.com/messaging/*" });

  if (existingTabs.length > 0) {
    const tab = existingTabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    if (tab.status === "complete") return tab;
    if (progress) progress.textContent = "Waiting for LinkedIn Messaging to finish loading...";
    return await waitForTabLoad(tab.id);
  }

  // 2. Check if active tab is on LinkedIn (navigate it to messaging)
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let targetTabId;

  if (activeTab && activeTab.url && activeTab.url.includes("linkedin.com")) {
    if (progress) progress.textContent = "Navigating to LinkedIn Messaging...";
    await chrome.tabs.update(activeTab.id, { url: MESSAGING_URL });
    targetTabId = activeTab.id;
  } else {
    // 3. Create a brand new tab
    if (progress) progress.textContent = "Opening LinkedIn Messaging...";
    const newTab = await chrome.tabs.create({ url: MESSAGING_URL, active: true });
    targetTabId = newTab.id;
  }

  if (progress) progress.textContent = "Waiting for LinkedIn Messaging to load...";
  return await waitForTabLoad(targetTabId);
}

// Wait for a tab to finish loading (30s timeout)
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.get(tabId, (tab) => resolve(tab));
    }, 30000);

    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra delay for LinkedIn JS to render the messaging UI
        setTimeout(() => resolve(tab), 2500);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Full scan — auto-navigates to LinkedIn Messaging
document.getElementById("btn-scan").addEventListener("click", async () => {
  const btn = document.getElementById("btn-scan");
  const progress = document.getElementById("progress");

  btn.disabled = true;
  btn.textContent = "Scanning...";
  progress.classList.add("active");
  progress.textContent = "Opening LinkedIn Messaging...";

  try {
    const tab = await ensureLinkedInMessaging(progress);

    progress.textContent = "Injecting collector...";

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    } catch (e) {
      // Already injected
    }

    await new Promise((r) => setTimeout(r, 500));
    progress.textContent = "Scrolling through conversations...";

    chrome.tabs.sendMessage(tab.id, { type: "START_COLLECTION" }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus("status-area", "Error: " + chrome.runtime.lastError.message, true);
        btn.disabled = false;
        btn.textContent = "Scan All Messages";
        progress.classList.remove("active");
        return;
      }

      if (response && response.success) {
        collectedConversations = response.conversations;
        updateStats(collectedConversations);
        renderConversations(collectedConversations);

        chrome.storage.local.set({
          conversations: collectedConversations,
          lastScan: new Date().toISOString(),
        });

        progress.textContent = `Collected ${collectedConversations.length} — syncing to Pulse dashboard...`;

        // Auto-sync to Pulse dashboard
        syncToPulse(collectedConversations).then((pulseResult) => {
          if (pulseResult.success) {
            progress.textContent = `Done! ${collectedConversations.length} conversations synced to pulse.gershoncrm.com`;
            showStatus("status-area", `Collected ${collectedConversations.length} conversations — synced to Pulse`, false);
          } else {
            progress.textContent = `Collected ${collectedConversations.length} conversations (Pulse sync failed: ${pulseResult.error})`;
            showStatus("status-area", `Collected ${collectedConversations.length} — Pulse sync failed`, true);
          }
          setTimeout(() => progress.classList.remove("active"), 4000);
        });
      } else {
        showStatus("status-area", "Scan failed - no data returned", true);
      }

      btn.disabled = false;
      btn.textContent = "Scan All Messages";
    });
  } catch (err) {
    showStatus("status-area", "Error: " + err.message, true);
    btn.disabled = false;
    btn.textContent = "Scan All Messages";
    progress.classList.remove("active");
  }
});

// Quick scan — also auto-navigates
document.getElementById("btn-quick").addEventListener("click", async () => {
  const btn = document.getElementById("btn-quick");
  const progress = document.getElementById("progress");
  btn.disabled = true;
  btn.textContent = "Scanning...";
  progress.classList.add("active");
  progress.textContent = "Opening LinkedIn Messaging...";

  try {
    const tab = await ensureLinkedInMessaging(progress);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    } catch (e) {}

    await new Promise((r) => setTimeout(r, 500));
    progress.textContent = "Scanning visible conversations...";

    chrome.tabs.sendMessage(tab.id, { type: "QUICK_SCAN" }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus("status-area", "Error: " + chrome.runtime.lastError.message, true);
      } else if (response && response.success) {
        collectedConversations = response.conversations;
        updateStats(collectedConversations);
        renderConversations(collectedConversations);
        chrome.storage.local.set({
          conversations: collectedConversations,
          lastScan: new Date().toISOString(),
        });
        // Auto-sync to Pulse
        syncToPulse(collectedConversations).then((pulseResult) => {
          if (pulseResult.success) {
            showStatus("status-area", `Quick scan: ${collectedConversations.length} — synced to Pulse`, false);
          } else {
            showStatus("status-area", `Quick scan: ${collectedConversations.length} (Pulse sync failed)`, true);
          }
        });
      }
      btn.disabled = false;
      btn.textContent = "Quick Scan (visible only)";
      progress.classList.remove("active");
    });
  } catch (err) {
    showStatus("status-area", "Error: " + err.message, true);
    btn.disabled = false;
    btn.textContent = "Quick Scan (visible only)";
    progress.classList.remove("active");
  }
});

// Sync to Airtable
document.getElementById("btn-sync").addEventListener("click", async () => {
  const btn = document.getElementById("btn-sync");
  btn.disabled = true;
  btn.textContent = "Syncing...";

  chrome.runtime.sendMessage(
    { type: "SYNC_AIRTABLE", conversations: collectedConversations },
    (response) => {
      if (response && response.success) {
        showStatus("status-area", `Synced ${response.created} records to Airtable`, false);
      } else {
        const errMsg = response?.errors?.join(", ") || response?.error || "Sync failed";
        showStatus("status-area", errMsg, true);
      }
      btn.disabled = false;
      btn.textContent = "Sync to Airtable";
    }
  );
});

// Settings
document.getElementById("btn-save-settings").addEventListener("click", () => {
  const token = document.getElementById("input-token").value.trim();
  const baseId = document.getElementById("input-base").value.trim();
  const tableName = document.getElementById("input-table").value.trim() || "LinkedIn Messages";
  const pulseUrl = document.getElementById("input-pulse-url").value.trim() || DEFAULT_PULSE_URL;

  chrome.storage.local.set(
    { airtableToken: token, airtableBaseId: baseId, airtableTableName: tableName, pulseUrl: pulseUrl },
    () => {
      showStatus("settings-status", "Settings saved", false);
    }
  );
});

document.getElementById("btn-test-connection").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TEST_AIRTABLE" }, (response) => {
    if (response && response.success) {
      showStatus("settings-status", response.message, false);
    } else {
      showStatus("settings-status", response?.message || "Connection failed", true);
    }
  });
});

// Load saved data on popup open
chrome.storage.local.get(
  ["conversations", "lastScan", "airtableToken", "airtableBaseId", "airtableTableName", "pulseUrl"],
  (data) => {
    if (data.conversations && data.conversations.length > 0) {
      collectedConversations = data.conversations;
      updateStats(collectedConversations);
      renderConversations(collectedConversations);
    }
    if (data.airtableToken) document.getElementById("input-token").value = data.airtableToken;
    if (data.airtableBaseId) document.getElementById("input-base").value = data.airtableBaseId;
    if (data.airtableTableName) document.getElementById("input-table").value = data.airtableTableName;
    if (data.pulseUrl) document.getElementById("input-pulse-url").value = data.pulseUrl;
  }
);

// Listen for scan progress updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SCAN_PROGRESS") {
    const progress = document.getElementById("progress");
    progress.textContent = `Scanning... ${message.count} conversations found (scroll ${message.attempt})`;
  }
});
