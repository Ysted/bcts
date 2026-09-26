// Camera + barcode decoding. Two engines:
//  - native BarcodeDetector (Chrome Android, uses ML Kit) when it supports ITF;
//  - bundled ZXing (iPhone, desktop, anything else), loaded on demand from vendor/.
// Both return raw strings; validation and double-read confirmation live in logic.js.

const NATIVE_FORMATS = ["itf", "code_128", "data_matrix", "qr_code"];
const ZXING_SRC = "vendor/zxing-0.23.0.min.js";
const ZXING_MAX_SIDE = 1280; // downscale big frames; ZXing is pure JS on the main thread

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
          detect: async (video) => (await detector.detect(video)).map((b) => b.rawValue),
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
  if (!window.ZXing) await loadScript(ZXING_SRC);
  const Z = window.ZXing;
  const hints = new Map();
  // ITF is off by default in most scanners; it is THE baggage tag symbology.
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.ITF, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.QR_CODE,
  ]);
  // Baggage tags are 10 digits; ZXing's default ITF lengths also allow 6/8 which
  // invites false positives from partial scans of the bars.
  hints.set(Z.DecodeHintType.ALLOWED_LENGTHS, Int32Array.from([10]));
  hints.set(Z.DecodeHintType.TRY_HARDER, true); // also tries the frame rotated 90°
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  return {
    name: "ZXing",
    detect: async (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return [];
      const scale = Math.min(1, ZXING_MAX_SIDE / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      // ZXing 0.23 console.warn()s on every unreadable frame; mute it during the decode.
      const warn = console.warn;
      console.warn = () => {};
      try {
        const source = new Z.HTMLCanvasElementLuminanceSource(canvas);
        const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
        return [reader.decodeWithState(bitmap).getText()];
      } catch {
        return []; // NotFound / Checksum / Format: nothing readable in this frame
      } finally {
        console.warn = warn;
        reader.reset();
      }
    },
  };
}

// --- camera ------------------------------------------------------------------

export async function openCamera(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError("insecure");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (err) {
    throw new CameraError(err?.name || "unknown");
  }
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play().catch(() => {});

  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  if (caps.focusMode?.includes("continuous")) {
    track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  }
  return {
    torchSupported: Boolean(caps.torch),
    setTorch: (on) => track.applyConstraints({ advanced: [{ torch: on }] }),
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
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

// Continuous scan loop on requestAnimationFrame; one decode in flight at a time,
// so a slow device skips frames instead of piling work up.
export function startScanLoop(video, detector, onFrame) {
  let running = true;
  async function tick() {
    if (!running) return;
    if (video.readyState >= 2) {
      let values = [];
      try {
        values = await detector.detect(video);
      } catch {
        values = [];
      }
      if (running) onFrame(values, performance.now());
    }
    if (running) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return () => { running = false; };
}
