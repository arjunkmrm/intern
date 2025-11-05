import express from "express";
import { google } from "googleapis";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";

dotenv.config();
const app = express();
// Parse JSON bodies for incoming webhooks
app.use(express.json());
// Serve frontend assets
app.use(express.static("public"));
const port = process.env.PORT || 4000;

let oauth2Client;
let gmail;
let accessToken;

// --- Simple Server-Sent Events (SSE) hub ---
const sseClients = new Set();
function sseBroadcast(event, payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const res of sseClients) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
    } catch (_) {}
  }
}

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(":\n\n"); } catch (_) {}
  }, 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// --- OAuth setup ---
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
  );
}

// Step 1: Login link
app.get("/connect", (req, res) => {
  oauth2Client = getOAuthClient();
  const scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
  });
  res.redirect(url);
});

// Step 2: OAuth callback
app.get("/oauth2callback", async (req, res) => {
  try {
    oauth2Client = getOAuthClient();
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    accessToken = tokens.access_token;

    gmail = google.gmail({ version: "v1", auth: oauth2Client });
    // Redirect back to the app root after successful connection
    res.redirect("/");
  } catch (e) {
    console.error("OAuth callback error:", e.message);
    res.redirect("/?error=oauth");
  }
});

// Simple health and connection status
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});
app.get("/api/status", async (req, res) => {
  try {
    const connected = Boolean(gmail);
    let profile = null;
    if (connected) {
      try {
        const p = await gmail.users.getProfile({ userId: "me" });
        profile = p.data || null;
      } catch (_) {}
    }
    res.json({ connected, profile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Helpers to extract readable email text from Gmail payload ---
function decodeBase64UrlToUtf8(data) {
  if (!data) return "";
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>(?=\s*<)/gi, "\n")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<li>/gi, " • ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractEmailBodies(payload) {
  let text = "";
  let html = "";

  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data && !text) {
      text = decodeBase64UrlToUtf8(part.body.data);
    }
    if (part.mimeType === "text/html" && part.body?.data && !html) {
      html = decodeBase64UrlToUtf8(part.body.data);
    }
    if (Array.isArray(part.parts)) {
      part.parts.forEach(walk);
    }
  };

  // Handle messages where data is on the top-level body
  if (payload?.body?.data) {
    const decoded = decodeBase64UrlToUtf8(payload.body.data);
    if (payload.mimeType === "text/plain") text = decoded;
    else if (payload.mimeType === "text/html") html = decoded;
    else text ||= decoded;
  }

  walk(payload);

  return {
    text: text?.trim() || "",
    html: html?.trim() || "",
  };
}

// --- Persistence for Gmail history cursor ---
const STATE_FILE = "gmail_state.json";
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function saveState(obj) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("Failed to save state:", e.message);
  }
}

async function forwardMessageById(messageId) {
  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  const { text, html } = extractEmailBodies(msg.data.payload);
  const headers = msg.data.payload.headers || [];
  const from = headers.find((h) => h.name === "From")?.value;
  const subject = headers.find((h) => h.name === "Subject")?.value;
  const to =
    headers.find((h) => h.name === "To")?.value ||
    headers.find((h) => h.name === "Delivered-To")?.value;

  const emailData = {
    from,
    to,
    subject,
    body: text || (html ? stripHtml(html) : "(no text found)"),
    textBody: text || undefined,
    htmlBody: html || undefined,
  };
  // broadcast to frontend
  try { sseBroadcast("email", { source: "push", id: messageId, ...emailData }); } catch (_) {}
  // Also forward to legacy NGROK endpoint if configured
  if (process.env.NGROK_ENDPOINT) {
    await axios.post(process.env.NGROK_ENDPOINT, emailData);
  }
  // Send to Container API (schema-based)
  await postEmailToContainerAPI(emailData);
  return emailData;
}

async function processHistorySince(startHistoryId) {
  let pageToken;
  let latestHistoryId = startHistoryId;
  const added = new Set();

  do {
    const resp = await gmail.users.history.list({
      userId: "me",
      startHistoryId: String(startHistoryId),
      pageToken,
      historyTypes: ["messageAdded"],
    });

    const history = resp.data.history || [];
    history.forEach((h) => {
      latestHistoryId = h.id || latestHistoryId;
      (h.messagesAdded || []).forEach((m) => {
        if (m?.message?.id) added.add(m.message.id);
      });
    });
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  for (const id of added) {
    try {
      await forwardMessageById(id);
    } catch (e) {
      console.error("Forward failed for", id, e.response?.status || e.message);
    }
  }

  if (latestHistoryId) {
    const state = loadState();
    state.historyId = latestHistoryId;
    saveState(state);
  }

  return { count: added.size, latestHistoryId };
}

// Step 3: Fetch latest unread email and forward
app.get("/fetch", async (req, res) => {
  if (!gmail) return res.send("Not connected yet.");
  try {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread",
      maxResults: 1,
    });

    if (!list.data.messages) {
      return res.send("No new emails found.");
    }

    const messageId = list.data.messages[0].id;
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const { text, html } = extractEmailBodies(msg.data.payload);

    const headers = msg.data.payload.headers || [];
    const from = headers.find((h) => h.name === "From")?.value;
    const subject = headers.find((h) => h.name === "Subject")?.value;
    const to = headers.find((h) => h.name === "To")?.value || headers.find((h)=> h.name === "Delivered-To")?.value;

    const emailData = {
      from,
      to,
      subject,
      // Backward compatible body field (prefer text, fall back to stripped HTML)
      body: text || (html ? stripHtml(html) : "(no text found)"),
      // Rich fields for consumers that expect specific shapes
      textBody: text || undefined,
      htmlBody: html || undefined,
    };

    // push to UI
    try { sseBroadcast("email", { source: "fetch", id: messageId, ...emailData }); } catch (_) {}
    if (process.env.NGROK_ENDPOINT) {
      await axios.post(process.env.NGROK_ENDPOINT, emailData);
    }
    await postEmailToContainerAPI(emailData);
    res.send("📨 Email forwarded to ngrok endpoint.");
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error("Forwarding failed:", status || "", data || err.message);
    res.status(502).send(`Forwarding failed${status ? ` (${status})` : ""}`);
  }
});

// Public webhook endpoint for ngrok to POST into
app.post("/incoming", (req, res) => {
  try {
    const payload = req.body;
    console.log("📬 Received forwarded email:", payload);
  // push to UI if someone is listening
  try { sseBroadcast("incoming", payload); } catch (_) {}
  // respond immediately
  res.status(200).send("OK");

  // Fire-and-forget outbound POST with the forwarded payload
  const url = process.env.OUTBOUND_POST_URL;
  if (!url) {
    console.warn("OUTBOUND_POST_URL not set; skipping outbound POST.");
  } else {
    axios
      .post(url, payload, { headers: { "Content-Type": "application/json" } })
      .then(() => {
        console.log(`➡️  Outbound POST sent to ${url}`);
      })
      .catch((err) => {
        const status = err.response?.status;
        console.error("Outbound POST failed:", status || err.message);
      });
  }
  } catch (e) {
    console.error("Error handling /incoming:", e);
    res.status(400).send("Bad Request");
  }
});

// --- Container API integration (schema-based POSTs) ---
// Container API expects session creation then session-scoped query
// All routes are under /singleton prefix
const CONTAINER_CREATE_PATH = "/singleton/agent/create";
const CONTAINER_QUERY_BASE = "/singleton/agent";
// Generate a stable session id per boot
const CONTAINER_SESSION_ID = (() => {
  const rnd = Math.random().toString(16).slice(2, 10);
  return `intern-${rnd}`;
})();

async function ensureContainerSession() {
  const base = process.env.OUTBOUND_POST_URL;
  if (!base) return;
  try {
    await axios.post(
      `${base.replace(/\/$/, "")}${CONTAINER_CREATE_PATH}`,
      { sessionId: CONTAINER_SESSION_ID },
      { headers: { "Content-Type": "application/json" } }
    );
    console.log(`✅ Container session created: ${CONTAINER_SESSION_ID}`);
  } catch (err) {
    if (err.response?.status === 409) {
      console.log(`ℹ️  Container session exists: ${CONTAINER_SESSION_ID}`);
    } else {
      const status = err.response?.status;
      console.warn("Container session create failed:", status || err.message);
    }
  }
}

function buildEmailPrompt(data) {
  const from = data.from || "";
  const to = data.to || "";
  const subject = data.subject || "";
  const body = data.textBody || data.body || "";
  return `From: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${body}`.trim();
}

async function postEmailToContainerAPI(emailData) {
  const base = process.env.OUTBOUND_POST_URL;
  if (!base) return; // nothing to do if not configured
  await ensureContainerSession();
  const url = `${base.replace(/\/$/, "")}${CONTAINER_QUERY_BASE}/${encodeURIComponent(CONTAINER_SESSION_ID)}/query`;
  const payload = { prompt: buildEmailPrompt(emailData), stream: false };
  try {
    await axios.post(url, payload, { headers: { "Content-Type": "application/json" } });
    console.log(`➡️  Posted email to Container API session ${CONTAINER_SESSION_ID}`);
  } catch (err) {
    const status = err.response?.status;
    console.warn("Container query failed:", status || err.message);
  }
}

// Ensure session on boot (non-fatal)
ensureContainerSession().catch(() => {});

// Start Gmail push notifications (requires GCP Pub/Sub topic)
app.post("/watch/start", async (req, res) => {
  if (!gmail) return res.status(400).send("Not connected yet.");
  const topic = process.env.GMAIL_TOPIC;
  if (!topic) return res.status(400).send("Set GMAIL_TOPIC in .env");
  try {
    const watchResp = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: topic,
        labelFilterAction: "include",
        labelIds: ["INBOX"],
      },
    });
    const state = loadState();
    if (watchResp.data.historyId) state.historyId = watchResp.data.historyId;
    saveState(state);
    res.json(watchResp.data);
  } catch (e) {
    console.error("watch/start error:", e.response?.data || e.message);
    res.status(500).send("Failed to start watch");
  }
});

// Stop Gmail push notifications
app.post("/watch/stop", async (req, res) => {
  if (!gmail) return res.status(400).send("Not connected yet.");
  try {
    await gmail.users.stop({ userId: "me" });
    res.send("Stopped watch");
  } catch (e) {
    console.error("watch/stop error:", e.response?.data || e.message);
    res.status(500).send("Failed to stop watch");
  }
});

// Pub/Sub push endpoint – set your Pub/Sub push subscription URL to this path
app.post("/gmail/push", async (req, res) => {
  // Acknowledge immediately to avoid retries
  res.status(204).end();
  try {
    const msg = req.body?.message;
    if (!msg?.data) return;
    const dataStr = Buffer.from(msg.data, "base64").toString("utf8");
    const data = JSON.parse(dataStr);
    const historyId = data.historyId;
    if (!historyId) return;

    const state = loadState();
    const start = state.historyId || historyId;
    await processHistorySince(start);
  } catch (e) {
    console.error("/gmail/push handler error:", e.message);
  }
});

// Alias for subscriptions configured to /gmail-notify
app.post("/gmail-notify", async (req, res) => {
  res.status(204).end();
  try {
    const msg = req.body?.message;
    if (!msg?.data) return;
    const dataStr = Buffer.from(msg.data, "base64").toString("utf8");
    const data = JSON.parse(dataStr);
    const historyId = data.historyId;
    if (!historyId) return;

    const state = loadState();
    const start = state.historyId || historyId;
    await processHistorySince(start);
  } catch (e) {
    console.error("/gmail-notify handler error:", e.message);
  }
});

app.listen(port, () => console.log(`🚀 Server running at http://localhost:${port}`));
