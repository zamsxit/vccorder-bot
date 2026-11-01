# 💳 VCC Order Bot

[![Node](https://img.shields.io/badge/Node.js-%3E%3D20.6-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![Telegraf](https://img.shields.io/badge/Telegraf-v4.16-2CA5E0?style=flat-square&logo=telegram&logoColor=white)](https://telegraf.js.org/) [![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com/) [![Gateway](https://img.shields.io/badge/Payment-Meldapay%20QRIS-FF6F00?style=flat-square)](https://meldapay.com) [![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

**Bot Telegram untuk penjualan Virtual Credit Card (VCC) secara otomatis.**\
Ditenagai oleh Supabase PostgreSQL sebagai sumber data tunggal dan Meldapay sebagai gateway pembayaran QRIS otomatis.

[Fitur Utama](#-fitur-utama) · [Cara Kerja](#-alur-transaksi) · [Instalasi](#-instalasi) · [Konfigurasi](#-konfigurasi) · [Database](#-struktur-database)

---

## 📌 Ringkasan

VCC Order Bot adalah **storefront otomatis berbasis Telegram** yang menangani seluruh proses penjualan VCC — mulai dari katalog produk, pembayaran QRIS, hingga pengiriman kartu — tanpa campur tangan manual.

Semua manajemen stok, pengelolaan pengguna, dan konfigurasi toko dilakukan melalui **Web Admin Panel** terpisah yang terhubung ke database yang sama.

```
Pengguna Telegram ──► [ VCC Order Bot ] ──┐
                                           ├──► [ Supabase PostgreSQL ]
Admin (Web Panel)  ────────────────────────┘       users · products · stocks · orders · settings
                              │
                              └──────────────► [ Meldapay API ]
                                               Generate & polling QRIS
```

---

## ✨ Fitur Utama

### 🛒 Katalog & Stok

- Stok dihitung secara *real-time* langsung dari tabel `stocks` menggunakan metode FIFO.
- Tampilan BIN produk dapat dikonfigurasi melalui pengaturan `displayBin`.

### 🔢 Pemilihan Kuantitas Fleksibel

- Tombol **`+`** dan **`-`** untuk penyesuaian cepat, atau tombol **Custom Pcs** untuk input jumlah secara manual.
- Batas maksimal **20 VCC per transaksi**, dengan verifikasi stok langsung ke database sebelum proses dilanjutkan.

### 💳 Pembayaran QRIS Otomatis

- Invoice dibuat secara otomatis via Meldapay API.
- Status pembayaran diperbarui setiap **3 detik** secara otomatis, dengan tombol manual untuk cek status atau batalkan pesanan.

### 🛡️ Keamanan Stok (Stock Safety)

- **Delete-on-Sell:** Data kartu disalin ke `orders.delivered_data` sebelum baris di tabel `stocks` dihapus, memastikan tidak ada data yang hilang.
- **Mutex antrean eksklusif** di memori proses untuk mencegah *double delivery* pada transaksi bersamaan.
- Mekanisme **retry penghapusan stok hingga 3 kali**, ditambah rekonsiliasi otomatis berkala sebagai jaring pengaman.

### 📢 Wajib Gabung Channel (Mandatory Channel Join)

- Memeriksa keanggotaan pengguna di channel resmi (`requiredChannel` / `channelInfo` dari tabel `settings` Supabase).
- Bot **harus menjadi admin di channel** agar dapat memeriksa keanggotaan secara otomatis.
- **Gatekeeper Mutlak:** Setiap command, pesan, dan klik tombol akan diblokir jika pengguna belum bergabung atau keluar dari channel, meskipun pengguna sudah berstatus `whitelisted`.
- Tombol gabung channel dan verifikasi instan **🔄 Saya Sudah Join**.

### 🔐 Whitelist & Verifikasi Pengguna

- Alur status pengguna: `new` → `pending` → `whitelisted` / `blocked`.
- Pengguna baru wajib memasukkan **nomor WhatsApp aktif** saat mengajukan akses.
- `OWNER_ID` secara otomatis melewati semua filter whitelist.

### 📜 Ketentuan Layanan (TOS)

- Dapat diakses kapan saja melalui `/tos`, `/ketentuan`, atau tombol menu utama.
- Memuat **4 Aturan Mutlak** mengenai penggunaan layanan, termasuk larangan penyalahgunaan Free Trial.

### 🧾 Notifikasi & Struk Transaksi

- Struk dikirim secara *real-time* ke `LOG_CHANNEL` yang telah dikonfigurasi.
- Disertai foto banner (`assets/receipt.jpg`) dan tautan profil `@username` pembeli.

### 👤 Profil & Leaderboard

- `/info` menampilkan profil pengguna, nomor WA terdaftar, status akun, dan total belanja (Rp).
- 🏆 **Top 10 Leaderboard** untuk pembeli paling loyal.

### ⚙️ Pengaturan Toko Dinamis

- Konfigurasi diambil langsung dari tabel `settings` (`appName`, `channelInfo`, `displayBin`, `maintenanceMode`).
- Nilai disanitasi secara otomatis dan di-*cache* selama 10 detik untuk efisiensi.

### 📢 Broadcast ke Semua Pengguna

- Perintah `/broadcast` eksklusif untuk owner.
- Mendukung pesan teks format HTML dan penerusan media (foto, video, dokumen).

### 🔄 High Availability

- `start.js` berfungsi sebagai **supervisor proses** yang secara otomatis me-*restart* bot jika terjadi *crash*.

---

## 📂 Struktur Direktori

```
VccOrderBot/
├── assets/                 # Media lokal (thumbnail.jpg, receipt.jpg)
├── src/
│   ├── bot.js              # Routing Telegraf: command, action, dan listener pesan
│   ├── database.js         # Client Supabase, query mapper, transaksi & rekonsiliasi
│   ├── settings.js         # Manajer pengaturan global dinamis & sanitasi nilai
│   ├── utils.js            # Logger ANSI, helper UI, batas order, format HTML
│   ├── handlers/
│   │   ├── admin.js        # Command siaran pesan (/broadcast)
│   │   ├── payment.js      # Pembuatan invoice QRIS, polling, & pembatalan
│   │   ├── shop.js         # Katalog, pemilihan kuantitas, ringkasan & riwayat
│   │   └── start.js        # Menu /start, /info, /tos, verifikasi WhatsApp
│   └── services/
│       ├── order.js        # Pemrosesan order, pengiriman kartu, mutex & background worker
│       └── payment.js      # Integrasi HTTP Meldapay (/invoice, /status, /cancel)
├── index.js                # Entry point utama, validasi env & banner status
├── start.js                # Supervisor auto-restart
└── package.json            # Dependensi (Node >= 20.6)
```

---

## 🔄 Alur Transaksi

```
[1] Checkout      →  Pilih produk  →  Tentukan qty (1–20 pcs)  →  Verifikasi stok real-time
[2] Pembayaran    →  Buat invoice Meldapay  →  Tampilkan QRIS  →  Auto-poll tiap 3 detik
[3] Pemenuhan     →  Status 'paid'  →  Lock Mutex  →  Simpan kartu ke orders  →  Kirim ke user  →  Hapus stok
[4] Notifikasi    →  Perbarui counter produk  →  Kirim struk foto ke LOG_CHANNEL
```

### Proses Otomatis di Latar Belakang

| Worker | Interval | Fungsi |
| --- | --- | --- |
| **Penyapu Kedaluwarsa** | Setiap 30 detik | Memeriksa order `pending` yang sudah lebih dari 15 menit. Melakukan satu kali pengecekan akhir ke gateway sebelum menandai order sebagai kedaluwarsa. |
| **Rekonsiliasi Stok** | Setiap 5 menit | Memindai order `completed` dalam 24 jam terakhir untuk memastikan tidak ada kartu terjual yang masih tersisa di tabel `stocks`. |

---

## 🗄️ Struktur Database

> Semua tabel dikelola di **Supabase PostgreSQL**.

| Tabel | Kolom Kunci | Keterangan |
| --- | --- | --- |
| `users` | `id`, `first_name`, `username`, `phone`, `status` | Status akun: `new` → `pending` → `whitelisted` / `blocked` |
| `products` | `id`, `name`, `price`, `bin`, `stock`, `sold` | `stock` adalah cache counter; stok riil dihitung dari tabel `stocks` |
| `stocks` | `id`, `product_id`, `data`, `added_at` | Format data kartu: `nomor\|cvv\|mm/yy`. Baris dihapus otomatis saat kartu terjual |
| `orders` | `id`, `invoice`, `trxid`, `user_id`, `total`, `delivered_data`, `status` | Riwayat transaksi lengkap dan penyimpanan permanen data kartu terkirim |
| `settings` | `key`, `value` | Konfigurasi dinamis: `appName`, `channelInfo`, `displayBin`, `maintenanceMode` |

---

## 🤖 Daftar Command

| Command | Akses | Fungsi |
| --- | --- | --- |
| `/start` | Semua pengguna | Membuka menu utama (tampilan menyesuaikan status akses pengguna) |
| `/info` | Semua pengguna | Menampilkan profil akun, nomor WA terdaftar, dan ringkasan total belanja |
| `/tos` atau `/ketentuan` | Semua pengguna | Menampilkan 4 aturan & ketentuan layanan VCC |
| `/riwayat` | Whitelist & Owner | Menampilkan riwayat pesanan dan kartu yang pernah dibeli (berpaginasi) |
| `/broadcast` | Owner saja | Mengirim siaran teks HTML atau media ke semua pengguna terdaftar |

---

## 🚀 Instalasi

### Prasyarat

- **Node.js** versi `>= 20.6`
- Akun **Supabase** dengan project yang sudah aktif
- Akun **Meldapay** dengan API key merchant yang valid
- **Bot Telegram** yang sudah dibuat via [@BotFather](https://t.me/BotFather)

### Langkah Instalasi

```bash
# 1. Clone repositori
git clone https://github.com/username/VccOrderBot.git
cd VccOrderBot

# 2. Install dependensi
npm install

# 3. Salin file konfigurasi dan isi nilainya
cp .env.example .env
nano .env

# 4. Jalankan pengecekan sintaks
npm test

# 5. Jalankan bot
npm start       # Mode produksi (dengan supervisor auto-restart)
npm run dev     # Mode pengembangan (Node --watch)
```

---

## ⚙️ Konfigurasi

Buat file `.env` di direktori root berdasarkan tabel berikut:

```env
# ── Kredensial Wajib ──────────────────────────────────────────────────────────

BOT_TOKEN=123456:ABC-DEF...              # Token bot dari @BotFather
SUPABASE_URL=https://xyz.supabase.co    # URL project Supabase
SUPABASE_KEY=eyJhbGci...                # Service Role Key Supabase (bypass RLS)
PAYMENT_BASE_URL=https://meldapay.com   # Endpoint API Meldapay
PAYMENT_API_KEY=your_meldapay_key       # API Key merchant Meldapay

# ── Konfigurasi Opsional ──────────────────────────────────────────────────────

OWNER_ID=8001361014                     # Telegram ID pemilik (bypass whitelist & akses broadcast)
LOG_CHANNEL=@YourVccLogs               # Channel Telegram tujuan struk pembelian
LOG_LEVEL=info                          # Level log: debug | info | warn | error
RECEIPT_IMAGE=assets/receipt.jpg        # Path lokal atau URL banner struk transaksi
NO_COLOR=0                              # Set ke 1 untuk menonaktifkan warna ANSI di log
```

> **Catatan:** Pastikan `SUPABASE_KEY` menggunakan **Service Role Key**, bukan `anon` key, agar bot dapat membaca dan menulis data tanpa pembatasan RLS.

---

## 🛡️ Catatan Keamanan & Operasional

**Redaksi Otomatis di Log** Logger ANSI secara otomatis menyamarkan nilai sensitif (`BOT_TOKEN`, `SUPABASE_KEY`, `PAYMENT_API_KEY`) menjadi `***` di semua output log. Data kartu mentah tidak pernah dicatat.

**Satu Instance Saja** Bot ini **harus dijalankan dalam satu instance tunggal**. Antrean pemenuhan kartu (*fulfillment queue*) berjalan di memori proses menggunakan mutex. Menjalankan lebih dari satu instance akan merusak jaminan atomisitas pemilihan stok dan berisiko menyebabkan *double delivery*.

**Backup Data** Meskipun data kartu yang terjual disimpan permanen di `orders.delivered_data`, sangat disarankan untuk melakukan backup database Supabase secara berkala sebagai langkah pencegahan.

---

## 📄 Lisensi

Didistribusikan di bawah **Lisensi MIT**. Lihat file [LICENSE](LICENSE) untuk informasi lengkap.

MIT © 2026 **ZamsXit**. All rights reserved.
