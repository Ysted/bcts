// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBulkInput, formatTagNumber, summarizeAddResult, matchTag, isValidScan,
  createReadConfirmer, createCooldown, diffDigits, formatLogText,
} from "./logic.js";

const list = (...numbers) => numbers.map((number) => ({ number, kind: number.length === 10 ? "full" : "serial", found: false }));

test("match: cocok penuh 10 digit identik", () => {
  const wl = list("0126123456", "0990000001");
  const r = matchTag("0126123456", wl);
  assert.equal(r.result, "full");
  assert.equal(r.full.number, "0126123456");
  assert.equal(r.partials.length, 0);
});

test("match: seri sama, maskapai beda → sebagian", () => {
  const r = matchTag("0657123456", list("0126123456"));
  assert.equal(r.result, "partial");
  assert.equal(r.full, null);
  assert.deepEqual(r.partials.map((e) => e.number), ["0126123456"]);
});

test("match: digit leading beda → sebagian, bukan penuh", () => {
  assert.equal(matchTag("1126123456", list("0126123456")).result, "partial");
});

test("match: entri 6 digit selalu sebagian", () => {
  const r = matchTag("0126123456", list("123456"));
  assert.equal(r.result, "partial");
});

test("match: penuh menang, sebagian lain tetap dilaporkan", () => {
  const r = matchTag("0126123456", list("0657123456", "0126123456", "123456"));
  assert.equal(r.result, "full");
  assert.equal(r.full.number, "0126123456");
  assert.deepEqual(r.partials.map((e) => e.number), ["0657123456", "123456"]);
});

test("match: dua entri sebagian untuk satu scan", () => {
  const r = matchTag("0994123456", list("0657123456", "0126123456"));
  assert.equal(r.result, "partial");
  assert.equal(r.partials.length, 2);
});

test("match: leading zero tidak hilang", () => {
  assert.equal(matchTag("0000000001", list("0000000001")).result, "full");
  assert.equal(matchTag("0000000001", list("0000000002")).result, "none");
});

test("match: satu digit beda di seri → tidak cocok", () => {
  assert.equal(matchTag("0126123457", list("0126123456")).result, "none");
});

test("match: input manual 6 digit tidak pernah jadi penuh", () => {
  const r = matchTag("123456", list("0126123456", "123456"));
  assert.equal(r.result, "partial");
  assert.equal(r.partials.length, 2);
});

test("match: daftar kosong", () => {
  assert.equal(matchTag("0126123456", []).result, "none");
});

test("scan valid hanya tepat 10 digit", () => {
  assert.ok(isValidScan("0126123456"));
  for (const bad of ["012612345", "01261234567", "A126123456", "0126 123456", "", "123456"]) {
    assert.ok(!isValidScan(bad), bad);
  }
});

test("konfirmasi: satu kali baca tidak cukup", () => {
  const confirm = createReadConfirmer();
  assert.deepEqual(confirm(["0126123456"], 0), []);
});

test("konfirmasi: dua frame berturut identik → diterima sekali", () => {
  const confirm = createReadConfirmer();
  confirm(["0126123456"], 0);
  assert.deepEqual(confirm(["0126123456"], 50), ["0126123456"]);
  assert.deepEqual(confirm(["0126123456"], 100), []); // tidak diulang selama streak
});

test("konfirmasi: salah baca di tengah memutus streak", () => {
  const confirm = createReadConfirmer();
  confirm(["0126123456"], 0);
  confirm(["0126123457"], 50);
  assert.deepEqual(confirm(["0126123456"], 100), []);
  assert.deepEqual(confirm(["0126123456"], 150), ["0126123456"]);
});

test("konfirmasi: frame kosong dilewati, jeda panjang me-reset", () => {
  const confirm = createReadConfirmer({ maxGapMs: 1000 });
  confirm(["0126123456"], 0);
  assert.deepEqual(confirm([], 30), []);
  assert.deepEqual(confirm(["0126123456"], 60), ["0126123456"]);
  const c2 = createReadConfirmer({ maxGapMs: 1000 });
  c2(["0126123456"], 0);
  assert.deepEqual(c2(["0126123456"], 2000), []);
});

test("konfirmasi: dua barcode berbeda dalam satu frame tidak saling merusak", () => {
  const confirm = createReadConfirmer();
  confirm(["0126123456", "0657000001"], 0);
  assert.deepEqual(confirm(["0126123456", "0657000001"], 50).sort(), ["0126123456", "0657000001"]);
});

test("cooldown 3 detik dan suppress", () => {
  const cd = createCooldown(3000);
  assert.ok(cd.shouldReport("A", 0));
  assert.ok(!cd.shouldReport("A", 2999));
  assert.ok(cd.shouldReport("A", 3000));
  cd.suppress("A", 3000, 10000);
  assert.ok(!cd.shouldReport("A", 12999));
  assert.ok(cd.shouldReport("A", 13000));
  assert.ok(cd.shouldReport("B", 13000));
});

test("teks log siap kirim", () => {
  const t = new Date(2026, 8, 27, 7, 5, 9).getTime();
  const text = formatLogText([
    { number: "0126123456", time: t, result: "full", source: "kamera" },
    { number: "0657123456", time: t, result: "partial", source: "kamera", partialNumbers: ["0126123456"] },
    { number: "123456", time: t, result: "partial", source: "manual", partialNumbers: ["0126123456", "123456"] },
    { number: "0994000001", time: t, result: "none", source: "kamera" },
  ]);
  assert.equal(text, [
    "Log scan bagasi",
    "27/09 07:05:09  0 126 123456  COCOK",
    "27/09 07:05:09  0 657 123456  cocok sebagian (dicari: 0 126 123456)",
    "27/09 07:05:09  123456  cocok sebagian (dicari: 0 126 123456, 123456) [ketik]",
    "27/09 07:05:09  0 994 000001  tidak dicari",
  ].join("\n"));
});

test("diffDigits rata kanan", () => {
  assert.deepEqual(diffDigits("0657123456", "0126123456"), [false, true, true, true, false, false, false, false, false, false]);
  assert.deepEqual(diffDigits("0126123456", "123456"), [true, true, true, true, false, false, false, false, false, false]);
});

test("tahap 1: tempel 20 nomor campuran", () => {
  const pasted = [
    "Mohon dicari bagasi berikut:",
    "0126123456",          // full
    "0-990-654321",        // full, pakai tanda hubung
    "0 657 111222",        // full, dikelompokkan spasi
    "0141000001, 0994000002; 0126000003", // 3 full, pemisah campuran
    "",                    // baris kosong
    "   ",
    "123456",              // serial (duplikat seri dari entri pertama, tapi beda nomor → sah)
    "654999",              // serial
    "0126123456",          // duplikat
    "0-990-654321",        // duplikat (setelah normalisasi)
    "12345",               // ditolak: 5 digit
    "01261234567",         // ditolak: 11 digit
    "0657222333 0657444555", // 2 full dipisah spasi
    "0990777888\t0141888999", // 2 full dipisah tab
    "0126000003",          // duplikat
    "0994123123",          // full
    "Tag: 0657999000",     // full, ada kata
  ].join("\n");

  const r = parseBulkInput(pasted);
  assert.equal(r.added.length, 14);
  assert.equal(r.added.filter((e) => e.kind === "full").length, 12);
  assert.equal(r.added.filter((e) => e.kind === "serial").length, 2);
  assert.equal(r.duplicates, 3);
  assert.deepEqual(r.rejected, ["12345", "01261234567"]);
  assert.ok(r.added.some((e) => e.number === "0990654321"));
  assert.ok(r.added.some((e) => e.number === "0657111222"));
});

test("duplikat terhadap daftar yang sudah ada", () => {
  const r = parseBulkInput("0126123456\n0126999999", ["0126123456"]);
  assert.equal(r.added.length, 1);
  assert.equal(r.duplicates, 1);
});

test("leading zero tetap utuh", () => {
  assert.equal(parseBulkInput("0000000001").added[0].number, "0000000001");
});

test("format dan ringkasan", () => {
  assert.equal(formatTagNumber("0657123456"), "0 657 123456");
  assert.equal(formatTagNumber("123456"), "123456");
  assert.equal(
    summarizeAddResult({ added: [{}, {}], duplicates: 1, rejected: ["12345"] }),
    "2 ditambahkan · 1 duplikat dibuang · 1 ditolak (bukan 6 atau 10 digit): 12345",
  );
  assert.equal(summarizeAddResult({ added: [], duplicates: 0, rejected: [] }), "Tidak ada nomor di teks itu.");
});
