// Renders the PWA icons with headless Chrome. Run: node tools/make-icons.mjs
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const out = new URL("../icons/", import.meta.url);
mkdirSync(out, { recursive: true });

// Full-bleed square (maskable-safe: artwork stays inside the central 60%).
const html = (size) => {
  const bars = [3, 1, 1, 3, 1, 1, 3, 3, 1, 1, 1, 3, 1, 3, 1];
  let x = 0;
  const rects = bars.map((w, i) => {
    const r = i % 2 === 0 ? `<rect x="${x}" y="0" width="${w}" height="30" fill="#fff"/>` : "";
    x += w;
    return r;
  }).join("");
  return `<body style="margin:0"><svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" fill="#111827"/>
    <g transform="translate(${50 - x * 0.9}, 30) scale(1.8, 1)">${rects}</g>
    <rect x="22" y="66" width="56" height="7" rx="3.5" fill="#22c55e"/>
  </svg></body>`;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(html(size));
  await page.screenshot({ path: fileURLToPath(new URL(name, out)), clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log("icons written");
