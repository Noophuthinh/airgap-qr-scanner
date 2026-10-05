/**
 * Air-Gap QR Receiver (protocol v2)
 * - Base45 / alphanumeric QR frames, order independent (GF(2) fountain decoding)
 * - Hardware BarcodeDetector when available, otherwise jsQR on a downscaled frame
 * - Instant MD5 lookup link from the first META frame, live KB/s meter
 */

const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const B45_MAP = {};
for (let i = 0; i < B45.length; i++) B45_MAP[B45[i]] = i;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const engineBadge = $("engineBadge");
const valFileName = $("valFileName");
const valProgress = $("valProgress");
const valOrigSize = $("valOrigSize");
const valFps = $("valFps");
const valSpeed = $("valSpeed");
const valReceivedBytes = $("valReceivedBytes");
const progressBar = $("progressBar");
const missingChunksBox = $("missingChunksBox");
const missingChunksList = $("missingChunksList");
const resultCard = $("resultCard");
const hashVerificationText = $("hashVerificationText");
const valTransferSummary = $("valTransferSummary");
const btnDownload = $("btnDownload");
const btnManualVT = $("btnManualVT");
const btnSwitchCam = $("btnSwitchCam");
const btnPauseCam = $("btnPauseCam");
const btnResetScan = $("btnResetScan");

const vtInstantCard = $("vtInstantCard");
const vtInstantBadge = $("vtInstantBadge");
const valMd5Hash = $("valMd5Hash");
const vtInstantCircle = $("vtInstantCircle");
const vtInstantVerdict = $("vtInstantVerdict");
const vtInstantSummary = $("vtInstantSummary");
const btnVtDirectLink = $("btnVtDirectLink");
const vtInstantEngineList = $("vtInstantEngineList");

const vtBox = $("vtBox");
const vtBadge = $("vtBadge");
const scoreCircle = $("scoreCircle");
const vtVerdict = $("vtVerdict");
const vtSummary = $("vtSummary");
const vtEngineList = $("vtEngineList");

const btnSettings = $("btnSettings");
const settingsModal = $("settingsModal");
const apiKeyInput = $("apiKeyInput");
const btnSaveKey = $("btnSaveKey");
const btnCloseModal = $("btnCloseModal");

let vtApiKey = localStorage.getItem("vt_api_key") || "";
apiKeyInput.value = vtApiKey;

// ---------- Receiver state ----------
let session = null; // {id,k,size,words,pivots,seen,rank,meta,done}
let assembledBlob = null;
let assembledSha256 = null;
let fileName = "file";

let transferStartTime = null;
let totalReceivedBytes = 0;
let bytesSinceCalc = 0;
let lastSpeedCalc = performance.now();
let instantVtChecked = false;

// ---------- Camera / scanner ----------
let videoStream = null;
let currentFacingMode = "environment";
let barcodeDetector = null;
let isPaused = false;
let busy = false;
let frameCount = 0;
let lastFpsTime = performance.now();

async function initScanner() {
  if ("BarcodeDetector" in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
        engineBadge.innerText = "Engine: Hardware BarcodeDetector";
      }
    } catch (e) {
      console.warn("BarcodeDetector error:", e);
    }
  }
  if (!barcodeDetector) engineBadge.innerText = "Engine: jsQR (software)";
  await startCamera(currentFacingMode);
  requestAnimationFrame(scanLoop);
}

async function startCamera(facingMode) {
  if (videoStream) videoStream.getTracks().forEach((t) => t.stop());
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    video.srcObject = videoStream;
    await video.play();
    try {
      const track = videoStream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const adv = {};
      if (caps.focusMode && caps.focusMode.includes("continuous")) adv.focusMode = "continuous";
      if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
    } catch (e) {
      /* best effort */
    }
  } catch (err) {
    alert("Không thể truy cập Camera: " + err.message);
  }
}

async function scanLoop() {
  requestAnimationFrame(scanLoop);
  if (isPaused || busy || video.readyState !== video.HAVE_ENOUGH_DATA) return;
  busy = true;
  try {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
      valFps.innerText = `${frameCount} FPS`;
      frameCount = 0;
      lastFpsTime = now;
    }
    updateSpeedMeter(now);

    let decoded = false;
    if (barcodeDetector) {
      try {
        const codes = await barcodeDetector.detect(video);
        for (const c of codes) handleRawData(c.rawValue);
        decoded = true;
      } catch (e) {
        decoded = false;
      }
    }
    if (!decoded) scanWithJsQR();
  } finally {
    busy = false;
  }
}

function scanWithJsQR() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(1, 960 / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
  if (code && code.data) handleRawData(code.data);
}

// ---------- Protocol v2 decoding ----------
function b45decode(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i + 2 < n) {
    const v = B45_MAP[text[i]] + B45_MAP[text[i + 1]] * 45 + B45_MAP[text[i + 2]] * 2025;
    out.push(v >> 8, v & 255);
    i += 3;
  }
  if (i + 1 < n) out.push(B45_MAP[text[i]] + B45_MAP[text[i + 1]] * 45);
  return Uint8Array.from(out);
}

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function maskFor(idx, k, words) {
  const m = new Uint32Array(words);
  if (idx < k) {
    m[idx >>> 5] |= 1 << (idx & 31);
    return m;
  }
  const rng = mulberry32((Math.imul(idx, 0x9e3779b1) + k) | 0);
  let any = false;
  for (let j = 0; j < k; j++) {
    if ((rng() >>> 31) & 1) {
      m[j >>> 5] |= 1 << (j & 31);
      any = true;
    }
  }
  if (!any) {
    const j = idx % k;
    m[j >>> 5] |= 1 << (j & 31);
  }
  return m;
}

function lowBit(m) {
  for (let w = 0; w < m.length; w++) {
    const v = m[w];
    if (v !== 0) return (w << 5) + (31 - Math.clz32(v & -v));
  }
  return -1;
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

function newSession(id, k) {
  resetUi();
  session = {
    id,
    k,
    size: 0,
    words: (k + 31) >>> 5,
    pivots: new Array(k).fill(null),
    seen: new Set(),
    rank: 0,
    frames: 0,
    meta: null,
    done: false,
  };
}

function handleRawData(text) {
  if (!text || assembledBlob && session && session.done) return;
  if (text.startsWith("Q2M:")) return handleMeta(text);
  if (text.startsWith("Q2:")) return handleData(text);
}

function handleMeta(text) {
  const p = text.split(":");
  if (p.length < 9) return;
  const id = p[1];
  const k = parseInt(p[2], 16);
  if (!session || session.id !== id) newSession(id, k);
  if (session.meta) return;
  let name = "file";
  try {
    name = new TextDecoder().decode(b45decode(p.slice(8).join(":")));
  } catch (e) {}
  session.meta = {
    len: parseInt(p[3], 16),
    orig: parseInt(p[4], 16),
    z: p[5] === "1",
    md5: p[6],
    sha32: p[7].toLowerCase(),
    name,
  };
  fileName = name;
  valFileName.innerText = name;
  valOrigSize.innerText = formatBytes(session.meta.orig);
  triggerInstantMd5Check(session.meta.md5.toLowerCase());
  updateProgressUI();
  tryFinish();
}

function handleData(text) {
  const p = text.split(":");
  if (p.length < 5) return;
  const id = p[1];
  const k = parseInt(p[2], 16);
  const idx = parseInt(p[3], 16);
  if (!session || session.id !== id) newSession(id, k);
  if (session.done || session.seen.has(idx)) return;
  let block;
  try {
    block = b45decode(p.slice(4).join(":"));
  } catch (e) {
    return;
  }
  if (!session.size) session.size = block.length;
  if (block.length !== session.size) return;
  session.seen.add(idx);
  session.frames++;
  if (!transferStartTime) {
    transferStartTime = performance.now();
    lastSpeedCalc = transferStartTime;
  }

  let mask = maskFor(idx, session.k, session.words);
  let val = block;
  for (;;) {
    const low = lowBit(mask);
    if (low < 0) break; // redundant frame
    const piv = session.pivots[low];
    if (!piv) {
      session.pivots[low] = { mask, val: Uint8Array.from(val) };
      session.rank++;
      totalReceivedBytes += session.size;
      bytesSinceCalc += session.size;
      break;
    }
    if (val === block) val = Uint8Array.from(block);
    xorInto(mask, piv.mask);
    xorInto(val, piv.val);
  }
  updateProgressUI();
  tryFinish();
}

function updateProgressUI() {
  if (!session) return;
  const k = session.k;
  const pct = Math.floor((session.rank / k) * 100);
  valProgress.innerText = `${pct}% (${session.rank}/${k})`;
  progressBar.style.width = `${pct}%`;
  valReceivedBytes.innerText = formatBytes(totalReceivedBytes);
  missingChunksBox.style.display = "block";
  missingChunksList.innerText = `Đã quét ${session.frames} khung, còn thiếu ${k - session.rank} (khung nào cũng được, không cần đúng thứ tự)`;
}

function updateSpeedMeter(now) {
  const dt = (now - lastSpeedCalc) / 1000;
  if (dt >= 0.5) {
    if (transferStartTime && session && !session.done) {
      valSpeed.innerText = `${(bytesSinceCalc / 1024 / dt).toFixed(1)} KB/s`;
    }
    bytesSinceCalc = 0;
    lastSpeedCalc = now;
  }
}

async function tryFinish() {
  if (!session || session.done || !session.meta || session.rank < session.k) return;
  session.done = true;
  if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);

  // back substitution
  const k = session.k;
  const size = session.size;
  const sol = new Array(k);
  for (let c = k - 1; c >= 0; c--) {
    const piv = session.pivots[c];
    const val = Uint8Array.from(piv.val);
    for (let d = c + 1; d < k; d++) {
      if ((piv.mask[d >>> 5] >>> (d & 31)) & 1) xorInto(val, sol[d]);
    }
    sol[c] = val;
  }
  const all = new Uint8Array(k * size);
  for (let c = 0; c < k; c++) all.set(sol[c], c * size);
  let data = all.subarray(0, session.meta.len);

  if (session.meta.z) {
    try {
      data = pako.inflate(data);
    } catch (e) {
      hashVerificationText.innerText = "Lỗi giải nén dữ liệu: " + e.message;
      hashVerificationText.style.color = "var(--danger)";
      resultCard.style.display = "flex";
      return;
    }
  }

  const digest = await crypto.subtle.digest("SHA-256", data);
  assembledSha256 = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const ok = assembledSha256.startsWith(session.meta.sha32) && data.length === session.meta.orig;
  assembledBlob = new Blob([data], { type: "application/octet-stream" });

  hashVerificationText.innerText = ok
    ? `Toàn vẹn OK (SHA-256 ${assembledSha256.slice(0, 12)}…) | MD5 ${session.meta.md5}`
    : "CẢNH BÁO: mã băm không khớp, dữ liệu có thể bị lỗi!";
  hashVerificationText.style.color = ok ? "var(--success)" : "var(--danger)";

  const sec = Math.max(0.05, (performance.now() - transferStartTime) / 1000);
  const kbps = session.meta.len / 1024 / sec;
  valSpeed.innerText = `${kbps.toFixed(1)} KB/s (Hoàn tất)`;
  valTransferSummary.innerText = `⏱️ ${sec.toFixed(1)}s | TB: ${kbps.toFixed(1)} KB/s (${(kbps * 8).toFixed(0)} Kbps) | ${session.frames} khung`;
  progressBar.style.width = "100%";
  valProgress.innerText = `100% (${k}/${k})`;
  resultCard.style.display = "flex";

  if (vtApiKey) performVirusTotalScan(assembledSha256, assembledBlob);
  else vtBox.style.display = "none";
}

function resetUi() {
  assembledBlob = null;
  assembledSha256 = null;
  transferStartTime = null;
  totalReceivedBytes = 0;
  bytesSinceCalc = 0;
  instantVtChecked = false;
  resultCard.style.display = "none";
  vtInstantCard.style.display = "none";
  valFileName.innerText = "Đang nhận...";
  valProgress.innerText = "0%";
  progressBar.style.width = "0%";
  valSpeed.innerText = "0.0 KB/s";
  valReceivedBytes.innerText = "0 KB";
  valTransferSummary.innerText = "";
  missingChunksBox.style.display = "none";
}

// ---------- Instant MD5 lookup ----------
function triggerInstantMd5Check(md5) {
  if (!md5 || instantVtChecked) return;
  instantVtChecked = true;
  vtInstantCard.style.display = "flex";
  valMd5Hash.innerText = md5;
  btnVtDirectLink.href = `https://www.virustotal.com/gui/file/${md5}`;
  vtInstantEngineList.style.display = "none";
  vtInstantEngineList.innerHTML = "";

  if (!vtApiKey) {
    vtInstantBadge.className = "vt-badge clean";
    vtInstantBadge.innerText = "Sẵn Sàng Tra Cứu";
    vtInstantCircle.className = "score-circle clean";
    vtInstantCircle.innerText = "VT";
    vtInstantVerdict.innerText = "Đã bắt được MD5 của file!";
    vtInstantSummary.innerText = "Bấm nút bên dưới để xem kết quả VirusTotal miễn phí (không cần API).";
    return;
  }
  vtInstantBadge.className = "vt-badge";
  vtInstantBadge.innerText = "Đang tra cứu API...";
  vtInstantCircle.className = "score-circle";
  vtInstantCircle.innerText = "...";
  vtInstantVerdict.innerText = "Đang kiểm tra MD5 trên VirusTotal...";
  vtInstantSummary.innerText = `MD5: ${md5}`;
  fetch(`/api/vt/check_hash?hash=${md5}`, { headers: { "x-apikey": vtApiKey } })
    .then(async (resp) => {
      if (resp.status === 200) {
        displayVtStats((await resp.json()).data.attributes, true);
      } else if (resp.status === 404) {
        vtInstantBadge.innerText = "Chưa có trên VT";
        vtInstantCircle.innerText = "NEW";
        vtInstantVerdict.innerText = "MD5 chưa từng được phân tích";
        vtInstantSummary.innerText = "Đang tiếp tục nhận file...";
      } else {
        vtInstantBadge.innerText = resp.status === 429 ? "Rate limit (429)" : "Tra cứu web";
        vtInstantVerdict.innerText = "Đã nhận MD5";
        vtInstantSummary.innerText = "Bấm nút bên dưới để mở VirusTotal.";
      }
    })
    .catch(() => {
      vtInstantBadge.innerText = "Tra cứu web";
      vtInstantVerdict.innerText = "Đã nhận MD5";
      vtInstantSummary.innerText = "Bấm nút bên dưới để mở VirusTotal.";
    });
}

function displayVtStats(attributes, instant) {
  const el = instant
    ? { badge: vtInstantBadge, circle: vtInstantCircle, verdict: vtInstantVerdict, summary: vtInstantSummary, list: vtInstantEngineList }
    : { badge: vtBadge, circle: scoreCircle, verdict: vtVerdict, summary: vtSummary, list: vtEngineList };
  const s = attributes.last_analysis_stats || {};
  const mal = s.malicious || 0;
  const total = mal + (s.suspicious || 0) + (s.harmless || 0) + (s.undetected || 0);
  el.circle.innerText = `${mal}/${total}`;
  if (mal > 0) {
    el.badge.className = "vt-badge malicious";
    el.badge.innerText = "CẢNH BÁO MÃ ĐỘC";
    el.circle.className = "score-circle malicious";
    el.verdict.innerText = `Phát hiện ${mal} cảnh báo nguy hiểm!`;
    el.summary.innerText = "File có dấu hiệu độc hại theo các hãng bảo mật.";
  } else {
    el.badge.className = "vt-badge clean";
    el.badge.innerText = "AN TOÀN (CLEAN)";
    el.circle.className = "score-circle clean";
    el.verdict.innerText = "Không có engine nào phát hiện mối đe dọa";
    el.summary.innerText = `0/${total} engine cảnh báo.`;
  }
  const results = Object.entries(attributes.last_analysis_results || {}).filter(
    ([, r]) => r.category === "malicious" || r.category === "suspicious"
  );
  el.list.innerHTML = "";
  if (results.length) {
    el.list.style.display = "flex";
    for (const [name, r] of results) {
      const item = document.createElement("div");
      item.className = "engine-item malicious";
      item.innerHTML = `<strong>${name}</strong> <span>${r.result || r.category}</span>`;
      el.list.appendChild(item);
    }
  }
}

// ---------- Full-file VirusTotal ----------
async function performVirusTotalScan(sha256, blob) {
  vtBox.style.display = "flex";
  vtBadge.className = "vt-badge";
  vtBadge.innerText = "Đang tra cứu...";
  scoreCircle.className = "score-circle";
  scoreCircle.innerText = "...";
  vtVerdict.innerText = "Đang kiểm tra VirusTotal...";
  vtSummary.innerText = `SHA-256: ${sha256.substring(0, 16)}...`;
  vtEngineList.style.display = "none";
  if (!vtApiKey) {
    vtBadge.innerText = "Thiếu API Key";
    vtVerdict.innerText = "Chưa nhập API Key";
    vtSummary.innerText = "Nhấn ⚙️ để nhập khóa (tùy chọn) hoặc dùng nút xem báo cáo miễn phí.";
    return;
  }
  try {
    const resp = await fetch(`/api/vt/check_hash?hash=${sha256}`, { headers: { "x-apikey": vtApiKey } });
    if (resp.status === 200) return displayVtStats((await resp.json()).data.attributes, false);
    if (resp.status === 404) {
      vtVerdict.innerText = "File mới, đang tải lên VirusTotal...";
      return uploadFileToVirusTotal(blob);
    }
    vtBadge.innerText = resp.status === 429 ? "Giới hạn (429)" : "Lỗi API";
    vtVerdict.innerText = resp.status === 429 ? "Đạt giới hạn API miễn phí (4 req/phút)" : "Không thể kiểm tra";
    vtSummary.innerText = "Thử lại sau ít phút.";
  } catch (err) {
    vtBadge.innerText = "Lỗi kết nối";
    vtVerdict.innerText = "Lỗi kết nối tới VirusTotal";
    vtSummary.innerText = err.message;
  }
}

async function uploadFileToVirusTotal(blob) {
  try {
    const fd = new FormData();
    fd.append("file", blob, fileName);
    const r = await fetch("/api/vt/upload", { method: "POST", headers: { "x-apikey": vtApiKey }, body: fd });
    if (r.ok) {
      const res = await r.json();
      vtBadge.innerText = "Đang phân tích";
      vtVerdict.innerText = "Đã tải file lên!";
      vtSummary.innerText = `Analysis ID: ${res.data.id.substring(0, 10)}... Đợi ~30s rồi bấm "Quét lại VirusTotal".`;
    } else {
      vtVerdict.innerText = "Upload thất bại";
      vtSummary.innerText = `HTTP ${r.status}`;
    }
  } catch (e) {
    vtVerdict.innerText = "Lỗi khi upload";
    vtSummary.innerText = e.message;
  }
}

// ---------- UI events ----------
btnDownload.addEventListener("click", () => {
  if (!assembledBlob) return;
  const url = URL.createObjectURL(assembledBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

btnManualVT.addEventListener("click", () => {
  if (assembledSha256 && assembledBlob) performVirusTotalScan(assembledSha256, assembledBlob);
});

btnSwitchCam.addEventListener("click", () => {
  currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
  startCamera(currentFacingMode);
});

btnPauseCam.addEventListener("click", () => {
  isPaused = !isPaused;
  btnPauseCam.innerText = isPaused ? "▶️ Tiếp tục" : "⏸️ Tạm dừng";
});

btnResetScan.addEventListener("click", () => {
  session = null;
  resetUi();
  valFileName.innerText = "Chờ quét mã...";
});

btnSettings.addEventListener("click", () => {
  apiKeyInput.value = vtApiKey;
  settingsModal.style.display = "flex";
});
btnCloseModal.addEventListener("click", () => (settingsModal.style.display = "none"));
btnSaveKey.addEventListener("click", () => {
  vtApiKey = apiKeyInput.value.trim();
  localStorage.setItem("vt_api_key", vtApiKey);
  settingsModal.style.display = "none";
  if (assembledSha256 && assembledBlob) performVirusTotalScan(assembledSha256, assembledBlob);
});

function formatBytes(bytes) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

window.addEventListener("DOMContentLoaded", initScanner);
