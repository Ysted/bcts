// Camera + barcode decoding. Two engines:
//  - native BarcodeDetector (Chrome Android, uses ML Kit) when it supports ITF;
//  - bundled zxing-cpp compiled to WASM (iPhone, desktop, anything else), loaded on
//    demand from vendor/.
// Both return raw strings. Validation and double-read confirmation live in logic.js.

const NATIVE_FORMATS = ["itf", "code_128", "data_matrix", "qr_code"];
const ZXING_SRC = "vendor/zxing-wasm-3.1.4-reader.js";
const ZXING_WASM = "vendor/zxing_reader-3.1.4.wasm";
const CAMERA_FPS = 30;
// Tags are read from 20-30 cm, where phone cameras focus well, and still fill the box.
const ZOOM = 1.5;
const MAX_SIDE = 1280; // downscale big frames (a camera that ignores the 720p request)
// Only a band of the frame is decoded: full width, centred on the (square) guide
// box, BAND x its size tall, i.e. the box plus a quarter of it above and below.
const BAND = 1.5;

export async function createDetector({ forceZxing = false } = {}) {
  if (!forceZxing && "BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (supported.includes("itf")) {
        const detector = new window.BarcodeDetector({
          formats: NATIVE_FORMATS.filter((f) => supported.includes(f)),
        });
        return {
          name: "bawaan Chrome",
          detect: async (canvas) => (await detector.detect(canvas)).map((b) => b.rawValue),
        };
      }
    } catch {
      // fall through to ZXing
    }
  }
  return createZxingDetector();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Gagal memuat ${src}`));
    document.head.append(script);
  });
}

async function createZxingDetector() {
  if (!window.ZXingWASM) await loadScript(ZXING_SRC);
  const Z = window.ZXingWASM;
  const wasmUrl = new URL(ZXING_WASM, location.href).href; // never the library's CDN default
  await Z.prepareZXingModule({
    overrides: { locateFile: (file, prefix) => (file.endsWith(".wasm") ? wasmUrl : prefix + file) },
    fireImmediately: true,
  });
  const options = {
    // ITF is off by default in most scanners; it is THE baggage tag symbology.
    formats: ["ITF", "Code128", "DataMatrix", "QRCode"],
    tryHarder: true,
    tryRotate: true, // an upright tag
    tryInvert: false,
    maxNumberOfSymbols: 8,
  };
  return {
    name: "ZXing-C++",
    detect: async (canvas) => {
      const image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const results = await Z.readBarcodes(image, options);
      return results.filter((r) => r.isValid).map((r) => r.text);
    },
  };
}

// --- camera ------------------------------------------------------------------

export async function openCamera(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError("insecure");
  }
  const constraints = {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: CAMERA_FPS },
  };
  const open = (extra = {}) => navigator.mediaDevices.getUserMedia({ audio: false, video: { ...constraints, ...extra } });
  let stream;
  try {
    stream = await open();
  } catch (err) {
    throw new CameraError(err?.name || "unknown");
  }
  // Android may hand out an ultra-wide, fixed-focus lens for "environment";
  // "camera2 0" is the main back camera. Switch to it if we did not get it.
  const main = await mainBackCamera(stream);
  if (main) {
    stream.getTracks().forEach((t) => t.stop());
    stream = await open({ deviceId: { exact: main } }).catch(() => open()).catch((err) => {
      throw new CameraError(err?.name || "unknown");
    });
  }
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play().catch(() => {});

  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  const tuning = {};
  if (caps.focusMode?.includes("continuous")) tuning.focusMode = "continuous";
  if (caps.zoom) tuning.zoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min, ZOOM));
  if (Object.keys(tuning).length) track.applyConstraints({ advanced: [tuning] }).catch(() => {});
  return {
    torchSupported: Boolean(caps.torch),
    setTorch: (on) => track.applyConstraints({ advanced: [{ torch: on }] }),
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

async function mainBackCamera(stream) {
  try {
    const current = stream.getVideoTracks()[0].getSettings().deviceId;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const main = devices.find((d) => d.kind === "videoinput" && /camera2 0\b/.test(d.label) && /back/i.test(d.label));
    return main && main.deviceId !== current ? main.deviceId : null;
  } catch {
    return null;
  }
}

export class CameraError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

export function cameraErrorMessage(err) {
  switch (err?.kind) {
    case "insecure":
      return "Kamera hanya bisa dipakai lewat alamat https://. Buka aplikasi dari alamat resminya.";
    case "NotAllowedError":
    case "SecurityError":
      return isIOS
        ? "Izin kamera ditolak. Buka Pengaturan iPhone > Safari > Kamera, pilih Izinkan, lalu buka ulang aplikasi."
        : "Izin kamera ditolak. Buka Setelan HP > Aplikasi > Chrome > Izin > Kamera, pilih Izinkan, lalu buka ulang aplikasi.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Kamera tidak ditemukan di perangkat ini. Pakai tombol Ketik nomor.";
    case "NotReadableError":
    case "AbortError":
      return "Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu, lalu tekan Mulai scan lagi.";
    default:
      return `Kamera gagal dibuka (${err?.kind || err?.message || "tidak diketahui"}). Tutup lalu buka lagi aplikasi. Sementara itu, pakai Ketik nomor.`;
  }
}

// Scan loop. One decode in flight at a time, so a slow device skips frames
// instead of piling work up. Waits for a genuinely new camera frame
// (requestVideoFrameCallback, rAF where missing), so the double-read confirmation
// always compares two different frames. With nothing in view it decodes only
// every IDLE_GAP_MS; as soon as a frame yields a value it decodes every frame,
// so a tag is confirmed as fast as before. This is what keeps the phone cool.
const IDLE_GAP_MS = 100; // ~10 decodes/s while searching

const frameCanvas = document.createElement("canvas");
const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

// The guide band of the current frame, drawn into frameCanvas. null if no frame yet.
function grabBand(video, guide) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  let y0 = 0;
  let y1 = h;
  const v = video.getBoundingClientRect();
  const g = guide.getBoundingClientRect();
  if (g.height && v.height) {
    const scale = Math.max(v.width / w, v.height / h); // object-fit: cover
    const centre = (g.top + g.height / 2 - v.top - (v.height - h * scale) / 2) / scale;
    const half = (g.width * BAND) / 2 / scale;
    y0 = Math.max(0, Math.round(centre - half));
    y1 = Math.min(h, Math.round(centre + half));
    if (y1 - y0 < 16) { y0 = 0; y1 = h; } // guide off the picture: decode it all
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(w, y1 - y0));
  frameCanvas.width = Math.round(w * scale);
  frameCanvas.height = Math.round((y1 - y0) * scale);
  frameCtx.drawImage(video, 0, y0, w, y1 - y0, 0, 0, frameCanvas.width, frameCanvas.height);
  return frameCanvas;
}

export function startScanLoop(video, guide, detector, onFrame) {
  let running = true;
  let timer = null;
  const nextFrame = (cb) => (video.requestVideoFrameCallback
    ? video.requestVideoFrameCallback(cb)
    : requestAnimationFrame(cb));
  async function tick() {
    if (!running) return;
    let values = [];
    const frame = video.readyState >= 2 && grabBand(video, guide);
    if (frame) {
      try {
        values = await detector.detect(frame);
      } catch {
        values = [];
      }
      if (running) onFrame(values, performance.now());
    }
    if (!running) return;
    if (values.length) nextFrame(tick);
    else timer = setTimeout(() => nextFrame(tick), IDLE_GAP_MS);
  }
  nextFrame(tick);
  return () => { running = false; clearTimeout(timer); };
}
