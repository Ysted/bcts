# PRD — Baggage Tag Watchlist Scanner

**Versi:** 1.0
**Status:** Siap dibangun
**Target rilis MVP:** prototipe yang bisa dites langsung di HP Android

---

## 1. Ringkasan

Alat bantu untuk petugas ground handling mencari bagasi tertentu di antara banyak bagasi. Petugas memasukkan satu atau lebih nomor claim tag yang sedang dicari (watchlist), lalu menyapu kamera HP ke barcode tag bagasi satu per satu. Saat ada yang cocok, aplikasi memberi alarm yang jelas.

Ini bukan sistem manajemen bagasi. Ini alat verifikasi cepat di lapangan, dipakai satu orang, tanpa server, tanpa akun, dan tetap jalan tanpa sinyal.

## 2. Masalah yang diselesaikan

Saat ada bagasi mishandled atau perlu ditarik dari tumpukan, petugas harus membaca nomor 10 digit di tag satu per satu dan membandingkannya dengan daftar di kertas atau di layar HP. Membaca digit berulang-ulang itu lambat dan rawan salah — terutama karena banyak nomor tag hanya berbeda satu atau dua digit.

## 3. Pengguna

Satu petugas ground handling, memegang HP dengan satu tangan, di area bagasi. Sering berdiri, kadang membungkuk, pencahayaan bervariasi, kadang bersarung tangan. Tidak menatap layar saat menyapu barcode — perhatiannya di bagasi, bukan di HP.

Implikasi desain: target sentuh harus besar, teks harus besar, dan umpan balik saat cocok harus bisa dirasakan tanpa melihat layar.

## 4. Latar belakang teknis: format tag bagasi

Ini bagian paling penting dan paling sering salah. Baca sampai habis sebelum mulai koding.

### 4.1 Struktur nomor

Claim tag bagasi memakai standar IATA *license plate* (Resolusi 740), 10 digit:

```
0  657  123456
│   │      └── 6 digit nomor seri
│   └───────── 3 digit kode numerik maskapai (contoh: 657 = Sriwijaya, 126 = Garuda)
└───────────── 1 digit leading (umumnya 0 untuk tag normal)
```

Konsekuensi: **dua bagasi dari maskapai berbeda bisa punya 6 digit terakhir yang identik.** Pencocokan sebagian tidak boleh diperlakukan sama dengan pencocokan penuh.

### 4.2 Simbologi barcode

Urutan prioritas yang harus didukung:

1. **ITF (Interleaved 2 of 5)** — standar utama tag bagasi. Wajib. Banyak library scanner tidak mengaktifkan ITF secara default; ini penyebab nomor satu barcode "tidak terbaca".
2. **Code 128** — dipakai sebagian tag dan label internal.
3. **Data Matrix** dan **QR** — tag generasi baru dan label bagasi khusus.

### 4.3 ITF tidak punya checksum

ITF standar tidak memiliki check digit, jadi salah baca satu digit bisa lolos tanpa terdeteksi. Ini risiko nyata: petugas bisa salah ambil bagasi.

**Mitigasi wajib:** sebuah hasil scan baru diterima setelah terbaca **dua kali berturut-turut dengan nilai identik**. Tolak hasil yang panjangnya bukan 10 digit kecuali pengguna mengaktifkan mode toleran.

## 5. Fitur

### 5.1 Watchlist (kelola nomor yang dicari)

- Tempel massal: pengguna menempelkan banyak nomor sekaligus dari WhatsApp, SMS, atau email. Pemisah bisa baris baru, koma, titik koma, atau spasi.
- Input satu per satu lewat keypad numerik besar.
- Normalisasi otomatis saat input: buang spasi, tanda hubung, titik, dan huruf. Simpan hanya digit.
- Terima entri 6 digit (nomor seri saja) maupun 10 digit penuh. Tandai mana yang mana.
- Tolak dan beri tahu jika panjangnya bukan 6 atau 10 digit, jangan diam-diam dibuang.
- Buang duplikat otomatis, beri tahu berapa yang dibuang.
- Hapus satu entri, hapus semua, dan tandai entri sebagai "sudah ketemu".
- Watchlist bertahan setelah aplikasi ditutup.

### 5.2 Scanner

- Kamera belakang, fokus kontinu, pemindaian terus-menerus tanpa perlu menekan tombol tiap tag.
- Tombol senter untuk area gelap.
- Layar tidak boleh mati saat mode scan aktif.
- Cooldown: tag yang sama tidak dilaporkan ulang dalam 3 detik agar tidak beralarm berulang untuk bagasi yang sama.
- Tombol input manual selalu terlihat di layar scanner. Barcode robek atau kotor adalah kejadian harian; tanpa jalur manual, alat ini gagal justru di momen paling dibutuhkan.

### 5.3 Logika pencocokan

Tiga tingkat hasil:

| Hasil | Kondisi | Warna | Umpan balik |
|---|---|---|---|
| **Cocok penuh** | 10 digit identik dengan entri watchlist | Hijau kuat | Getar panjang, bunyi keras, layar penuh |
| **Cocok sebagian** | 6 digit terakhir sama, kode maskapai berbeda | Amber | Getar pendek ganda, bunyi berbeda, layar penuh dengan peringatan |
| **Tidak cocok** | Selain di atas | Netral abu | Tik pendek saja, tanpa mengubah layar |

Catatan penting: **jangan gunakan merah untuk "tidak cocok".** Sebagian besar scan memang tidak cocok — itu keadaan normal, bukan error. Memerahkan layar ratusan kali akan membuat petugas berhenti memperhatikan warna sama sekali.

Untuk cocok sebagian, tampilkan kedua nomor bersebelahan dengan digit yang berbeda diberi penanda visual, supaya petugas bisa memutuskan sendiri.

### 5.4 Alarm saat cocok

- Getar (Vibration API).
- Bunyi dihasilkan lewat Web Audio API, bukan file audio. AudioContext harus di-unlock saat pengguna menekan "Mulai scan", karena browser memblokir audio tanpa interaksi pengguna.
- Layar berubah penuh dengan nomor ditampilkan sangat besar.
- Hasil tetap di layar sampai pengguna menekan tombol lanjut. Jangan hilang otomatis — petugas mungkin sedang mengangkat bagasi dan baru melihat layar beberapa detik kemudian.

### 5.5 Log scan

- Daftar semua scan dalam sesi: nomor, waktu, hasil.
- Tombol salin semua ke clipboard sebagai teks, supaya bisa langsung dikirim lewat WhatsApp.
- Tombol bersihkan log.

## 6. Di luar lingkup MVP

Jangan bangun ini dulu:

- Backend, database server, akun pengguna, login.
- Sinkronisasi antar perangkat atau antar petugas.
- Foto bukti, ekspor CSV, statistik, laporan.
- Integrasi WorldTracer atau sistem maskapai.
- Dukungan iOS.
- Mode gelap, multi-bahasa, pengaturan lanjutan.

Alasan: pengguna MVP hanya satu orang dan akan mendampingi langsung saat uji coba. Prioritas fitur hampir selalu berubah setelah percobaan pertama di lapangan, jadi fitur tambahan yang dibangun sekarang kemungkinan besar terbuang.

## 7. Arah desain

Bukan dashboard, bukan aplikasi SaaS. Ini alat kerja yang dipakai sambil berdiri di antara tumpukan bagasi.

**Prinsip:** satu hal dominan di layar pada satu waktu. Saat mode scan, yang dominan adalah viewport kamera. Saat ada hasil cocok, yang dominan adalah nomornya. Tidak ada yang lain yang boleh bersaing.

**Warna:** dasar terang netral dingin agar terbaca di bawah lampu neon gudang dan cahaya siang. Warna hanya dipakai untuk status, tidak untuk dekorasi. Hijau, amber, dan abu netral — tiga status, tiga warna, tidak lebih.

**Tipografi:** angka adalah isi utama aplikasi ini. Pilih typeface dengan *tabular lining figures* supaya digit sejajar vertikal saat dua nomor dibandingkan. Tampilkan nomor 10 digit dengan pengelompokan `0 657 123456` — jauh lebih mudah dibaca dan dicocokkan manusia daripada 10 digit menempel.

**Target sentuh:** minimum 56px, karena dipakai satu tangan sambil bergerak, kadang bersarung tangan. Tombol utama di paruh bawah layar, dalam jangkauan ibu jari.

**Copywriting:** bahasa Indonesia, kalimat pendek, huruf kapital normal. Tombol menyebut akibatnya: "Mulai scan", "Tambah ke daftar", "Tandai sudah ketemu". Layar kosong adalah ajakan bertindak, bukan pesan sedih — daftar kosong berbunyi "Tempel nomor bagasi yang dicari untuk mulai", bukan "Belum ada data".

## 8. Kriteria keberhasilan

MVP dianggap berhasil jika, dalam satu sesi uji di lapangan:

1. Barcode ITF pada tag bagasi asli terbaca dalam waktu di bawah 2 detik pada kondisi pencahayaan normal.
2. Petugas bisa memasukkan 20 nomor sekaligus lewat tempel massal tanpa penyuntingan manual.
3. Saat ada bagasi yang cocok, petugas menyadarinya tanpa menatap layar.
4. Tidak ada satu pun salah baca yang lolos sebagai "cocok" (ini yang paling kritis).
5. Aplikasi tetap berfungsi penuh saat HP dalam mode pesawat.

## 9. Catatan kepatuhan

Nomor claim tag adalah data operasional yang terhubung ke penumpang. Aplikasi ini tidak boleh menyimpan nama penumpang, nomor penerbangan, atau data pribadi apa pun — cukup nomor tag. Semua data tersimpan lokal di perangkat dan tidak dikirim ke mana pun.

Penggunaan di area terbatas bandara perlu izin dari maskapai atau operator ground handling terkait. Ini urusan pengguna, bukan aplikasi, tapi sebaiknya dicatat.
