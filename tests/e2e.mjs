// End-to-end check in real Chrome with a fake camera that "sees" ITF barcodes.
// Run from BCTS/: node tests/e2e.mjs   (needs python, ffmpeg, Chrome)
// On Windows desktop Chrome has no BarcodeDetector, so this exercises the ZXing
// engine — the same one iPhones use.
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = fileURLToPath(new URL("output/", import.meta.url));
const PORT = 8765;
const URL_BASE = `http://localhost:${PORT}/`;
mkdirSync(OUT, { recursive: true });

// --- ITF barcode as SVG ---------------------------------------------------------
const ITF = ["nnwwn", "wnnnw", "nwnnw", "wwnnn", "nnwnw", "wnwnn", "nwwnn", "nnnww", "wnnwn", "nwnwn"];
function itfModules(digits) {
  const W = 3;
  const seq = [1, 1, 1, 1]; // start: bar space bar space (narrow)
  for (let i = 0; i < digits.length; i += 2) {
    const bars = ITF[digits[i]];
    const spaces = ITF[digits[i + 1]];
    for (let k = 0; k < 5; k++) seq.push(bars[k] === "w" ? W : 1, spaces[k] === "w" ? W : 1);
  }
  seq.push(W, 1, 1); // stop: wide bar, space, bar
  return seq;
}
function barcodeSvg(digits, { rotate = 0, module = 3, blur = 0 } = {}) {
  const seq = itfModules(digits);
  let x = 0;
  let rects = "";
  seq.forEach((w, i) => {
    if (i % 2 === 0) rects += `<rect x="${x * module}" y="0" width="${w * module}" height="140" fill="#000"/>`;
    x += w;
  });
  const bw = x * module;
  return `<body style="margin:0;background:#ddd">
  <svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="b"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>
    <rect width="1280" height="720" fill="#c8c2b8"/>
    <g transform="translate(640 360) rotate(${rotate}) translate(${-bw / 2 - 40} -110)">
      <rect width="${bw + 80}" height="220" fill="#fff"/>
      <g transform="translate(40 20)" filter="url(#b)">${rects}</g>
      <text x="${(bw + 80) / 2}" y="200" font-size="28" text-anchor="middle" font-family="monospace">${digits}</text>
    </g>
  </svg></body>`;
}

async function makeVideo(browser, name, html) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setContent(html);
  const png = `${OUT}${name}.png`;
  await page.screenshot({ path: png });
  await page.close();
  const y4m = `${OUT}${name}.y4m`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-i", png, "-t", "3", "-r", "15", "-pix_fmt", "yuv420p", y4m]);
  return y4m;
}

// --- helpers --------------------------------------------------------------------
const server = spawn("python", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const launch = (video) => puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    ...(video ? [`--use-file-for-fake-video-capture=${video}`] : []),
    "--autoplay-policy=no-user-gesture-required",
  ],
});

async function openApp(browser, watchlistText) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(URL_BASE, { waitUntil: "networkidle0" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  await page.$eval("#bulk-input", (el, v) => { el.value = v; }, watchlistText);
  await page.click("#add-form button[type=submit]");
  await page.click('nav button[data-nav="scan"]');
  return { page, errors };
}

const isShown = (page, sel) => page.$eval(sel, (e) => !e.hidden);

async function scanScenario(videoFile, watchlistText, expect, label) {
  const browser = await launch(videoFile);
  try {
    const { page, errors } = await openApp(browser, watchlistText);
    const t0 = Date.now();
    await page.click("#start-scan");
    if (expect === "none") {
      await page.waitForFunction(() => document.getElementById("scan-status").textContent.includes("tidak dicari"), { timeout: 15000 });
      assert.equal(await isShown(page, "#result"), false, `${label}: no overlay on none`);
    } else {
      await page.waitForSelector("#result:not([hidden])", { timeout: 15000 });
      const title = await page.$eval("#result-title", (e) => e.textContent);
      assert.ok(expect === "full" ? title === "Cocok" : title.startsWith("Cocok sebagian"), `${label}: title ${title}`);
    }
    const ms = Date.now() - t0;
    await page.screenshot({ path: `${OUT}${label}.png` });
    const engine = await page.$eval("#engine-info", (e) => e.textContent);
    assert.ok(engine.includes("ZXing"), `${label}: engine ${engine}`);
    const log = await page.evaluate(() => JSON.parse(localStorage.getItem("bcts.log")));
    assert.equal(log.at(-1).result, expect, `${label}: log result`);
    assert.equal(log.at(-1).source, "kamera");

    if (expect !== "none") {
      // Dismiss while the same bag is still in view: must not re-alarm for 10 s.
      await page.click("#result-continue");
      await new Promise((r) => setTimeout(r, 4000));
      assert.equal(await isShown(page, "#result"), false, `${label}: re-alarmed right after dismiss`);
    }
    await page.click("#stop-scan");
    assert.equal(await isShown(page, "#scanner"), false);
    assert.deepEqual(errors.filter((e) => !e.includes("favicon")), [], `${label}: page errors`);
    console.log(`✔ ${label}: ${expect} in ${ms} ms (${engine})`);
  } finally {
    await browser.close();
  }
}

// --- scenarios ------------------------------------------------------------------
try {
  const gen = await launch();
  const videos = {
    full: await makeVideo(gen, "full", barcodeSvg("0126123456")),
    partial: await makeVideo(gen, "partial", barcodeSvg("0657123456")),
    none: await makeVideo(gen, "none", barcodeSvg("0994777888")),
    vertical: await makeVideo(gen, "vertical", barcodeSvg("0126123456", { rotate: 90 })),
    tilted: await makeVideo(gen, "tilted", barcodeSvg("0126123456", { rotate: 8, module: 2, blur: 0.6 })),
    small: await makeVideo(gen, "small", barcodeSvg("0126123456", { module: 2 })),
  };
  await gen.close();

  const WL = "0126123456\n0990000001\n654321";
  await scanScenario(videos.full, WL, "full", "cocok-penuh");
  await scanScenario(videos.partial, WL, "partial", "cocok-sebagian");
  await scanScenario(videos.none, WL, "none", "tidak-dicari");
  await scanScenario(videos.vertical, WL, "full", "barcode-tegak");
  await scanScenario(videos.tilted, WL, "full", "barcode-miring-buram");
  await scanScenario(videos.small, WL, "full", "barcode-kecil");

  // Manual entry, offline reload, log copy.
  const browser = await launch(videos.none);
  try {
    const { page, errors } = await openApp(browser, WL);
    await page.click("#manual-open-idle");
    for (const d of "0126123456") await page.click(`#keys button[data-key="${d}"]`);
    await page.screenshot({ path: `${OUT}keypad.png` });
    await page.click("#keypad-check");
    assert.equal(await page.$eval("#result-title", (e) => e.textContent), "Cocok");
    await page.click("#result-found");
    const wl = await page.evaluate(() => JSON.parse(localStorage.getItem("bcts.watchlist")));
    assert.equal(wl.find((e) => e.number === "0126123456").found, true, "marked found from result");

    await page.click("#manual-open-idle");
    for (const d of "654321") await page.click(`#keys button[data-key="${d}"]`);
    await page.click("#keypad-check");
    assert.ok((await page.$eval("#result-title", (e) => e.textContent)).startsWith("Cocok sebagian"));
    await page.screenshot({ path: `${OUT}manual-partial.png` });
    await page.click("#result-continue");

    // Service worker ready → offline reload must still work, including ZXing.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "networkidle0" }); // controlled by SW now
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.title(), "BCTS", "offline reload");
    const zxingOffline = await page.evaluate(async () => (await fetch("vendor/zxing-0.23.0.min.js")).ok);
    assert.ok(zxingOffline, "ZXing cached for offline");
    await page.click('nav button[data-nav="scan"]');
    await page.click("#start-scan");
    await page.waitForFunction(() => document.getElementById("scan-status").textContent.includes("tidak dicari"), { timeout: 15000 });
    await page.click("#stop-scan");
    await page.setOfflineMode(false);

    await page.click('nav button[data-nav="log"]');
    await page.screenshot({ path: `${OUT}log.png` });
    const logRows = await page.$$eval("#log-list li", (li) => li.length);
    assert.ok(logRows >= 3, "log rows");
    assert.deepEqual(errors.filter((e) => !e.includes("favicon")), [], "page errors");
    console.log("✔ ketik manual, tandai ketemu, offline, log");
  } finally {
    await browser.close();
  }
  console.log("SEMUA LOLOS");
} finally {
  server.kill();
}
