// Pulse GershonCRM — LinkedIn Message Triage Dashboard
// Deploy: /var/www/gershonpulse/ on Hostinger VPS, PM2 app "gershonpulse"

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3010;
const DATA_DIR = path.join(__dirname, "data");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");

// Middleware
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize messages file if missing
if (!fs.existsSync(MESSAGES_FILE)) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify({ scans: [], messages: [] }, null, 2));
}

// --- Helpers ---

function readMessages() {
  try {
    const raw = fs.readFileSync(MESSAGES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { scans: [], messages: [] };
  }
}

function writeMessages(data) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2));
}

// --- API Routes ---

// POST /api/messages — receive classified conversations from Chrome extension
app.post("/api/messages", (req, res) => {
  try {
    const { conversations, scanMeta } = req.body;

    if (!conversations || !Array.isArray(conversations)) {
      return res.status(400).json({ error: "Missing conversations array" });
    }

    const data = readMessages();
    const now = new Date().toISOString();

    // Record the scan
    const scan = {
      id: Date.now().toString(36),
      timestamp: now,
      count: conversations.length,
      red: conversations.filter((c) => c.status === "Red").length,
      orange: conversations.filter((c) => c.status === "Orange").length,
      green: conversations.filter((c) => c.status === "Green").length,
      ...(scanMeta || {}),
    };
    data.scans.unshift(scan);

    // Keep last 100 scans
    if (data.scans.length > 100) data.scans = data.scans.slice(0, 100);

    // Upsert messages by name (latest scan wins)
    const existingByName = new Map(data.messages.map((m) => [m.name, m]));

    for (const conv of conversations) {
      existingByName.set(conv.name, {
        ...conv,
        scanId: scan.id,
        updatedAt: now,
        // Preserve any manual overrides from previous entries
        ...(existingByName.has(conv.name) && existingByName.get(conv.name).manualStatus
          ? { manualStatus: existingByName.get(conv.name).manualStatus }
          : {}),
      });
    }

    data.messages = Array.from(existingByName.values());

    writeMessages(data);

    res.json({
      success: true,
      scanId: scan.id,
      received: conversations.length,
      totalStored: data.messages.length,
    });
  } catch (err) {
    console.error("[Pulse API] POST /api/messages error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages — return all stored messages
app.get("/api/messages", (req, res) => {
  try {
    const data = readMessages();
    const { status, search, sort } = req.query;

    let messages = data.messages;

    // Filter by status
    if (status && status !== "all") {
      messages = messages.filter((m) => m.status === status);
    }

    // Search by name or snippet
    if (search) {
      const q = search.toLowerCase();
      messages = messages.filter(
        (m) =>
          (m.name && m.name.toLowerCase().includes(q)) ||
          (m.snippet && m.snippet.toLowerCase().includes(q))
      );
    }

    // Sort
    if (sort === "name") {
      messages.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } else if (sort === "date") {
      messages.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    } else {
      // Default: Red first, then Orange, then Green
      const order = { Red: 0, Orange: 1, Green: 2 };
      messages.sort((a, b) => (order[a.status] || 3) - (order[b.status] || 3));
    }

    res.json({
      messages,
      total: messages.length,
      stats: {
        red: data.messages.filter((m) => m.status === "Red").length,
        orange: data.messages.filter((m) => m.status === "Orange").length,
        green: data.messages.filter((m) => m.status === "Green").length,
        total: data.messages.length,
      },
      lastScan: data.scans.length > 0 ? data.scans[0] : null,
    });
  } catch (err) {
    console.error("[Pulse API] GET /api/messages error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messages/stats — aggregated stats only
app.get("/api/messages/stats", (req, res) => {
  try {
    const data = readMessages();

    res.json({
      red: data.messages.filter((m) => m.status === "Red").length,
      orange: data.messages.filter((m) => m.status === "Orange").length,
      green: data.messages.filter((m) => m.status === "Green").length,
      total: data.messages.length,
      scans: data.scans.slice(0, 10),
      lastScan: data.scans.length > 0 ? data.scans[0] : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/messages/:name — manually override a message status
app.patch("/api/messages/:name", (req, res) => {
  try {
    const { name } = req.params;
    const { status, note } = req.body;

    if (status && !["Red", "Orange", "Green"].includes(status)) {
      return res.status(400).json({ error: "Status must be Red, Orange, or Green" });
    }

    const data = readMessages();
    const msg = data.messages.find((m) => m.name === decodeURIComponent(name));

    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    if (status) {
      msg.manualStatus = status;
      msg.status = status;
    }
    if (note !== undefined) {
      msg.note = note;
    }
    msg.updatedAt = new Date().toISOString();

    writeMessages(data);
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/messages — clear all messages
app.delete("/api/messages", (req, res) => {
  try {
    writeMessages({ scans: [], messages: [] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), version: "2.0.0" });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`[Pulse] Dashboard running on port ${PORT}`);
  console.log(`[Pulse] Data stored at ${MESSAGES_FILE}`);
});
