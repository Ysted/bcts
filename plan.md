# Plan — Baggage Tag Watchlist Scanner

Rencana implementasi. Baca `PRD.md` dulu untuk memahami apa yang dibangun, lalu `CLAUDE.md` untuk aturan teknis dan jebakan yang harus dihindari.

---

## Keputusan arsitektur

**PWA satu halaman, dijalankan di Chrome Android.**

Alasan memilih web daripada native:

- Tidak perlu Play Store, tidak perlu proses build, tidak perlu Android Studio. Bisa diiterasi di lokasi saat uji coba.
- Chrome Android punya `BarcodeDetector` API bawaan yang mendukung ITF, jadi tidak perlu library berat.
- Jalur upgrade tetap terbuka: kalau akurasi pembacaan kurang, kode yang sama bisa dibungkus Capacitor + ML Kit tanpa menulis ulang UI dan logika pencocokan.

Alasan tidak mendukung iOS di MVP: Safari iOS tidak mendukung `BarcodeDetector`, sehingga pengalamannya jauh lebih lambat dan tidak andal. Menargetkan dua platform sekaligus akan menggandakan pekerjaan demi pengguna yang belum ada.

**Stack:** HTML + CSS + JavaScript vanilla, tanpa framework, tanpa bundler. Aplikasi ini kecil dan berumur panjang; framework hanya menambah beban tanpa memberi manfaat di sini.

**Penyimpanan:** `localStorage`. Datanya kecil (beberapa puluh nomor) dan tidak butuh query.

---

## Struktur file

```
/
├── index.html          # struktur + inline CSS jika masih terkelola
├── app.js              # semua logika
├── styles.css          # pisahkan jika CSS > 200 baris
├── sw.js               # service worker untuk offline
├── manifest.json       # agar bisa di-install ke home screen
└── icons/              # ikon PWA 192px dan 512px
```

Boleh digabung jadi satu file HTML jika total tetap di bawah ~800 baris. Prioritaskan kemudahan dibaca, bukan jumlah file.

---

## Tahapan

Kerjakan berurutan. Setiap tahap harus bisa dijalankan dan dites sebelum lanjut ke tahap berikutnya — jangan bangun semuanya lalu tes di akhir.

### Tahap 1 — Fondasi dan watchlist

Belum ada kamera sama sekali. Tujuannya memastikan logika data benar dulu.

- Struktur halaman dengan tiga tampilan: Daftar, Scan, Log. Navigasi bawah.
- Fungsi normalisasi nomor: buang non-digit, validasi panjang 6 atau 10.
- Fungsi parsing tempel massal: pisah berdasarkan baris baru, koma, titik koma, spasi.
- Simpan dan muat watchlist dari `localStorage`.
- Tampilkan daftar, hapus satu, hapus semua, tandai sudah ketemu.
- Tangani duplikat dan input tidak valid dengan pesan yang jelas.

**Tes tahap 1:** tempel 20 nomor campuran (ada yang 6 digit, ada yang 10, ada duplikat, ada yang mengandung tanda hubung, ada yang kosong). Semua harus tertangani tanpa error, dan hitungannya benar.

### Tahap 2 — Logika pencocokan

Masih tanpa kamera. Bangun dan uji logika inti secara terisolasi.

- Fungsi `match(scannedNumber, watchlist)` yang mengembalikan `full`, `partial`, atau `none`.
- `full`: 10 digit identik.
- `partial`: 6 digit terakhir sama tetapi kode maskapai berbeda.
- Entri watchlist yang hanya 6 digit dicocokkan terhadap 6 digit terakhir hasil scan, dan hasilnya dihitung sebagai `partial` — karena kode maskapainya memang tidak diketahui.
- Sediakan input teks sementara untuk mensimulasikan hasil scan, supaya logika bisa diuji tanpa kamera.

**Tes tahap 2:** buat daftar kasus uji tertulis, termasuk kasus batas — nomor dengan leading zero, dua entri watchlist yang cocok sebagian dengan satu scan, dan scan yang cocok penuh dengan satu entri sekaligus cocok sebagian dengan entri lain. Pastikan cocok penuh selalu menang.

### Tahap 3 — Kamera dan pembacaan barcode

- Minta izin kamera, gunakan `facingMode: 'environment'`.
- Deteksi dukungan `BarcodeDetector` lewat `BarcodeDetector.getSupportedFormats()`.
- Aktifkan format: `itf`, `code_128`, `data_matrix`, `qr_code`.
- Jika `BarcodeDetector` tidak tersedia, muat ZXing-js sebagai fallback dan tetap aktifkan ITF secara eksplisit.
- Loop pemindaian memakai `requestAnimationFrame`, bukan `setInterval`.
- **Konfirmasi dua kali baca:** hasil hanya diterima setelah dua pembacaan berturut-turut menghasilkan nilai identik. ITF tidak punya checksum, jadi ini satu-satunya perlindungan terhadap salah baca.
- Cooldown 3 detik per nomor.
- Tombol senter lewat `applyConstraints({ advanced: [{ torch: true }] })`, sembunyikan tombolnya jika perangkat tidak mendukung.
- Wake Lock supaya layar tidak mati.

**Tes tahap 3:** cetak beberapa barcode ITF 10 digit di kertas, atau pakai tag bagasi asli. Uji dalam kondisi terang dan redup, tag datar dan melengkung.

### Tahap 4 — Alarm dan tampilan hasil

- Unlock `AudioContext` saat pengguna menekan "Mulai scan".
- Bunyi dibuat lewat oscillator Web Audio, nada berbeda untuk cocok penuh dan cocok sebagian.
- Getar: pola panjang untuk cocok penuh, dua pendek untuk cocok sebagian.
- Layar hasil penuh, nomor sangat besar dengan pengelompokan `0 657 123456`.
- Untuk cocok sebagian, tampilkan nomor hasil scan dan nomor watchlist bersebelahan, dengan digit yang berbeda ditandai.
- Hasil bertahan sampai pengguna menekan tombol lanjut.
- Tombol "Tandai sudah ketemu" langsung dari layar hasil.

**Tes tahap 4:** taruh HP di meja, scan tanpa melihat layar. Apakah kamu tahu ada yang cocok hanya dari suara dan getaran?

### Tahap 5 — Input manual dan log

- Keypad numerik besar untuk memasukkan nomor saat barcode tidak terbaca.
- Hasil input manual melewati logika pencocokan yang sama persis.
- Log sesi: nomor, waktu, hasil.
- Salin log ke clipboard sebagai teks siap kirim.

### Tahap 6 — Offline dan instalasi

- `manifest.json` dengan `display: standalone`, orientasi portrait, ikon 192 dan 512.
- Service worker dengan strategi cache-first untuk semua aset statis.
- Verifikasi: aktifkan mode pesawat, tutup aplikasi, buka lagi — harus tetap berfungsi penuh.

### Tahap 7 — Pengujian lapangan

Serahkan ke pengguna. Jangan tambah fitur sebelum sesi ini selesai. Catat apa yang sebenarnya menghambat, lalu putuskan prioritas berikutnya berdasarkan itu.

---

## Cara mengetes di HP Android

**Ini jebakan yang akan memakan waktu kalau tidak diantisipasi.** Akses kamera memerlukan *secure context*. `http://localhost` dianggap aman, tetapi membuka `http://192.168.x.x:8000` dari HP **tidak** dianggap aman, sehingga kamera akan ditolak tanpa pesan error yang jelas.

Pilihan yang berfungsi:

1. **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:8000`, memberi URL HTTPS publik sementara. Paling cepat untuk iterasi.
2. **ngrok** — alternatif serupa.
3. **GitHub Pages** — push ke repo, aktifkan Pages. Cocok untuk versi yang sudah stabil dan untuk dipasang permanen di HP petugas.

Sarankan Cloudflare Tunnel selama pengembangan, GitHub Pages untuk versi uji lapangan.

---

## Urutan prioritas saat ada konflik

Jika terpaksa memilih, dahulukan yang lebih atas:

1. **Tidak ada salah baca yang lolos sebagai cocok.** Petugas salah mengambil bagasi lebih buruk daripada aplikasi lambat.
2. **Tetap berfungsi tanpa sinyal.**
3. **Alarm terasa tanpa melihat layar.**
4. **Kecepatan scan.**
5. Kerapian tampilan.
