/**
 * Air-Gap QR Mobile Receiver & VirusTotal Integration
 * High-speed optical data reassembly with hardware BarcodeDetector and jsQR fallback.
 */

// State Management
let currentFileId = null;
let fileName = null;
let totalChunks = 0;
let origSize = 0;
let origSha256 = null;
let receivedChunks = new Map(); // chunkIdx -> Uint8Array
let isCompleted = false;
let assembledBlob = null;

// Camera & Scanner State
let videoStream = null;
let currentFacingMode = "environment";
let barcodeDetector = null;
let isPaused = false;
let frameCount = 0;
let lastFpsTime = performance.now();

// DOM Elements
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const engineBadge = document.getElementById("engineBadge");
const valFileName = document.getElementById("valFileName");
const valProgress = document.getElementById("valProgress");
const valOrigSize = document.getElementById("valOrigSize");
const valFps = document.getElementById("valFps");
const progressBar = document.getElementById("progressBar");
const missingChunksBox = document.getElementById("missingChunksBox");
const missingChunksList = document.getElementById("missingChunksList");

const resultCard = document.getElementById("resultCard");
const hashVerificationText = document.getElementById("hashVerificationText");
const btnDownload = document.getElementById("btnDownload");
const btnManualVT = document.getElementById("btnManualVT");
const btnSwitchCam = document.getElementById("btnSwitchCam");
const btnPauseCam = document.getElementById("btnPauseCam");
const btnResetScan = document.getElementById("btnResetScan");

// VirusTotal DOM
const vtBox = document.getElementById("vtBox");
const vtBadge = document.getElementById("vtBadge");
const scoreCircle = document.getElementById("scoreCircle");
const vtVerdict = document.getElementById("vtVerdict");
const vtSummary = document.getElementById("vtSummary");
const vtEngineList = document.getElementById("vtEngineList");

// Settings Modal DOM
const btnSettings = document.getElementById("btnSettings");
const settingsModal = document.getElementById("settingsModal");
const apiKeyInput = document.getElementById("apiKeyInput");
const btnSaveKey = document.getElementById("btnSaveKey");
const btnCloseModal = document.getElementById("btnCloseModal");

// 1. Initialize VirusTotal API Key from LocalStorage (with user's key as default)
const DEFAULT_VT_KEY = "faf701041edd2bf67a1d28b63ca6da379d40394154725eaf7ca94a762fb9426b";
let vtApiKey = localStorage.getItem("vt_api_key") || DEFAULT_VT_KEY;
apiKeyInput.value = vtApiKey;

// 2. Initialize Camera and Scanner
async function initScanner() {
  // Check for native BarcodeDetector
  if ("BarcodeDetector" in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
        engineBadge.innerText = "Engine: Hardware BarcodeDetector (High FPS)";
        console.log("Hardware BarcodeDetector initialized");
      }
    } catch (e) {
      console.warn("BarcodeDetector error:", e);
    }
  }

  if (!barcodeDetector) {
    engineBadge.innerText = "Engine: Software jsQR (Fallback)";
  }

  await startCamera(currentFacingMode);
  requestAnimationFrame(scanLoop);
}

async function startCamera(facingMode) {
  if (videoStream) {
    videoStream.getTracks().forEach((track) => track.stop());
  }

  try {
    const constraints = {
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    };

    videoStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = videoStream;
    await video.play();
  } catch (err) {
    console.error("Camera access failed:", err);
    alert(
      "Không thể truy cập Camera. Vui lòng cho phép quyền Camera trên trình duyệt: " +
        err.message
    );
  }
}

// 3. Scanning Loop
async function scanLoop() {
  if (!isPaused && video.readyState === video.HAVE_ENOUGH_DATA) {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
      valFps.innerText = `${frameCount} FPS`;
      frameCount = 0;
      lastFpsTime = now;
    }

    if (barcodeDetector) {
      try {
        const barcodes = await barcodeDetector.detect(video);
        if (barcodes && barcodes.length > 0) {
          // Can detect multiple barcodes in 1 frame (Multi-QR Grid!)
          for (const barcode of barcodes) {
            handleRawData(barcode.rawValue);
          }
        }
      } catch (err) {
        // Fallback to jsQR on frame error
        scanWithJsQR();
      }
    } else {
      scanWithJsQR();
    }
  }
  requestAnimationFrame(scanLoop);
}

function scanWithJsQR() {
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "dontInvert",
  });
  if (code && code.data) {
    handleRawData(code.data);
  }
}

// 4. Data Packet Processing
function handleRawData(rawText) {
  if (isCompleted || !rawText || !rawText.startsWith("QRF1|")) return;

  const parts = rawText.split("|");
  if (parts.length !== 8) return;

  const fileId = parts[1];
  const total = parseInt(parts[2], 10);
  const chunkIdx = parseInt(parts[3], 10);
  const origSizeVal = parseInt(parts[4], 10);
  const sha256Val = parts[5];
  let fileNameVal = "file";
  try {
    fileNameVal = decodeURIComponent(escape(atob(parts[6])));
  } catch (e) {
    fileNameVal = atob(parts[6]);
  }
  const payloadB64 = parts[7];

  // If a new file transmission begins
  if (currentFileId !== fileId) {
    currentFileId = fileId;
    fileName = fileNameVal;
    totalChunks = total;
    origSize = origSizeVal;
    origSha256 = sha256Val;
    receivedChunks.clear();
    isCompleted = false;
    resultCard.style.display = "none";

    valFileName.innerText = fileName;
    valOrigSize.innerText = formatBytes(origSize);
  }

  // Record chunk if not already received
  if (!receivedChunks.has(chunkIdx)) {
    const rawChunkBytes = Uint8Array.from(atob(payloadB64), (c) =>
      c.charCodeAt(0)
    );
    receivedChunks.set(chunkIdx, rawChunkBytes);
    updateProgressUI();

    // Check if 100% received
    if (receivedChunks.size === totalChunks) {
      onAllChunksReceived();
    }
  }
}

function updateProgressUI() {
  const count = receivedChunks.size;
  const pct = Math.floor((count / totalChunks) * 100);
  valProgress.innerText = `${pct}% (${count}/${totalChunks})`;
  progressBar.style.width = `${pct}%`;

  // Missing chunks calculation
  const missing = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!receivedChunks.has(i)) {
      missing.push(i + 1); // 1-based for user readability
      if (missing.length >= 15) {
        missing.push("...");
        break;
      }
    }
  }

  if (missing.length === 0) {
    missingChunksBox.style.display = "none";
  } else {
    missingChunksBox.style.display = "block";
    missingChunksList.innerText = "#" + missing.join(", #");
  }
}

// 5. Reassembly and Verification
async function onAllChunksReceived() {
  isCompleted = true;
  if ("vibrate" in navigator) {
    navigator.vibrate([100, 50, 100]);
  }

  // Concatenate all chunks in index order
  let totalCompressedLen = 0;
  for (let i = 0; i < totalChunks; i++) {
    totalCompressedLen += receivedChunks.get(i).length;
  }

  const allCompressed = new Uint8Array(totalCompressedLen);
  let offset = 0;
  for (let i = 0; i < totalChunks; i++) {
    const chunk = receivedChunks.get(i);
    allCompressed.set(chunk, offset);
    offset += chunk.length;
  }

  // Decompress with pako (zlib inflate)
  let decompressed;
  try {
    decompressed = pako.inflate(allCompressed);
  } catch (err) {
    alert("Lỗi giải nén dữ liệu zlib: " + err.message);
    return;
  }

  // Verify SHA-256
  const hashBuffer = await crypto.subtle.digest("SHA-256", decompressed);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const computedSha256 = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  assembledBlob = new Blob([decompressed], {
    type: "application/octet-stream",
  });

  if (computedSha256.toLowerCase() === origSha256.toLowerCase()) {
    hashVerificationText.innerText = `SHA-256 khớp tuyệt đối: ${computedSha256.substring(
      0,
      12
    )}...`;
    hashVerificationText.style.color = "var(--success)";
  } else {
    hashVerificationText.innerText = `Cảnh báo: SHA-256 không khớp!`;
    hashVerificationText.style.color = "var(--danger)";
  }

  resultCard.style.display = "flex";

  // Trigger VirusTotal check automatically
  performVirusTotalScan(computedSha256, assembledBlob);
}

// 6. VirusTotal Integration
async function performVirusTotalScan(sha256Hash, fileBlob) {
  vtBox.style.display = "flex";
  vtBadge.className = "vt-badge";
  vtBadge.innerText = "Đang tra cứu...";
  scoreCircle.className = "score-circle";
  scoreCircle.innerText = "...";
  vtVerdict.innerText = "Đang kiểm tra cơ sở dữ liệu VirusTotal...";
  vtSummary.innerText = `Mã SHA-256: ${sha256Hash.substring(0, 16)}...`;
  vtEngineList.style.display = "none";
  vtEngineList.innerHTML = "";

  if (!vtApiKey) {
    vtBadge.innerText = "Thiếu API Key";
    vtVerdict.innerText = "Chưa cấu hình VirusTotal API Key";
    vtSummary.innerText = "Nhấn biểu tượng ⚙️ góc trên để nhập khóa API";
    return;
  }

  // Step 1: Query VirusTotal by hash (Instant result if known)
  try {
    const checkUrl = `/api/vt/check_hash?hash=${sha256Hash}`;
    const resp = await fetch(checkUrl, {
      headers: { "x-apikey": vtApiKey },
    });

    if (resp.status === 200) {
      const data = await resp.json();
      displayVirusTotalResults(data.data.attributes);
      return;
    } else if (resp.status === 404) {
      // Step 2: File not in VirusTotal database -> Upload file
      vtVerdict.innerText = "File mới chưa có trên VT. Đang tải file lên...";
      await uploadFileToVirusTotal(fileBlob);
    } else if (resp.status === 429) {
      vtBadge.className = "vt-badge";
      vtBadge.innerText = "Giới hạn lượt gọi (429)";
      vtVerdict.innerText = "Đạt giới hạn API miễn phí (4 req/phút)";
      vtSummary.innerText = "Vui lòng đợi khoảng 30 giây rồi bấm nút 'Quét lại VirusTotal'.";
    } else {
      const errData = await resp.json();
      vtBadge.innerText = "Lỗi API";
      vtVerdict.innerText = "Không thể kiểm tra";
      vtSummary.innerText =
        errData.error?.message || errData.error || `HTTP ${resp.status}`;
    }
  } catch (err) {
    console.error("VT Error:", err);
    vtBadge.innerText = "Lỗi kết nối";
    vtVerdict.innerText = "Lỗi kết nối tới VirusTotal";
    vtSummary.innerText = err.message;
  }
}

async function uploadFileToVirusTotal(fileBlob) {
  try {
    const formData = new FormData();
    formData.append("file", fileBlob, fileName);

    const uploadResp = await fetch("/api/vt/upload", {
      method: "POST",
      headers: { "x-apikey": vtApiKey },
      body: formData,
    });

    if (uploadResp.ok) {
      const result = await uploadResp.json();
      vtBadge.innerText = "Đang phân tích";
      vtVerdict.innerText = "Đã tải file lên thành công!";
      vtSummary.innerText =
        "Đang xếp hàng phân tích (Analysis ID: " +
        result.data.id.substring(0, 10) +
        "...). Vui lòng đợi 30s.";
    } else {
      const err = await uploadResp.json();
      vtVerdict.innerText = "Upload thất bại";
      vtSummary.innerText = err.error?.message || `HTTP ${uploadResp.status}`;
    }
  } catch (e) {
    vtVerdict.innerText = "Lỗi khi upload";
    vtSummary.innerText = e.message;
  }
}

function displayVirusTotalResults(attributes) {
  const stats = attributes.last_analysis_stats || {};
  const malicious = stats.malicious || 0;
  const suspicious = stats.suspicious || 0;
  const harmless = stats.harmless || 0;
  const undetected = stats.undetected || 0;
  const total = malicious + suspicious + harmless + undetected;

  scoreCircle.innerText = `${malicious}/${total}`;

  if (malicious > 0) {
    vtBadge.className = "vt-badge malicious";
    vtBadge.innerText = "CẢNH BÁO MÃ ĐỘC";
    scoreCircle.className = "score-circle malicious";
    vtVerdict.innerText = `Phát hiện ${malicious} cảnh báo nguy hiểm!`;
    vtSummary.innerText = `File có dấu hiệu độc hại theo đánh giá của các hãng bảo mật.`;
  } else {
    vtBadge.className = "vt-badge clean";
    vtBadge.innerText = "AN TOÀN (CLEAN)";
    scoreCircle.className = "score-circle clean";
    vtVerdict.innerText = "File hoàn toàn sạch sẽ!";
    vtSummary.innerText = `0/${total} hệ thống an ninh phát hiện mối đe dọa.`;
  }

  // Display detected engines
  const results = attributes.last_analysis_results || {};
  const engineEntries = Object.entries(results);
  if (engineEntries.length > 0) {
    vtEngineList.style.display = "flex";
    vtEngineList.innerHTML = "";

    // Show malicious ones first
    engineEntries.sort((a, b) => {
      const scoreA = a[1].category === "malicious" ? 1 : 0;
      const scoreB = b[1].category === "malicious" ? 1 : 0;
      return scoreB - scoreA;
    });

    for (const [engineName, res] of engineEntries) {
      if (res.category === "malicious" || res.category === "suspicious") {
        const item = document.createElement("div");
        item.className = "engine-item malicious";
        item.innerHTML = `<strong>${engineName}</strong> <span>${
          res.result || res.category
        }</span>`;
        vtEngineList.appendChild(item);
      }
    }
  }
}

// 7. Event Listeners
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
  if (origSha256 && assembledBlob) {
    performVirusTotalScan(origSha256, assembledBlob);
  }
});

btnSwitchCam.addEventListener("click", () => {
  currentFacingMode =
    currentFacingMode === "environment" ? "user" : "environment";
  startCamera(currentFacingMode);
});

btnPauseCam.addEventListener("click", () => {
  isPaused = !isPaused;
  btnPauseCam.innerText = isPaused ? "▶️ Tiếp tục" : "⏸️ Tạm dừng";
});

btnResetScan.addEventListener("click", () => {
  currentFileId = null;
  receivedChunks.clear();
  isCompleted = false;
  assembledBlob = null;
  resultCard.style.display = "none";
  valFileName.innerText = "Chờ quét mã...";
  valProgress.innerText = "0% (0/0)";
  progressBar.style.width = "0%";
  missingChunksBox.style.display = "none";
});

// Settings Modal Events
btnSettings.addEventListener("click", () => {
  apiKeyInput.value = vtApiKey;
  settingsModal.style.display = "flex";
});

btnCloseModal.addEventListener("click", () => {
  settingsModal.style.display = "none";
});

btnSaveKey.addEventListener("click", () => {
  vtApiKey = apiKeyInput.value.trim();
  localStorage.setItem("vt_api_key", vtApiKey);
  settingsModal.style.display = "none";
  if (origSha256 && assembledBlob) {
    performVirusTotalScan(origSha256, assembledBlob);
  }
});

function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Start on load
window.addEventListener("DOMContentLoaded", initScanner);
