// Pulse LinkedIn Collector - Content Script
// Runs on LinkedIn messaging pages to extract conversation data

(function () {
  "use strict";

  const SCROLL_DELAY = 1500;
  const MAX_SCROLL_ATTEMPTS = 50;

  // Classification rules
  function classify(conversation) {
    const { lastSender, snippet } = conversation;
    const lower = snippet.toLowerCase();

    // GREEN: You (Olivier) sent the last message
    if (lastSender === "you") {
      return { status: "Green", reason: "You sent the last message" };
    }

    // Check for ORANGE patterns (no action needed)
    const declinePatterns = [
      /non\s*(merci|pas)/i,
      /not\s*interested/i,
      /no\s*thank/i,
      /already\s*(have|present|exist)/i,
      /d[eé]j[aà]/i,
      /pas\s*(du\s*tout|besoin|int[eé]ress)/i,
      /belle\s*soir[eé]e/i,
      /bonne\s*(journ[eé]e|continuation)/i,
      /merci\s*(je\s*regarde|pour)/i,
      /i('|\s)ll\s*(look|check|get\s*back)/i,
      /we('|\s)re\s*(good|all\s*set|covered)/i,
      /no\s*need/i,
      /freelance.*seul/i,
    ];

    for (const pattern of declinePatterns) {
      if (pattern.test(lower)) {
        return { status: "Orange", reason: "Decline or acknowledgment detected" };
      }
    }

    // RED: Question, interest, action needed
    const redPatterns = [
      /\?/,
      /drop\s*(me|us)\s*(an?\s*)?email/i,
      /let('|\s)s\s*(connect|chat|talk|meet|schedule|arrange)/i,
      /interested/i,
      /i('|\s)d\s*(love|like)\s*to/i,
      /can\s*(we|you)/i,
      /would\s*(love|like|value)/i,
      /reach(ing)?\s*out/i,
      /open\s*to/i,
      /working\s*on\s*something/i,
      /your\s*perspective/i,
      /how\s*to/i,
      /tell\s*me\s*more/i,
      /send\s*(me|us)/i,
      /waiting/i,
      /follow\s*up/i,
      /thank\s*you\s*for\s*reach/i,
      /great\s*to\s*reconnect/i,
      /investor/i,
      /syndicate/i,
      /attachment/i,
    ];

    for (const pattern of redPatterns) {
      if (pattern.test(lower)) {
        return { status: "Red", reason: "Interest, question, or action needed" };
      }
    }

    // Default: if they sent last and no pattern matched, mark Red (safe side)
    if (lastSender !== "you") {
      return { status: "Red", reason: "They sent last - review needed" };
    }

    return { status: "Green", reason: "No action detected" };
  }

  // Extract data from a single conversation list item
  function extractConversation(item) {
    const lines = item.innerText.split("\n").filter((l) => l.trim());

    // Find name (skip status lines, timestamps, notifications)
    let name = "";
    for (const line of lines) {
      if (
        line.startsWith("Status is") ||
        line.match(/^\d+:\d+/) ||
        line.match(/^May|^Apr|^Mar|^Feb|^Jan|^Jun|^Jul|^Aug|^Sep|^Oct|^Nov|^Dec/) ||
        line.includes("new notification") ||
        line.includes("Press return") ||
        line.includes("Open the options") ||
        line.includes("Active conversation") ||
        line.includes("Star conversation") ||
        line.includes("Select conversation") ||
        line.includes("Received") ||
        line.includes("Sponsored") ||
        line.length <= 2
      ) {
        continue;
      }
      name = line.trim();
      break;
    }

    // Find snippet (message preview)
    let snippet = "";
    let lastSender = "them";
    for (const line of lines) {
      if (line.startsWith("You:")) {
        snippet = line.substring(4).trim();
        lastSender = "you";
        break;
      }
      const nameFirst = name.split(" ")[0];
      if (line.startsWith(nameFirst + ":")) {
        snippet = line.substring(nameFirst.length + 1).trim();
        lastSender = "them";
        break;
      }
    }

    // Find date
    let date = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.match(/^\d+:\d+\s*(AM|PM)$/i)) {
        date = trimmed;
        break;
      }
      if (trimmed.match(/^(May|Apr|Mar|Feb|Jan|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+$/)) {
        date = trimmed;
        break;
      }
    }

    // Unread count
    let unread = 0;
    const unreadEl = item.querySelector('[class*="unread-count"]');
    if (unreadEl) {
      unread = parseInt(unreadEl.innerText) || 0;
    }

    // LinkedIn profile URL
    let profileUrl = "";
    const profileLink = item.querySelector('a[href*="/in/"]');
    if (profileLink) {
      profileUrl = profileLink.href;
    }

    if (!name || name.includes("Sponsored")) return null;

    const conv = { name, snippet, lastSender, date, unread, profileUrl };
    const classification = classify(conv);

    return {
      ...conv,
      status: classification.status,
      reason: classification.reason,
      collectedAt: new Date().toISOString(),
    };
  }

  // Scroll the conversation list to load all items
  async function scrollConversationList() {
    const listEl = document.querySelector(".msg-conversations-container__conversations-list");
    if (!listEl) {
      console.log("[Pulse] Conversation list not found");
      return;
    }

    let previousCount = 0;
    let attempts = 0;

    while (attempts < MAX_SCROLL_ATTEMPTS) {
      const items = document.querySelectorAll("li.msg-conversation-listitem");
      const currentCount = items.length;

      if (currentCount === previousCount && attempts > 2) {
        // Try clicking "Load more" button
        const loadMore = document.querySelector(
          'button[aria-label*="Load more"], button:has(> span:contains("Load more"))'
        );
        if (loadMore) {
          loadMore.click();
          await sleep(2000);
        } else {
          // Also try finding by text content
          const buttons = document.querySelectorAll("button");
          let found = false;
          for (const btn of buttons) {
            if (btn.innerText.includes("Load more conversations")) {
              btn.click();
              found = true;
              await sleep(2000);
              break;
            }
          }
          if (!found) {
            console.log(`[Pulse] No more conversations to load. Total: ${currentCount}`);
            break;
          }
        }
      }

      previousCount = currentCount;

      // Scroll the conversation list container
      const scrollContainer =
        listEl.closest(".msg-conversations-container__conversations-list") ||
        listEl.parentElement;
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
      // Also scroll the list itself
      listEl.scrollTop = listEl.scrollHeight;

      attempts++;
      await sleep(SCROLL_DELAY);

      // Update progress via message to popup
      chrome.runtime.sendMessage({
        type: "SCAN_PROGRESS",
        count: currentCount,
        attempt: attempts,
      });
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Main collection function
  async function collectAllConversations() {
    console.log("[Pulse] Starting conversation collection...");

    // First scroll to load all conversations
    await scrollConversationList();

    // Now extract all
    const items = document.querySelectorAll("li.msg-conversation-listitem");
    const conversations = [];

    items.forEach((item) => {
      const data = extractConversation(item);
      if (data) {
        conversations.push(data);
      }
    });

    console.log(`[Pulse] Collected ${conversations.length} conversations`);
    return conversations;
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "START_COLLECTION") {
      collectAllConversations().then((conversations) => {
        sendResponse({ success: true, conversations });
      });
      return true; // Keep channel open for async response
    }

    if (message.type === "QUICK_SCAN") {
      // Fast scan without scrolling - just what's visible
      const items = document.querySelectorAll("li.msg-conversation-listitem");
      const conversations = [];
      items.forEach((item) => {
        const data = extractConversation(item);
        if (data) conversations.push(data);
      });
      sendResponse({ success: true, conversations });
      return true;
    }
  });

  console.log("[Pulse] LinkedIn Collector content script loaded");
})();
