// The page handles the camera, drawing, recording and Telegram.
// Movement, person and weapon detection and the alarm rules are Python (watch.py), run in worker.js.
const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "security-watch-settings-v1";
const TG_KEY = "security-watch-telegram-v1";
const MAX_W = 640;            // frames are analysed at most 640 px wide
const QUIET_STOP = 6000;      // stop a clip after 6 s with nothing going on
const MAX_CLIP = 60000;       // and never record more than a minute

const video = $("video"), out = $("out"), ctx = out.getContext("2d");
const grab = document.createElement("canvas"), gctx = grab.getContext("2d", { willReadFrequently: true });

let worker, ready = false, busy = false, frameId = 0;
let source = "sample", stream = null, fileUrl = null, watching = false;
let last = null;              // last result from Python
let rec = null;               // { recorder, chunks, started, lastActive, entry }
let audio = null;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

// ---- Python worker ---------------------------------------------------------------
function startWorker() {
  worker = new Worker("worker.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "loading") $("loadText").textContent = m.text;
    else if (m.type === "ready") {
      ready = true;
      $("loading").classList.add("done");
      sendSettings();
      $("startBtn").disabled = false;
    } else if (m.type === "error") {
      $("loading").classList.add("error");
      $("loadText").textContent = "Sorry, Python could not start in this browser. Try Chrome, Edge or Firefox. (" + m.text + ")";
      document.querySelector(".spinner").style.display = "none";
    } else if (m.type === "result") {
      busy = false;
      if (m.error) { console.error(m.error); return; }
      if (watching) onResult(m.result);
    }
  };
}

// ---- settings ---------------------------------------------------------------------
function readSettings() {
  return {
    armed: $("armed").value,
    open_from: $("openFrom").value || "08:00",
    open_until: $("openUntil").value || "18:00",
    weapons: $("weapons").checked,
    detector: $("detector").value,
    min_score: +$("minScore").value / 100,
    motion: +$("motion").value / 1000,
    cooldown: Math.max(0, +$("cooldown").value || 0) * 60,
  };
}
function sendSettings() {
  const s = readSettings();
  $("hoursRow").hidden = s.armed !== "hours";
  $("minScoreV").textContent = Math.round(s.min_score * 100) + "%";
  $("motionV").textContent = (s.motion * 100).toFixed(1) + "%";
  store.set(SETTINGS_KEY, { ...s, record: $("record").checked, sound: $("sound").checked });
  if (ready) worker.postMessage({ type: "config", settings: s });
}
function loadSettings() {
  const s = store.get(SETTINGS_KEY);
  if (!s) return;
  if (s.armed) $("armed").value = s.armed;
  if (s.open_from) $("openFrom").value = s.open_from;
  if (s.open_until) $("openUntil").value = s.open_until;
  $("weapons").checked = s.weapons !== false;
  if (s.detector) $("detector").value = s.detector;
  if (s.min_score) $("minScore").value = Math.round(s.min_score * 100);
  if (s.motion) $("motion").value = Math.round(s.motion * 1000);
  if (s.cooldown != null) $("cooldown").value = Math.round(s.cooldown / 60);
  $("record").checked = s.record !== false;
  $("sound").checked = s.sound !== false;
}

// ---- video sources ----------------------------------------------------------------
function setSource(s) {
  stopWatching();
  source = s;
  for (const [id, v] of [["tabSample", "sample"], ["tabCam", "cam"], ["tabFile", "file"]]) $(id).classList.toggle("active", v === s);
  const hints = {
    sample: "Press <b>Start watching</b> to play the sample: an empty room after closing time, then people walk in.",
    cam: "Press <b>Start watching</b> and allow the camera. Keep the camera still: the first seconds teach it the empty scene.",
    file: fileUrl ? "Press <b>Start watching</b> to analyse your video." : "Choose a video recorded by a still camera.",
  };
  showHint(hints[s]);
  if (s === "file" && !fileUrl) $("file").click();
}
function showHint(html) { $("hint").innerHTML = html; $("hint").hidden = !html; }

async function openSource() {
  video.srcObject = null;
  video.removeAttribute("src");
  video.innerHTML = "";
  if (source === "cam") {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    video.loop = false;
  } else if (source === "file") {
    if (!fileUrl) throw new Error("Choose a video file first.");
    video.src = fileUrl;
    video.loop = true;
  } else {
    // MP4 for Safari and phones, WebM for browsers without H.264.
    video.innerHTML = '<source src="sample/shop-after-hours.mp4" type=\'video/mp4; codecs="avc1.42E01E"\'>' +
      '<source src="sample/shop-after-hours.webm" type="video/webm">';
    video.loop = true;
    video.load();
  }
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
}

async function startWatching() {
  if (!ready || watching) return;
  $("startBtn").disabled = true;
  try {
    await openSource();
  } catch (e) {
    showHint(source === "cam" ? "Couldn't open the camera. Allow camera access, or use the sample video." : esc(e.message));
    $("startBtn").disabled = false;
    return;
  }
  const s = Math.min(1, MAX_W / video.videoWidth);
  out.width = grab.width = Math.round(video.videoWidth * s);
  out.height = grab.height = Math.round(video.videoHeight * s);
  worker.postMessage({ type: "reset" });
  last = null;
  watching = true;
  showHint("");
  $("stopBtn").disabled = false;
  setBanner("idle", "Learning the empty scene…");
  unlockAudio();
  requestAnimationFrame(loop);
}

function stopWatching() {
  if (!watching) return;
  watching = false;
  stopRecording();
  video.pause();
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  $("startBtn").disabled = !ready;
  $("stopBtn").disabled = true;
  setBanner("idle", "Not watching");
}

// ---- main loop: draw every frame, send one to Python whenever it is free ----------
function loop() {
  if (!watching) return;
  if (video.readyState >= 2) {
    gctx.drawImage(video, 0, 0, grab.width, grab.height);
    if (!busy) {
      busy = true;
      const img = gctx.getImageData(0, 0, grab.width, grab.height);
      const d = new Date();
      worker.postMessage({
        type: "frame", id: ++frameId, buffer: img.data.buffer, width: img.width, height: img.height,
        now: performance.now() / 1000, minutes: d.getHours() * 60 + d.getMinutes(),
      }, [img.data.buffer]);
    }
    ctx.drawImage(grab, 0, 0);
    drawOverlay();
  }
  if (rec && performance.now() - rec.lastActive > QUIET_STOP) stopRecording();
  if (rec && performance.now() - rec.started > MAX_CLIP) stopRecording();
  requestAnimationFrame(loop);
}

function drawOverlay() {
  const W = out.width, H = out.height, lw = Math.max(2, W / 320);
  if (last) {
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,.7)";
    for (const [x, y, w, h] of last.motion_boxes) ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.font = `bold ${Math.round(W / 40)}px system-ui, sans-serif`;
    for (const d of last.detections) {
      const [x, y, w, h] = d.box;
      const col = d.kind === "weapon" ? "#ff2d2d" : last.armed ? "#ff7b00" : "#2ea043";
      ctx.lineWidth = d.kind === "weapon" ? lw * 2 : lw;
      ctx.strokeStyle = col;
      ctx.strokeRect(x, y, w, h);
      const label = `${d.label} ${Math.round(d.score * 100)}%`;
      const tw = ctx.measureText(label).width + 8, th = W / 32;
      const ty = y > th ? y - th : y;
      ctx.fillStyle = col;
      ctx.fillRect(x, ty, tw, th);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + 4, ty + th * 0.78);
    }
  }
  // time stamp, like a CCTV recorder
  const stamp = new Date().toLocaleString() + (last ? "   " + last.status : "");
  ctx.font = `${Math.round(W / 42)}px ui-monospace, monospace`;
  const pad = W / 80, fh = W / 30;
  ctx.fillStyle = "rgba(0,0,0,.55)";
  ctx.fillRect(0, H - fh - pad, ctx.measureText(stamp).width + pad * 2, fh + pad);
  ctx.fillStyle = "#fff";
  ctx.fillText(stamp, pad, H - pad * 1.4);
  if (rec && Math.floor(performance.now() / 500) % 2) {
    ctx.fillStyle = "#ff2d2d";
    ctx.beginPath(); ctx.arc(W - pad * 5, pad * 3, pad, 0, 7); ctx.fill();
    ctx.font = `bold ${Math.round(W / 36)}px system-ui, sans-serif`;
    ctx.fillText("REC", W - pad * 3.4, pad * 3 + W / 100);
  }
}

// ---- results and alarms ---------------------------------------------------------
function setBanner(cls, text) { const b = $("banner"); b.className = "banner " + cls; b.textContent = text; }

function onResult(r) {
  last = r;
  $("sMotion").textContent = (r.motion * 100).toFixed(1) + "%";
  $("sPeople").textContent = r.people;
  $("sArmed").textContent = r.armed ? "on" : "off";
  $("sMs").textContent = r.detected ? r.ms + " ms" : $("sMs").textContent;
  const alarm = r.weapons || (r.people && r.armed);
  setBanner(alarm ? "bad" : r.people ? "ok" : r.moving ? "warn" : "idle",
    (alarm ? "🚨 " : r.people ? "🧍 " : r.moving ? "👀 " : "✅ ") + r.status);
  if (rec && (r.people || r.weapons || r.moving)) rec.lastActive = performance.now();
  for (const a of r.alerts) raiseAlarm(a);
}

function raiseAlarm(a) {
  ctx.drawImage(grab, 0, 0); drawOverlay();
  const snap = out.toDataURL("image/jpeg", 0.85);
  const entry = { time: new Date(), text: a.text, kind: a.kind, snap, el: null };
  addLogEntry(entry);
  if ($("sound").checked) siren();
  if ($("record").checked && !rec) startRecording(entry);
  sendTelegramAlarm(entry);
}

function addLogEntry(e) {
  const el = document.createElement("div");
  el.className = "entry " + e.kind;
  el.innerHTML = `<img src="${e.snap}" alt="Snapshot of the alarm">
    <div class="info"><b>${esc(e.text)}</b><div class="small">${esc(e.time.toLocaleString())}</div>
    <div class="clip small">${$("record").checked ? (rec ? "Included in the clip of the alarm before" : "Recording…") : "Clip recording is off"}</div>
    <div class="tg small"></div></div>`;
  e.el = el;
  $("log").prepend(el);
  $("logEmpty").hidden = true;
}

// ---- video saving (MediaRecorder on the annotated canvas) -------------------------
function pickType() {
  for (const t of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}
function startRecording(entry) {
  const type = pickType();
  if (!type || !out.captureStream) { entry.el.querySelector(".clip").textContent = "This browser can't record clips"; return; }
  const recorder = new MediaRecorder(out.captureStream(15), { mimeType: type, videoBitsPerSecond: 1_500_000 });
  rec = { recorder, chunks: [], started: performance.now(), lastActive: performance.now(), entry, type };
  const r = rec;
  recorder.onstop = () => finishClip(r);
  recorder.ondataavailable = (ev) => { if (ev.data.size) r.chunks.push(ev.data); };
  recorder.start(1000);
}
function stopRecording() {
  if (!rec) return;
  const r = rec;
  rec = null;
  if (r.recorder.state !== "inactive") r.recorder.stop();
}
function finishClip(r) {
  const blob = new Blob(r.chunks, { type: r.type.split(";")[0] });
  const ext = r.type.includes("mp4") ? "mp4" : "webm";
  const name = "alarm-" + r.entry.time.toISOString().slice(0, 19).replace(/[:T]/g, "-") + "." + ext;
  const url = URL.createObjectURL(blob);
  const secs = Math.round((performance.now() - r.started) / 1000);
  r.entry.el.querySelector(".clip").innerHTML =
    `<video src="${url}" controls playsinline muted></video><a href="${url}" download="${name}">⬇️ Download clip (${secs} s)</a>`;
  if ($("tgOn").checked && $("tgClip").checked) sendTelegramClip(r.entry, blob, name);
}

// ---- siren (Web Audio, no sound file needed) ---------------------------------------
function unlockAudio() {
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) { audio = null; }
}
function siren() {
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
  o.type = "square";
  for (let i = 0; i < 6; i++) o.frequency.setValueAtTime(i % 2 ? 660 : 880, t + i * 0.25);
  g.gain.setValueAtTime(0.08, t);
  g.gain.setValueAtTime(0, t + 1.5);
  o.connect(g).connect(audio.destination);
  o.start(t); o.stop(t + 1.5);
}

// ---- Telegram -------------------------------------------------------------------------
function tgConfig() { return { token: $("tgToken").value.trim(), chat: $("tgChat").value.trim() }; }
async function tg(method, body) {
  const { token } = tgConfig();
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error("That doesn't look like a bot token (it has a number, a colon, then letters).");
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body });
  const j = await r.json().catch(() => ({ ok: false, description: "HTTP " + r.status }));
  if (!j.ok) throw new Error(j.description || "Telegram said no");
  return j.result;
}
function saveTg() {
  const c = tgConfig();
  store.set(TG_KEY, { ...c, on: $("tgOn").checked, clip: $("tgClip").checked });
}
function tgStatus(t, bad) { $("tgStatus").textContent = t; $("tgStatus").className = "small " + (bad ? "bad-text" : "ok-text"); }

async function findChat() {
  try {
    tgStatus("Asking Telegram…");
    const ups = await tg("getUpdates", new URLSearchParams({ limit: "50" }));
    const msgs = ups.map((u) => u.message || u.channel_post || u.my_chat_member).filter((m) => m && m.chat);
    if (!msgs.length) { tgStatus("No messages found. Send your bot a message in Telegram first, then try again.", true); return; }
    const chat = msgs[msgs.length - 1].chat;
    $("tgChat").value = chat.id;
    $("tgOn").checked = true;
    saveTg();
    tgStatus(`Found the chat with ${chat.first_name || chat.title || chat.username || "you"}. Press Send test.`);
  } catch (e) { tgStatus(e.message, true); }
}
async function sendTest() {
  try {
    if (!tgConfig().chat) throw new Error("Fill in the chat ID first (press Find my chat).");
    await tg("sendMessage", new URLSearchParams({ chat_id: tgConfig().chat, text: "✅ Security Watch is connected. Alarms will arrive here." }));
    tgStatus("Sent! Check Telegram.");
  } catch (e) { tgStatus(e.message, true); }
}
async function sendTelegramAlarm(entry) {
  if (!$("tgOn").checked || !tgConfig().chat) return;
  const box = entry.el.querySelector(".tg");
  try {
    const fd = new FormData();
    fd.append("chat_id", tgConfig().chat);
    fd.append("caption", `${entry.text}\n${entry.time.toLocaleString()}`);
    fd.append("photo", await (await fetch(entry.snap)).blob(), "alarm.jpg");
    await tg("sendPhoto", fd);
    box.textContent = "📨 Sent to Telegram";
  } catch (e) { box.textContent = "Telegram: " + e.message; }
}
async function sendTelegramClip(entry, blob, name) {
  const box = entry.el.querySelector(".tg");
  try {
    const fd = new FormData();
    fd.append("chat_id", tgConfig().chat);
    fd.append("caption", "🎥 Clip of: " + entry.text);
    fd.append("document", blob, name);
    await tg("sendDocument", fd);
    box.textContent = "📨 Snapshot and clip sent to Telegram";
  } catch (e) { box.textContent = "Telegram clip: " + e.message; }
}

// ---- wiring -------------------------------------------------------------------------
$("tabSample").onclick = () => setSource("sample");
$("tabCam").onclick = () => setSource("cam");
$("tabFile").onclick = () => { if (source === "file") $("file").click(); else setSource("file"); };
$("file").onchange = () => {
  const f = $("file").files[0];
  if (!f) return;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = URL.createObjectURL(f);
  setSource("file");
};
$("startBtn").onclick = startWatching;
$("stopBtn").onclick = stopWatching;
for (const id of ["armed", "openFrom", "openUntil", "weapons", "detector", "minScore", "motion", "cooldown", "record", "sound"]) {
  $(id).addEventListener("input", sendSettings);
}
$("clearLog").onclick = () => { $("log").innerHTML = ""; $("logEmpty").hidden = false; };
$("tgFind").onclick = findChat;
$("tgTest").onclick = sendTest;
$("tgForget").onclick = () => { $("tgToken").value = $("tgChat").value = ""; $("tgOn").checked = false; store.del(TG_KEY); tgStatus("Forgotten."); };
for (const id of ["tgToken", "tgChat", "tgOn", "tgClip"]) $(id).addEventListener("change", saveTg);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && watching && source !== "cam") video.pause();
  else if (!document.hidden && watching) video.play().catch(() => {});
});

loadSettings();
const t = store.get(TG_KEY);
if (t) { $("tgToken").value = t.token || ""; $("tgChat").value = t.chat || ""; $("tgOn").checked = !!t.on; $("tgClip").checked = t.clip !== false; }
sendSettings();
startWorker();
