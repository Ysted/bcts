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
// BCTS_URL=https://ysted.github.io/bcts/ node tests/e2e.mjs  → test the live deploy instead
const URL_BASE = process.env.BCTS_URL || `http://localhost:${PORT}/`;
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
const server = process.env.BCTS_URL
  ? { kill() {} }
  : spawn("python", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
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
  await page.click("#add-open");
  await page.$eval("#bulk-input", (el, v) => { el.value = v; }, watchlistText.replace(/\n/g, ", "));
  await page.click("#add-form button[type=submit]");
  assert.equal(await page.$eval("#add-dialog", (d) => d.open), false, "dialog closes after a clean add");
  await page.click('nav button[data-nav="scan"]');
  return { page, errors };
}

const isShown = (page, sel) => page.$eval(sel, (e) => !e.hidden);

// Opening the Scan tab starts the camera by itself.
async function scanScenario(videoFile, watchlistText, expect, label) {
  const browser = await launch(videoFile);
  try {
    const t0 = Date.now();
    const { page, errors } = await openApp(browser, watchlistText);
    await page.waitForFunction(() => document.getElementById("scan-ms").textContent.startsWith("terbaca"), { timeout: 15000 });
    const ms = Date.now() - t0;
    const readMs = await page.$eval("#scan-ms", (e) => e.textContent);
    if (expect === "full") {
      await page.waitForSelector("#result:not([hidden])", { timeout: 2000 });
      assert.equal(await page.$eval("#result-title", (e) => e.textContent), "Ketemu!", `${label}: title`);
    } else {
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(await isShown(page, "#result"), false, `${label}: no overlay`);
      const colours = await page.$$eval("#scan-number span", (s) => s.map((x) => x.className).join(","));
      if (expect === "near") assert.ok(colours.includes("diff") && colours.includes("same"), `${label}: coloured digits`);
      else assert.equal(colours, "", `${label}: no colours`);
    }
    await page.screenshot({ path: `${OUT}${label}.png` });
    const engine = await page.$eval("#engine-info", (e) => e.textContent);
    assert.ok(engine.includes("ZXing"), `${label}: engine ${engine}`);
    const log = await page.evaluate(() => JSON.parse(localStorage.getItem("bcts.log")));
    assert.equal(log.at(-1).result, expect === "full" ? "full" : "none", `${label}: log result`);

    if (expect === "full") {
      await page.click("#result-continue");
      await new Promise((r) => setTimeout(r, 4000));
      assert.equal(await isShown(page, "#result"), false, `${label}: re-alarmed right after dismiss`);
    }
    // Same bag stays in view the whole time: logged exactly once.
    const logAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("bcts.log")));
    assert.equal(logAfter.length, 1, `${label}: same tag logged ${logAfter.length}x`);
    await page.click("#stop-scan");
    assert.equal(await isShown(page, "#scanner"), false);
    assert.deepEqual(errors.filter((e) => !e.includes("favicon")), [], `${label}: page errors`);
    console.log(`✔ ${label}: ${expect} in ${ms} ms, ${readMs} (${engine})`);
  } finally {
    await browser.close();
  }
}

// --- scenarios ------------------------------------------------------------------
try {
  const gen = await launch();
  const videos = {
    full: await makeVideo(gen, "full", barcodeSvg("0126123456")),
    near: await makeVideo(gen, "near", barcodeSvg("0126123499")),
    none: await makeVideo(gen, "none", barcodeSvg("0994777888")),
    vertical: await makeVideo(gen, "vertical", barcodeSvg("0126123456", { rotate: 90 })),
    tilted: await makeVideo(gen, "tilted", barcodeSvg("0126123456", { rotate: 8, module: 2, blur: 0.6 })),
    small: await makeVideo(gen, "small", barcodeSvg("0126123456", { module: 2 })),
  };
  await gen.close();

  const WL = "0126123456\n0990000001";
  await scanScenario(videos.full, WL, "full", "ketemu");
  await scanScenario(videos.near, WL, "near", "mirip-diwarnai");
  await scanScenario(videos.none, WL, "none", "bukan-atensi");
  await scanScenario(videos.vertical, WL, "full", "barcode-tegak");
  await scanScenario(videos.tilted, WL, "full", "barcode-miring-buram");
  await scanScenario(videos.small, WL, "full", "barcode-kecil");

  // Android path: a stand-in BarcodeDetector (Windows Chrome has none) that
  // replays a scripted sequence of raw values, one per frame.
  async function nativeScenario(sequence, label, check) {
    const browser = await launch(videos.none);
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument((seq) => {
        let i = 0;
        window.BarcodeDetector = class {
          static async getSupportedFormats() { return ["itf", "code_128", "qr_code", "data_matrix"]; }
          async detect() {
            await new Promise((r) => setTimeout(r, 30));
            const v = i < seq.length ? seq[i++] : null; // then nothing in view
            return v === null ? [] : [].concat(v).map((rawValue) => ({ rawValue }));
          }
        };
      }, sequence);
      await page.setViewport({ width: 400, height: 860, isMobile: true, hasTouch: true });
      await page.goto(URL_BASE, { waitUntil: "networkidle0" });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: "networkidle0" });
      await page.click("#add-open");
      await page.$eval("#bulk-input", (el) => { el.value = "0126123456"; });
      await page.click("#add-form button[type=submit]");
      await page.click('nav button[data-nav="scan"]');
      await new Promise((r) => setTimeout(r, 2500));
      assert.ok((await page.$eval("#engine-info", (e) => e.textContent)).includes("bawaan Chrome"), `${label}: engine`);
      await check(page);
      console.log(`✔ ${label}`);
    } finally {
      await browser.close();
    }
  }

  await nativeScenario(Array(40).fill("0126123456"), "android: tag stabil → cocok", async (page) => {
    assert.equal(await page.$eval("#result-title", (e) => e.textContent), "Ketemu!");
  });
  // Misread flapping between the true value and a 1-digit error: never two identical
  // reads in a row, so it must never alarm and never log.
  await nativeScenario(
    Array.from({ length: 60 }, (_, i) => (i % 2 ? "0126123456" : "0126123457")),
    "android: salah baca bergantian → tidak pernah alarm",
    async (page) => {
      assert.equal(await isShown(page, "#result"), false);
      assert.equal(await page.evaluate(() => localStorage.getItem("bcts.log")), null);
    },
  );
  // A misread value seen twice in a row IS accepted as that value — but it only
  // alarms if that wrong number happens to be on the list. Here it is not.
  await nativeScenario(
    ["0126123457", "0126123457", null, null, ...Array(20).fill(null)],
    "android: salah baca konsisten → bukan atensi, bukan ketemu",
    async (page) => {
      assert.equal(await isShown(page, "#result"), false);
      const log = await page.evaluate(() => JSON.parse(localStorage.getItem("bcts.log")));
      assert.deepEqual(log.map((e) => e.result), ["none"]);
    },
  );
  // Non-tag values (letters, wrong length) are ignored entirely.
  await nativeScenario(
    Array.from({ length: 40 }, (_, i) => ["ABC0126123456", "012612345", "01261234567", "https://x"][i % 4]),
    "android: kode bukan tag diabaikan",
    async (page) => {
      assert.equal(await isShown(page, "#result"), false);
      assert.equal(await page.evaluate(() => localStorage.getItem("bcts.log")), null);
    },
  );
  // Same bag read, lost, read again with nothing else in between: logged once.
  // A different bag in between: both logged, the first one again after it
  // (once the 3 s repeat guard for back-and-forth reads has passed).
  await nativeScenario(
    [...Array(10).fill("0994777888"), ...Array(40).fill(null), ...Array(10).fill("0994777888"),
      ...Array(10).fill("0990111222"), ...Array(120).fill(null), ...Array(10).fill("0994777888")],
    "android: tag sama tidak tercatat dua kali",
    async (page) => {
      await new Promise((r) => setTimeout(r, 6000));
      const log = await page.evaluate(() => JSON.parse(localStorage.getItem("bcts.log")));
      assert.deepEqual(log.map((e) => e.number), ["0994777888", "0990111222", "0994777888"]);
      assert.equal(await page.$eval("#scan-count strong", (e) => e.textContent), "2", "unique count");
    },
  );
  // Two bags in one frame: both confirmed, the listed one alarms.
  await nativeScenario(
    Array(40).fill(["0994777888", "0126123456"]),
    "android: dua tag dalam satu frame",
    async (page) => {
      assert.equal(await page.$eval("#result-title", (e) => e.textContent), "Ketemu!");
    },
  );

  // Officer taps "Berhenti scan" while the camera is still opening: the camera
  // must not come back on behind the screen.
  {
    const browser = await launch(videos.full);
    try {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (c) => new Promise((r) => setTimeout(r, 1200)).then(() => real(c));
      });
      await page.goto(URL_BASE, { waitUntil: "networkidle0" });
      await page.click('nav button[data-nav="scan"]');
      await new Promise((r) => setTimeout(r, 200));
      await page.click("#stop-scan");
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(await isShown(page, "#scanner"), false, "scanner stays closed");
      assert.equal(await page.$eval("#video", (v) => v.srcObject), null, "camera released");
      // And a normal start afterwards still works.
      await page.click("#start-scan");
      await page.waitForFunction(() => document.getElementById("video").srcObject, { timeout: 10000 });
      console.log("✔ berhenti saat kamera masih dibuka");
    } finally {
      await browser.close();
    }
  }

  // Mark found from the alarm, offline reload, log view.
  const browser = await launch(videos.full);
  try {
    const { page, errors } = await openApp(browser, WL);
    await page.waitForSelector("#result:not([hidden])", { timeout: 15000 });
    await page.click("#result-found");
    const wl = await page.evaluate(() => JSON.parse(localStorage.getItem("bcts.watchlist")));
    assert.equal(wl.find((e) => e.number === "0126123456").found, true, "marked found from result");
    assert.ok((await page.$eval("#scan-count", (e) => e.textContent)).includes("1 ketemu"), "counter");
    await page.click("#stop-scan");
    assert.equal(await page.$eval("#scanned-total", (e) => e.textContent), "1", "scanned total");

    // Service worker ready → offline reload must still work, including ZXing.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "networkidle0" }); // controlled by SW now
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "load" });
    assert.equal(await page.title(), "BCTS", "offline reload");
    const zxingOffline = await page.evaluate(async () => (await fetch("vendor/zxing-0.23.0.min.js")).ok);
    assert.ok(zxingOffline, "ZXing cached for offline");
    await page.click('nav button[data-nav="scan"]');
    await page.waitForFunction(() => document.getElementById("scan-ms").textContent.startsWith("terbaca"), { timeout: 15000 });
    await page.setOfflineMode(false);

    await page.waitForSelector("#result:not([hidden])"); // same tag, already found: still alarms
    await page.click("#result-continue");
    await page.click("#stop-scan"); // the camera covers the nav while it runs
    assert.equal(await isShown(page, "#scanner"), false, "camera off");
    // Same tag again after reload: still counted once.
    assert.equal(await page.$eval("#scanned-total", (e) => e.textContent), "1", "count survives reload, no double count");
    await page.click("#reset-count");
    await page.click("#reset-count");
    assert.equal(await page.$eval("#scanned-total", (e) => e.textContent), "0", "reset count");
    await page.click('nav button[data-nav="log"]');
    await page.screenshot({ path: `${OUT}log.png` });
    const metas = await page.$$eval("#log-list li .log-meta", (m) => m.map((x) => x.textContent));
    assert.ok(metas.some((t) => t.startsWith("Match · ")), "Match label");
    assert.deepEqual(errors.filter((e) => !e.includes("favicon")), [], "page errors");
    console.log("✔ tandai ketemu, penghitung, offline, log");
  } finally {
    await browser.close();
  }

  // Daftar: digits only, focused, multi-line paste, swipe-to-delete, clear all.
  {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 400, height: 860, isMobile: true, hasTouch: false });
      await page.goto(URL_BASE, { waitUntil: "networkidle0" });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: "networkidle0" });
      // Page shows only the list and a round + centred above the nav.
      assert.equal(await page.$eval("#add-dialog", (d) => d.open), false, "form hidden on the page");
      const fab = await page.$eval("#add-open", (e) => e.getBoundingClientRect().toJSON());
      const navTop = await page.$eval("nav", (e) => e.getBoundingClientRect().top);
      assert.ok(Math.abs(fab.left + fab.width / 2 - 200) < 2 && fab.bottom < navTop, "fab centred above nav");
      await page.click("#add-open");
      assert.equal(await page.evaluate(() => document.activeElement.id), "bulk-input", "focused when the dialog opens");
      await page.keyboard.type("GA0126abc123456");
      assert.equal(await page.$eval("#bulk-input", (e) => e.value), "0126123456", "letters stripped");
      await page.$eval("#bulk-input", (e) => { e.value = ""; });

      // WhatsApp-style multi-line paste into the one-line field.
      await page.$eval("#bulk-input", (el) => {
        const data = new DataTransfer();
        data.setData("text/plain", "Mohon dicari:\n0126123456\n0 990 654321\r\n0657111222\n123456");
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await page.click("#add-form button[type=submit]");
      const numbers = () => page.evaluate(() => JSON.parse(localStorage.getItem("bcts.watchlist")).map((e) => e.number));
      assert.deepEqual(await numbers(), ["0126123456", "0990654321", "0657111222"], "multi-line paste");
      assert.equal(await page.$eval("#bulk-input", (e) => e.value), "123456", "rejected stays in field");
      assert.equal(await page.evaluate(() => document.activeElement.id), "bulk-input", "focus kept");
      assert.equal(await page.$eval("#add-dialog", (d) => d.open), true, "dialog stays open with a rejected number");
      await page.screenshot({ path: `${OUT}daftar-modal.png` });
      await page.mouse.click(200, 700); // tap outside the dialog
      assert.equal(await page.$eval("#add-dialog", (d) => d.open), false, "tap outside closes");
      assert.equal(await page.$$eval("#watchlist button", (b) => b.map((x) => x.textContent).join()), "Hapus,Hapus,Hapus", "only Hapus buttons");

      // Swipe the second row left, tap Hapus.
      const row = await page.$$("#watchlist .entry-number");
      const box = await row[1].boundingBox();
      await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width - 20 - i * 12, box.y + box.height / 2);
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: `${OUT}daftar-geser.png` });
      const del = await page.$$("#watchlist .row-delete");
      const delBox = await del[1].boundingBox();
      await page.mouse.click(delBox.x + delBox.width / 2, delBox.y + delBox.height / 2);
      assert.deepEqual(await numbers(), ["0126123456", "0657111222"], "swipe delete");

      // A tap without swiping deletes nothing.
      const r0 = await (await page.$$("#watchlist .entry-number"))[0].boundingBox();
      await page.mouse.click(r0.x + r0.width - 40, r0.y + r0.height / 2);
      assert.equal((await numbers()).length, 2, "plain tap keeps row");

      // Paste button floats inside the field.
      await page.click("#add-open");
      const inBox = await page.$eval(".input-wrap input", (e) => e.getBoundingClientRect().toJSON());
      const pBox = await page.$eval("#paste", (e) => e.getBoundingClientRect().toJSON());
      assert.ok(pBox.left > inBox.left && pBox.right < inBox.right && pBox.top > inBox.top && pBox.bottom < inBox.bottom, "paste inside field");
      assert.equal(Math.round(inBox.right - pBox.right), Math.round(pBox.top - inBox.top), "paste inset symmetric");
      await page.keyboard.press("Escape");

      // Hold a row to select it; tap another to add it; Batal clears.
      const action = () => page.$eval("#select-action", (e) => e.textContent);
      assert.equal(await action(), "Pilih semua");
      const hold = async (i) => {
        const b = await (await page.$$("#watchlist .entry-number"))[i].boundingBox();
        await page.mouse.move(b.x + 40, b.y + b.height / 2);
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 700));
        await page.mouse.up();
      };
      const tapRow = async (i) => {
        const b = await (await page.$$("#watchlist .entry-number"))[i].boundingBox();
        await page.mouse.click(b.x + 40, b.y + b.height / 2);
      };
      await hold(0);
      assert.equal(await action(), "Hapus (1)", "hold selects");
      await tapRow(1);
      assert.equal(await action(), "Hapus (2)", "tap adds");
      await tapRow(1);
      assert.equal(await action(), "Hapus (1)", "tap removes");
      await page.click("#select-cancel");
      assert.equal(await action(), "Pilih semua", "cancel");

      // Hold one, delete it with confirmation.
      await hold(1);
      await page.click("#select-action");
      assert.equal((await numbers()).length, 2, "first tap only asks");
      await page.click("#select-action");
      assert.deepEqual(await numbers(), ["0126123456"], "deleted selected");

      // Only the list scrolls: fill it, scroll it, the form must not move.
      const many = Array.from({ length: 30 }, (_, i) => `0990${String(100000 + i)}`).join(", ");
      await page.click("#add-open");
      await page.$eval("#bulk-input", (e, v) => { e.value = v; }, many);
      await page.click("#add-form button[type=submit]");
      const formTop = await page.$eval("#list-head", (e) => e.getBoundingClientRect().top);
      await page.$eval("#watchlist", (e) => { e.scrollTop = 400; });
      await page.evaluate(() => window.scrollTo(0, 400));
      assert.ok(await page.$eval("#watchlist", (e) => e.scrollTop > 0), "list scrolls");
      assert.equal(await page.evaluate(() => window.scrollY), 0, "page itself does not scroll");
      assert.equal(await page.$eval("#list-head", (e) => e.getBoundingClientRect().top), formTop, "header fixed");
      await page.screenshot({ path: `${OUT}daftar-panjang.png` });

      // Pilih semua → Hapus (n) → confirm.
      await page.click("#select-action");
      assert.equal(await action(), "Hapus (31)");
      await page.screenshot({ path: `${OUT}daftar-pilih.png` });
      await page.click("#select-action");
      await page.click("#select-action");
      assert.deepEqual(await numbers(), [], "all deleted");
      console.log("✔ daftar: fokus, hanya angka, tempel banyak baris, geser hapus, tahan untuk pilih, pilih semua, hanya daftar yang scroll");
    } finally {
      await browser.close();
    }
  }

  console.log("SEMUA LOLOS");
} finally {
  server.kill();
}
