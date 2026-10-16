/**
 * High-Performance Background QR Decoder & Fountain Code Solver
 * Runs entirely in a Web Worker to keep Main Thread / UI at solid 60 FPS.
 *
 * Engines:
 *   1. Hardware BarcodeDetector (GPU/NPU, <5ms)
 *   2. WebAssembly ZXing-WASM (C++ SIMD/Wasm, ~8-15ms)
 *   3. OffscreenCanvas jsQR fallback
 */

/* global pako, ZXingWASM, jsQR */
try {
  importScripts('pako.min.js', 'zxing_reader.js', 'jsQR.min.js');
} catch (e) {
  console.warn('[Worker] importScripts failed:', e);
}

// ---------- Base45 Lookup Table ----------
const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const B45_MAP = new Int16Array(256).fill(-1);
for (let i = 0; i < B45.length; i++) B45_MAP[B45.charCodeAt(i)] = i;

function b45decode(text) {
  const n = text.length;
  const out = [];
  let i = 0;
  while (i + 2 < n) {
    const c0 = B45_MAP[text.charCodeAt(i)];
    const c1 = B45_MAP[text.charCodeAt(i + 1)];
    const c2 = B45_MAP[text.charCodeAt(i + 2)];
    if (c0 < 0 || c1 < 0 || c2 < 0) break;
    const v = c0 + c1 * 45 + c2 * 2025;
    out.push(v >> 8, v & 255);
    i += 3;
  }
  if (i + 1 < n) {
    const c0 = B45_MAP[text.charCodeAt(i)];
    const c1 = B45_MAP[text.charCodeAt(i + 1)];
    if (c0 >= 0 && c1 >= 0) {
      out.push(c0 + c1 * 45);
    }
  }
  return new Uint8Array(out);
}

// ---------- PRNG & Fountain GF(2) Mathematics ----------
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function getLtDegree(rng, k) {
  if (k <= 2) return 1;
  const p = rng() / 4294967296.0;
  if (p < 0.15) return 1;
  if (p < 0.55) return 2;
  if (p < 0.75) return 3;
  if (p < 0.85) return 4;
  if (p < 0.92) return 5;
  if (p < 0.97) return Math.min(k, Math.max(2, Math.floor(k * 0.2)));
  return Math.min(k, Math.max(2, Math.floor(k * 0.5)));
}

function maskFor(idx, k, words) {
  const m = new Uint32Array(words);
  if (idx < k) {
    m[idx >>> 5] |= 1 << (idx & 31);
    return m;
  }
  const rng = mulberry32((Math.imul(idx, 0x9e3779b1) + k) | 0);
  const deg = getLtDegree(rng, k);
  let count = 0;
  while (count < deg) {
    const j = rng() % k;
    const wordIdx = j >>> 5;
    const bit = 1 << (j & 31);
    if ((m[wordIdx] & bit) === 0) {
      m[wordIdx] |= bit;
      count++;
    }
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

// ---------- Decoder Engines State ----------
let barcodeDetector = null;
let zxingWasmReady = false;
let offscreenCanvas = null;
let offscreenCtx = null;
let activeEngineName = "Starting...";

// Session state
let session = null;

async function initEngines() {
  if (typeof BarcodeDetector !== 'undefined') {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
        activeEngineName = "Hardware BarcodeDetector (GPU/NPU)";
      }
    } catch (e) {
      console.warn('[Worker] BarcodeDetector init failed:', e);
    }
  }

  if (typeof ZXingWASM !== 'undefined') {
    try {
      ZXingWASM.prepareZXingModule({
        overrides: {
          locateFile: (p) => (p.endsWith('.wasm') ? 'zxing_reader.wasm' : p),
        },
      });
      zxingWasmReady = true;
      if (!barcodeDetector) {
        activeEngineName = "WebAssembly ZXing-WASM (C++)";
      }
    } catch (e) {
      console.warn('[Worker] ZXing-WASM init failed:', e);
    }
  }

  if (!barcodeDetector && !zxingWasmReady) {
    activeEngineName = "Worker jsQR (software)";
  }

  self.postMessage({ type: 'engine_ready', engine: activeEngineName });
}

function newSession(id, k) {
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
    startTime: performance.now(),
  };
}

async function decodeImage(bitmap) {
  const w = bitmap.width;
  const h = bitmap.height;

  // 1. Try Native BarcodeDetector
  if (barcodeDetector) {
    try {
      const codes = await barcodeDetector.detect(bitmap);
      if (codes && codes.length > 0) {
        return codes.map(c => c.rawValue);
      }
    } catch (e) {
      // Hardware detector failure, fallback to WASM
    }
  }

  // Draw bitmap to OffscreenCanvas once for software/WASM fallback
  if (!offscreenCanvas) {
    offscreenCanvas = new OffscreenCanvas(w, h);
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  } else if (offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
  }

  offscreenCtx.drawImage(bitmap, 0, 0, w, h);
  const imgData = offscreenCtx.getImageData(0, 0, w, h);

  // 2. Try WebAssembly ZXing-WASM
  if (zxingWasmReady && typeof ZXingWASM !== 'undefined') {
    try {
      const results = await ZXingWASM.readBarcodesFromImageData(imgData, {
        formats: ['QRCode'],
        tryHarder: false,
      });
      if (results && results.length > 0) {
        return results.map(r => r.text);
      }
    } catch (e) {
      // WASM decode failed, fallback to jsQR
    }
  }

  // 3. Fallback to jsQR
  if (typeof jsQR !== 'undefined') {
    const code = jsQR(imgData.data, w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) {
      return [code.data];
    }
  }

  return [];
}

async function handleRawData(text) {
  if (!text || (session && session.done)) return;

  if (text.startsWith("Q2M:")) {
    handleMeta(text);
  } else if (text.startsWith("Q2:")) {
    await handleData(text);
  }
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

  self.postMessage({
    type: 'meta',
    id,
    k,
    len: session.meta.len,
    orig: session.meta.orig,
    z: session.meta.z,
    md5: session.meta.md5,
    sha32: session.meta.sha32,
    name,
  });

  checkCompletion();
}

async function handleData(text) {
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

  let mask = maskFor(idx, session.k, session.words);
  let val = block;
  let addedNewPivot = false;

  for (;;) {
    const low = lowBit(mask);
    if (low < 0) break; // redundant frame
    const piv = session.pivots[low];
    if (!piv) {
      session.pivots[low] = { mask, val: new Uint8Array(val) };
      session.rank++;
      addedNewPivot = true;
      break;
    }
    if (val === block) val = new Uint8Array(block);
    xorInto(mask, piv.mask);
    xorInto(val, piv.val);
  }

  self.postMessage({
    type: 'progress',
    rank: session.rank,
    k: session.k,
    frames: session.frames,
    addedBytes: addedNewPivot ? session.size : 0,
  });

  await checkCompletion();
}

async function checkCompletion() {
  if (!session || session.done || !session.meta || session.rank < session.k) return;
  session.done = true;

  const k = session.k;
  const size = session.size;
  const sol = new Array(k);

  // Back substitution over GF(2)
  for (let c = k - 1; c >= 0; c--) {
    const piv = session.pivots[c];
    const val = new Uint8Array(piv.val);
    for (let d = c + 1; d < k; d++) {
      if ((piv.mask[d >>> 5] >>> (d & 31)) & 1) {
        xorInto(val, sol[d]);
      }
    }
    sol[c] = val;
  }

  const all = new Uint8Array(k * size);
  for (let c = 0; c < k; c++) {
    all.set(sol[c], c * size);
  }

  let data = all.subarray(0, session.meta.len);

  // Decompression
  if (session.meta.z) {
    try {
      data = pako.inflate(data);
    } catch (e) {
      self.postMessage({
        type: 'error',
        message: 'Lỗi giải nén zlib: ' + e.message,
      });
      return;
    }
  }

  // SHA-256 computation
  const digest = await crypto.subtle.digest('SHA-256', data);
  const sha256 = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const ok = sha256.startsWith(session.meta.sha32) && data.length === session.meta.orig;
  const elapsed = Math.max(0.05, (performance.now() - session.startTime) / 1000);

  // Transfer data buffer back to main thread
  self.postMessage(
    {
      type: 'done',
      data: data,
      sha256,
      md5: session.meta.md5,
      sha32: session.meta.sha32,
      orig: session.meta.orig,
      len: session.meta.len,
      name: session.meta.name,
      ok,
      frames: session.frames,
      elapsed,
    },
    [data.buffer]
  );
}

// ---------- Message Handler ----------
self.onmessage = async function (e) {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'init') {
    await initEngines();
    return;
  }

  if (msg.type === 'reset') {
    session = null;
    return;
  }

  if (msg.type === 'data') {
    if (msg.text) {
      await handleRawData(msg.text);
    }
    return;
  }

  if (msg.type === 'frame') {
    const bitmap = msg.bitmap;
    try {
      const results = await decodeImage(bitmap);
      if (results && results.length > 0) {
        for (const text of results) {
          await handleRawData(text);
        }
      }
    } catch (err) {
      console.warn('[Worker] Frame processing error:', err);
    } finally {
      bitmap.close();
      self.postMessage({ type: 'frame_done' });
    }
  }
};

initEngines();
