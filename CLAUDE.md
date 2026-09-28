# CLAUDE.md

Konteks proyek untuk Claude Code. Baca file ini lebih dulu, lalu `PRD.md`, lalu `plan.md`.

---

## Apa yang dibangun

PWA untuk memindai barcode claim tag bagasi dan memberi alarm saat nomornya cocok dengan daftar yang sedang dicari. Dipakai satu petugas ground handling di area bagasi bandara, di HP Android, sering tanpa sinyal.

Bangun mengikuti tahapan di `plan.md` secara berurutan. Setiap tahap harus bisa dijalankan dan dites sebelum lanjut.

## Aturan yang tidak boleh dilanggar

**Salah baca yang lolos sebagai "cocok" adalah kegagalan terburuk.** Barcode ITF tidak punya check digit, jadi satu digit salah baca bisa lolos diam-diam dan membuat petugas mengambil bagasi orang lain. Konfirmasi dua kali baca berturut-turut wajib ada dan tidak boleh dihilangkan demi kecepatan.

**Tanpa server.** Tidak ada backend, tidak ada API call, tidak ada analytics, tidak ada CDN untuk aset kritis. Semua harus berjalan dari file lokal setelah di-cache. Jika ZXing-js dipakai sebagai fallback, sertakan filenya di repo, jangan tarik dari CDN saat runtime.

**Tanpa data pribadi.** Hanya simpan nomor tag. Tidak ada nama penumpang, nomor penerbangan, atau apa pun yang mengidentifikasi orang.

**Bahasa antarmuka: Indonesia.** Komentar kode boleh Inggris.

## Keputusan setelah uji lapangan (v3, 2026-09-27)

Menggantikan bagian PRD yang bertentangan:

- Daftar hanya menerima nomor 10 angka. Nomor seri 6 angka dan status "cocok sebagian" dihapus.
- Hanya cocok penuh yang memberi alarm, dengan judul "Ketemu!"; di log berlabel "Match". Tag lain di log tanpa label, hanya nomor dan jam.
- Nomor yang mirip (≥8 dari 10 angka sama di posisi yang sama) tidak memberi alarm; angkanya diwarnai hijau (sama) dan merah (beda) di bawah kotak scan.
- Tidak ada input manual / tombol Ketik nomor. Atensi hanya diisi di halaman Daftar.
- Membuka tab Scan langsung menyalakan kamera. Setiap baca berbunyi beep, layar berkedip, dan waktu baca ("terbaca N ms") ditampilkan.
- Tag yang sama tidak dicatat ulang sampai ada tag lain yang terbaca.
- Daftar (v5): halaman hanya berisi daftar + tombol + bulat di tengah bawah; kolom nomor (Paste di dalamnya) dan Tambah ke daftar ada di modal. Hanya daftar yang scroll. Geser kiri untuk hapus satu; tahan untuk memilih, lalu Pilih semua / Hapus (N) di kanan atas dengan konfirmasi. Tandai ketemu hanya dari layar Ketemu!.
- Scan (v7): halaman Scan selalu kamera, tanpa tombol Mulai/Berhenti; kamera mati saat pindah halaman. Geser kiri/kanan pindah halaman, kecuali geser di atas baris daftar (itu untuk Hapus). Semua konfirmasi hapus/reset lewat modal, bukan tekan-dua-kali.
- Tampilan (v8): halaman bergeser mengikuti jari lalu meluncur (seperti Instagram); senter berupa tombol bulat berikon; mode gelap otomatis mengikuti setelan HP (warna lewat token di :root).
- Tanpa bunyi (v9): semua audio dihapus karena iPhone menampilkan pemutar musik di layar kunci. Tanda baca = nomor pop-in di atas tumpukan 3 hasil terakhir + kilat layar; Android juga bergetar. Catatan Web Audio di Jebakan teknis tidak berlaku lagi, jangan tambahkan audio kembali tanpa persetujuan.
- Penghitung (v5): tiap tag dihitung sekali untuk dicocokkan dengan manifest; bertahan sampai Mulai hitungan baru.
- Hemat panas (v10): saat tak ada kode, baca ~10x/detik (tiap frame begitu ada kode); kamera 720p; hanya pita di sekitar kotak pemandu yang dibaca, jadi tag di luar kotak sengaja tidak terbaca; kotak pemandu persegi supaya muat barcode mendatar maupun tegak; iPhone memutar gambar di frame berselang-seling (tanpa TRY_HARDER); 30 detik tanpa tag → kamera dijeda, tombol "Lanjut scan". Status Scan hanya "X discan"; Daftar "1/1 atensi ketemu".
- Pembaca (v11): ZXing-js diganti zxing-cpp WASM (`vendor/zxing-wasm-3.1.4-reader.js` + `.wasm`, lokal, bukan CDN), ~15 ms per frame, sudah mencoba versi diputar sendiri. Kamera: zoom 1,5x bila didukung, Android dipindah ke kamera belakang utama ("camera2 0") bila yang terbuka lensa lain, senter menyala otomatis bila gambar gelap 2 detik (sampai petugas menyentuh tombol senter). Pencahayaan manual pendek sengaja belum dipakai (risiko gambar gelap tanpa uji di HP). Konfirmasi instan dari dua barcode di satu tag DITOLAK: zxing-cpp bisa melaporkan satu barcode dua kali dan menggabungkan dua barcode bertumpuk jadi satu, jadi nilai kembar dalam satu frame tetap dihitung sekali.

## Jebakan teknis yang sudah diketahui

Ini hal-hal yang akan memakan waktu kalau ditemukan sendiri saat debugging:

**ITF harus diaktifkan secara eksplisit.** Sebagian besar library scanner menonaktifkan Interleaved 2 of 5 secara default. Kalau barcode tag bagasi "tidak terbaca", ini penyebab pertama yang harus dicek — bukan pencahayaan atau fokus kamera.

**Kamera butuh HTTPS.** `http://localhost` dianggap secure context, tetapi `http://192.168.x.x:8000` dari HP tidak. Kamera akan ditolak tanpa pesan yang jelas. Gunakan Cloudflare Tunnel atau GitHub Pages untuk pengujian di HP. Jangan buang waktu men-debug kode kamera sebelum memastikan halaman diakses lewat HTTPS.

**Audio terblokir tanpa interaksi pengguna.** `AudioContext` harus dibuat atau di-`resume()` di dalam handler tap, bukan saat halaman dimuat. Lakukan saat pengguna menekan "Mulai scan". Kalau tidak, alarm akan diam tanpa error apa pun.

**Gunakan Web Audio, bukan file audio.** Oscillator lebih andal, tidak menambah aset yang harus di-cache, dan tidak terkena kebijakan autoplay untuk elemen media.

**Torch tidak universal.** Cek dulu `track.getCapabilities().torch` sebelum menampilkan tombol senter. Sembunyikan tombolnya jika tidak didukung, jangan tampilkan tombol yang tidak berfungsi.

**Layar mati saat scanning.** Pakai Wake Lock API saat mode scan aktif, lepaskan saat keluar dari mode scan supaya baterai tidak habis percuma.

**`requestAnimationFrame`, bukan `setInterval`.** Loop pemindaian dengan `setInterval` akan menumpuk saat perangkat melambat.

## Data referensi: format nomor tag

Standar IATA license plate, 10 digit:

```
0  657  123456
│   │      └── nomor seri (6 digit)
│   └───────── kode numerik maskapai (3 digit)
└───────────── digit leading (umumnya 0)
```

Contoh kode numerik maskapai Indonesia untuk pengujian: Garuda 126, Lion Air 990, Sriwijaya 657, Citilink 141, Batik Air 994.

Angka-angka ini untuk membuat data uji yang realistis. Aplikasi **tidak boleh** melakukan validasi terhadap daftar kode maskapai — daftar seperti itu akan usang dan menolak tag yang sebenarnya sah.

## Konvensi kode

- JavaScript vanilla, tanpa framework, tanpa bundler, tanpa langkah build.
- Nama fungsi dan variabel deskriptif dalam bahasa Inggris.
- Pisahkan logika murni (normalisasi, parsing, pencocokan) dari kode yang menyentuh DOM dan kamera, supaya logika inti bisa diuji sendiri.
- Tulis logika pencocokan sebagai fungsi bebas efek samping. Ini bagian paling kritis di aplikasi; harus bisa dibaca dan diverifikasi tanpa menjalankan kamera.
- Tangani error dengan pesan yang memberi tahu apa yang harus dilakukan, bukan sekadar apa yang gagal. "Izin kamera ditolak. Buka pengaturan situs di Chrome untuk mengizinkan." lebih berguna daripada "Camera error".

## Panduan tampilan

Baca bagian 7 di `PRD.md` untuk arah desain lengkap. Poin yang paling sering dilanggar:

- Satu hal dominan per layar. Jangan potong konten menjadi kartu-kartu seragam.
- Warna hanya untuk status, tidak untuk dekorasi. Tiga status, tiga warna.
- Jangan pakai merah untuk hasil "tidak cocok" — itu keadaan normal, bukan error.
- Angka pakai *tabular figures* dan dikelompokkan `0 657 123456`.
- Target sentuh minimum 56px, tombol utama di jangkauan ibu jari.
- Jangan pakai label huruf kapital semua di atas setiap bagian.

## Cara menjalankan

```bash
# server lokal
python3 -m http.server 8000

# untuk tes di HP (wajib HTTPS)
cloudflared tunnel --url http://localhost:8000
```

Buka URL HTTPS yang diberikan di Chrome Android, lalu pasang ke home screen lewat menu browser.

## Definisi selesai untuk MVP

1. Barcode ITF pada tag asli terbaca di bawah 2 detik pada pencahayaan normal.
2. Tempel 20 nomor sekaligus berfungsi tanpa penyuntingan manual.
3. Alarm cocok terasa tanpa melihat layar.
4. Nol salah baca yang lolos sebagai cocok.
5. Berfungsi penuh dalam mode pesawat.
