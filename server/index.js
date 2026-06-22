const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8742;
const DATA_FILE = path.join(__dirname, "data.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

let events = [];
let sessions = [];
let currentSession = null;

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const data = JSON.parse(raw);
      events = data.events || [];
      sessions = data.sessions || [];
    }
  } catch (e) {
    console.error("Failed to load data:", e.message);
  }
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ events, sessions }, null, 2));
  } catch (e) {
    console.error("Failed to save data:", e.message);
  }
}

load();

app.post("/api/event", (req, res) => {
  const ev = req.body;
  if (!ev || !ev.type) {
    return res.status(400).json({ error: "Missing type" });
  }

  ev.received = new Date().toISOString();
  ev.sent = ev.sent || ev.received;

  if (ev.type === "start") {
    currentSession = {
      id: sessions.length + 1,
      started: ev.received,
      events: [],
      alerts: 0,
      tremors: 0,
      maxBpm: 0,
      minBpm: 999
    };
  }

  if (currentSession) {
    if (ev.type === "alert") currentSession.alerts++;
    if (ev.type === "tremor" && ev.trmDet === 1) currentSession.tremors++;
    if (ev.bpm) {
      if (ev.bpm > currentSession.maxBpm) currentSession.maxBpm = ev.bpm;
      if (ev.bpm < currentSession.minBpm) currentSession.minBpm = ev.bpm;
    }
    if (ev.type === "stop") {
      currentSession.ended = ev.received;
      sessions.push(currentSession);
      currentSession = null;
    }
  }

  events.push(ev);
  if (events.length > 10000) events = events.slice(-8000);

  save();

  io.emit("event", ev);
  if (currentSession) {
    io.emit("session", currentSession);
  }

  res.json({ ok: true, total: events.length });
});

app.post("/api/batch", (req, res) => {
  const batch = req.body;
  if (!Array.isArray(batch)) {
    return res.status(400).json({ error: "Expected array of events" });
  }

  let added = 0;
  const now = new Date().toISOString();
  for (const ev of batch) {
    if (!ev || !ev.type) continue;
    ev.received = now;
    ev.sent = ev.sent || now;

    if (ev.type === "start") {
      currentSession = {
        id: sessions.length + 1,
        started: now,
        events: [],
        alerts: 0,
        tremors: 0,
        maxBpm: 0,
        minBpm: 999
      };
    }
    if (currentSession) {
      if (ev.type === "alert") currentSession.alerts++;
      if (ev.type === "tremor" && ev.trmDet === 1) currentSession.tremors++;
      if (ev.bpm) {
        if (ev.bpm > currentSession.maxBpm) currentSession.maxBpm = ev.bpm;
        if (ev.bpm < currentSession.minBpm) currentSession.minBpm = ev.bpm;
      }
      if (ev.type === "stop") {
        currentSession.ended = now;
        sessions.push(currentSession);
        currentSession = null;
      }
    }

    events.push(ev);
    added++;
  }

  if (events.length > 10000) events = events.slice(-8000);
  save();
  io.emit("batch", batch);
  if (currentSession) io.emit("session", currentSession);

  res.json({ ok: true, added, total: events.length });
});

app.get("/api/events", (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  const since = parseInt(req.query.since) || 0;
  let filtered = events;
  if (since > 0) {
    filtered = events.filter(e => e.i > since);
  }
  res.json(filtered.slice(-limit));
});

app.get("/api/sessions", (req, res) => {
  res.json(sessions.slice(-50));
});

app.get("/api/report/csv", (req, res) => {
  const sessionId = parseInt(req.query.session);
  let data = events;
  if (sessionId && sessions[sessionId - 1]) {
    const s = sessions[sessionId - 1];
    data = events.filter(e =>
      e.received >= s.started && (!s.ended || e.received <= s.ended)
    );
  }

  const header = "idx,time,type,bpm,conf,spike,trmDet,trmLvl,trmTicks,alert,received\n";
  const rows = data.map(e =>
    [
      e.i || "",
      e.t || e.sent || "",
      e.type || "",
      e.bpm || "",
      e.conf || "",
      e.spike || "",
      e.trmDet !== undefined ? (e.trmDet ? 1 : 0) : "",
      e.trmLvl !== undefined ? e.trmLvl : "",
      e.trmTicks !== undefined ? e.trmTicks : "",
      e.alert !== undefined ? (e.alert ? 1 : 0) : "",
      e.received || ""
    ].join(",")
  ).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=ptsdnight-report.csv");
  res.send(header + rows);
});

app.get("/api/report/summary", (req, res) => {
  const alertEvents = events.filter(e => e.type === "alert");
  const spikeEvents = events.filter(e => e.type === "alert" && e.reason && e.reason.includes("spike"));
  const maxEvents = events.filter(e => e.type === "alert" && e.reason === "max");
  const bpmEvents = events.filter(e => e.type === "bpm" && e.bpm);
  const bpmValues = bpmEvents.map(e => e.bpm);

  let avgBpm = 0, peakBpm = 0, lowBpm = 0;
  if (bpmValues.length > 0) {
    avgBpm = Math.round(bpmValues.reduce((a, b) => a + b, 0) / bpmValues.length);
    peakBpm = Math.max(...bpmValues);
    lowBpm = Math.min(...bpmValues);
  }

  const lastAlert = alertEvents.length > 0 ? alertEvents[alertEvents.length - 1].received : null;
  const lastBpm = bpmEvents.length > 0 ? bpmEvents[bpmEvents.length - 1].bpm : null;

  res.json({
    totalEvents: events.length,
    totalAlerts: alertEvents.length,
    spikeAlerts: spikeEvents.length,
    maxAlerts: maxEvents.length,
    tremorEvents: events.filter(e => e.type === "tremor" && e.trmDet === 1).length,
    sessions: sessions.length,
    avgBpm,
    peakBpm,
    lowBpm,
    lastBpm,
    lastAlert,
    currentSession: currentSession || null
  });
});

app.get("/api/status", (req, res) => {
  const recent = events.slice(-20);
  let lastBpmEvent = null;
  let lastAlert = null;
  let lastTremor = null;
  let alertState = false;
  let alertResolved = false;

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!lastBpmEvent && e.type === "bpm") lastBpmEvent = e;
    if (!lastTremor && e.type === "tremor") lastTremor = e;

    if (!alertResolved && (e.type === "alert" || e.type === "recovery")) {
      if (e.type === "alert") {
        alertState = true;
        lastAlert = e;
      }
      alertResolved = true;
    }

    if (lastBpmEvent && lastTremor && alertResolved) break;
  }

  res.json({
    bpm: lastBpmEvent ? lastBpmEvent.bpm : null,
    conf: lastBpmEvent ? lastBpmEvent.conf : null,
    alert: alertState,
    lastAlert: lastAlert || null,
    tremorDetected: lastTremor ? lastTremor.trmDet === 1 : false,
    tremorLevel: lastTremor ? lastTremor.trmLvl : 0,
    totalEvents: events.length,
    currentSession: currentSession || null,
    recent: recent
  });
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  const recent = events.slice(-30);
  socket.emit("history", recent);
  if (currentSession) socket.emit("session", currentSession);
  socket.emit("sessions", sessions.slice(-10));

  socket.on("forward", (ev) => {
    if (!ev || !ev.type) return;
    ev.received = new Date().toISOString();
    events.push(ev);
    if (events.length > 10000) events = events.slice(-8000);
    save();
    io.emit("event", ev);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

process.on("SIGINT", () => { save(); process.exit(0); });
process.on("SIGTERM", () => { save(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`PTSD Night Watch server running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in Chrome/Edge to use Web Bluetooth bridge`);
  console.log(`POST events to http://localhost:${PORT}/api/event`);
  console.log(`GET  report at http://localhost:${PORT}/api/report/csv`);
});
