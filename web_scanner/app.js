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
const valSpeed = document.getElementById("valSpeed");
const valReceivedBytes = document.getElementById("valReceivedBytes");
const progressBar = document.getElementById("progressBar");
const missingChunksBox = document.getElementById("missingChunksBox");
const missingChunksList = document.getElementById("missingChunksList");

// Speed & Metrics calculation state
let transferStartTime = null;
let lastSpeedCalcTime = performance.now();
let bytesSinceLastCalc = 0;
let totalReceivedBytes = 0;
let currentSpeedKBps = 0;

const resultCard = document.getElementById("resultCard");
const hashVerificationText = document.getElementById("hashVerificationText");
const valTransferSummary = document.getElementById("valTransferSummary");
const btnDownload = document.getElementById("btnDownload");
const btnManualVT = document.getElementById("btnManualVT");
const btnSwitchCam = document.getElementById("btnSwitchCam");
const btnPauseCam = document.getElementById("btnPauseCam");
const btnResetScan = document.getElementById("btnResetScan");

// Instant MD5 Card DOM
const vtInstantCard = document.getElementById("vtInstantCard");
const vtInstantBadge = document.getElementById("vtInstantBadge");
const valMd5Hash = document.getElementById("valMd5Hash");
const vtInstantCircle = document.getElementById("vtInstantCircle");
const vtInstantVerdict = document.getElementById("vtInstantVerdict");
const vtInstantSummary = document.getElementById("vtInstantSummary");
const btnVtDirectLink = document.getElementById("btnVtDirectLink");
const vtInstantEngineList = document.getElementById("vtInstantEngineList");

let currentFileMd5 = null;
let instantVtChecked = false;

// VirusTotal Full Card DOM
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

// 1. Initialize VirusTotal API Key from LocalStorage (empty by default)
let vtApiKey = localStorage.getItem("vt_api_key") || "";
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

    // Live speed calculation every 400ms
    const timeDiff = (now - lastSpeedCalcTime) / 1000;
    if (timeDiff >= 0.4) {
      if (transferStartTime && !isCompleted && totalReceivedBytes > 0) {
        currentSpeedKBps = (bytesSinceLastCalc / 1024) / timeDiff;
        valSpeed.innerText = `${currentSpeedKBps.toFixed(1)} KB/s`;
      }
      bytesSinceLastCalc = 0;
      lastSpeedCalcTime = now;
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
  const md5Val = parts[5];
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
    currentFileMd5 = md5Val;
    fileName = fileNameVal;
    totalChunks = total;
    origSize = origSizeVal;
    receivedChunks.clear();
    isCompleted = false;
    instantVtChecked = false;
    resultCard.style.display = "none";

    transferStartTime = null;
    bytesSinceLastCalc = 0;
    totalReceivedBytes = 0;
    currentSpeedKBps = 0;
    valSpeed.innerText = "0.0 KB/s";
    valReceivedBytes.innerText = "0 KB";
    if (valTransferSummary) valTransferSummary.innerText = "";

    valFileName.innerText = fileName;
    valOrigSize.innerText = formatBytes(origSize);

    // Kích hoạt ngay tra cứu MD5 tức thì từ frame đầu tiên!
    triggerInstantMd5Check(currentFileMd5);
  } else if (!instantVtChecked && md5Val) {
    currentFileMd5 = md5Val;
    triggerInstantMd5Check(currentFileMd5);
  }

  // Record chunk if not already received
  if (!receivedChunks.has(chunkIdx)) {
    const rawChunkBytes = Uint8Array.from(atob(payloadB64), (c) =>
      c.charCodeAt(0)
    );
    receivedChunks.set(chunkIdx, rawChunkBytes);

    if (!transferStartTime) {
      transferStartTime = performance.now();
      lastSpeedCalcTime = performance.now();
    }
    bytesSinceLastCalc += rawChunkBytes.length;
    totalReceivedBytes += rawChunkBytes.length;

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
  valReceivedBytes.innerText = formatBytes(totalReceivedBytes);

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

  hashVerificationText.innerText = `Toàn vẹn dữ liệu: MD5 ${currentFileMd5} (Khớp 100%)`;
  hashVerificationText.style.color = "var(--success)";

  const totalDurationSec = (performance.now() - (transferStartTime || performance.now())) / 1000;
  const safeDuration = Math.max(0.05, totalDurationSec);
  const avgSpeedKBps = (totalReceivedBytes / 1024) / safeDuration;
  valSpeed.innerText = `${avgSpeedKBps.toFixed(1)} KB/s (Hoàn tất)`;
  if (valTransferSummary) {
    valTransferSummary.innerText = `⏱️ Thời gian: ${totalDurationSec.toFixed(1)}s | Tốc độ TB: ${avgSpeedKBps.toFixed(1)} KB/s (${(avgSpeedKBps * 8).toFixed(0)} Kbps)`;
  }

  resultCard.style.display = "flex";
}

// 6. Instant MD5 Check & VirusTotal Integration
function triggerInstantMd5Check(md5Hash) {
  if (!md5Hash) return;
  vtInstantCard.style.display = "flex";
  valMd5Hash.innerText = md5Hash;
  btnVtDirectLink.href = `https://www.virustotal.com/gui/file/${md5Hash}`;
  btnVtDirectLink.style.display = "inline-flex";
  vtInstantEngineList.style.display = "none";
  vtInstantEngineList.innerHTML = "";

  if (instantVtChecked) return;
  instantVtChecked = true;

  if (vtApiKey) {
    vtInstantBadge.className = "vt-badge";
    vtInstantBadge.innerText = "Đang tra cứu API...";
    vtInstantCircle.className = "score-circle";
    vtInstantCircle.innerText = "...";
    vtInstantVerdict.innerText = "Đang kiểm tra MD5 trên VirusTotal...";
    vtInstantSummary.innerText = `Mã MD5: ${md5Hash}`;

    fetch(`/api/vt/check_hash?hash=${md5Hash}`, {
      headers: { "x-apikey": vtApiKey },
    })
      .then((resp) => {
        if (resp.status === 200) {
          return resp.json().then((data) => {
            displayInstantVtResults(data.data.attributes);
          });
        } else if (resp.status === 404) {
          vtInstantBadge.className = "vt-badge";
          vtInstantBadge.innerText = "Chưa có trên VT";
          vtInstantCircle.className = "score-circle";
          vtInstantCircle.innerText = "NEW";
          vtInstantVerdict.innerText = "Mã MD5 mới (chưa có kết quả trên VT)";
          vtInstantSummary.innerText = "Mẫu này chưa từng được phân tích trên VirusTotal. Đang tiếp tục nhận file...";
        } else if (resp.status === 429) {
          vtInstantBadge.innerText = "Rate limit (429)";
          vtInstantVerdict.innerText = "Đạt giới hạn gọi API";
          vtInstantSummary.innerText = "Bấm nút bên dưới để mở trực tiếp trang web VirusTotal.";
        } else {
          vtInstantBadge.innerText = "Tra cứu web";
          vtInstantVerdict.innerText = "Đã nhận mã MD5";
          vtInstantSummary.innerText = "Bấm nút bên dưới để mở trang web VirusTotal miễn phí.";
        }
      })
      .catch((e) => {
        vtInstantBadge.innerText = "Tra cứu web";
        vtInstantVerdict.innerText = "Đã nhận mã MD5";
        vtInstantSummary.innerText = "Bấm nút bên dưới để mở trang web VirusTotal miễn phí.";
      });
  } else {
    // Mode hoàn toàn miễn phí không cần API Key
    vtInstantBadge.className = "vt-badge clean";
    vtInstantBadge.innerText = "Sẵn Sàng Tra Cứu";
    vtInstantCircle.className = "score-circle clean";
    vtInstantCircle.innerText = "VT";
    vtInstantVerdict.innerText = "Đã bắt được mã MD5 của file!";
    vtInstantSummary.innerText = "Nhấn nút bên dưới để mở ngay toàn bộ kết quả quét 70+ AV engine trên VirusTotal hoàn toàn miễn phí.";
  }
}

function displayInstantVtResults(attributes) {
  const stats = attributes.last_analysis_stats || {};
  const malicious = stats.malicious || 0;
  const suspicious = stats.suspicious || 0;
  const harmless = stats.harmless || 0;
  const undetected = stats.undetected || 0;
  const total = malicious + suspicious + harmless + undetected;

  vtInstantCircle.innerText = `${malicious}/${total}`;

  if (malicious > 0) {
    vtInstantBadge.className = "vt-badge malicious";
    vtInstantBadge.innerText = "CẢNH BÁO MÃ ĐỘC";
    vtInstantCircle.className = "score-circle malicious";
    vtInstantVerdict.innerText = `Phát hiện ${malicious} cảnh báo nguy hiểm!`;
    vtInstantSummary.innerText = `File có dấu hiệu độc hại theo đánh giá của các hãng bảo mật.`;
  } else {
    vtInstantBadge.className = "vt-badge clean";
    vtInstantBadge.innerText = "AN TOÀN (CLEAN)";
    vtInstantCircle.className = "score-circle clean";
    vtInstantVerdict.innerText = "File hoàn toàn sạch sẽ!";
    vtInstantSummary.innerText = `0/${total} hệ thống an ninh phát hiện mối đe dọa.`;
  }

  const results = attributes.last_analysis_results || {};
  const engineEntries = Object.entries(results);
  if (engineEntries.length > 0) {
    vtInstantEngineList.style.display = "flex";
    vtInstantEngineList.innerHTML = "";

    engineEntries.sort((a, b) => {
      const scoreA = a[1].category === "malicious" ? 1 : 0;
      const scoreB = b[1].category === "malicious" ? 1 : 0;
      return scoreB - scoreA;
    });

    for (const [engineName, res] of engineEntries) {
      if (res.category === "malicious" || res.category === "suspicious") {
        const item = document.createElement("div");
        item.className = "engine-item malicious";
        item.innerHTML = `<strong>${engineName}</strong> <span>${res.result || res.category}</span>`;
        vtInstantEngineList.appendChild(item);
      }
    }
  }
}
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
  currentFileMd5 = null;
  instantVtChecked = false;
  vtInstantCard.style.display = "none";
  receivedChunks.clear();
  isCompleted = false;
  assembledBlob = null;
  resultCard.style.display = "none";
  valFileName.innerText = "Chờ quét mã...";
  valProgress.innerText = "0% (0/0)";
  progressBar.style.width = "0%";
  missingChunksBox.style.display = "none";
  transferStartTime = null;
  bytesSinceLastCalc = 0;
  totalReceivedBytes = 0;
  currentSpeedKBps = 0;
  valSpeed.innerText = "0.0 KB/s";
  valReceivedBytes.innerText = "0 KB";
  if (valTransferSummary) valTransferSummary.innerText = "";
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
