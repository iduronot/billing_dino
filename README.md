# 🦖 Dino-Bill — ISP Management System

Sistem manajemen billing dan operasional ISP (Internet Service Provider) berbasis **Node.js + Express + MySQL**. Dirancang untuk berjalan **autopilot penuh** — dari pembuatan invoice, isolir otomatis, hingga notifikasi WhatsApp & Telegram — semua berjalan tanpa campur tangan manual.

---

## 🆕 Pembaruan Terbaru

### v2.7 — Peta Interaktif & Notifikasi SLA Kritis (September 2026)
- 🗺 **Koordinat pelanggan otomatis dari PPPoE MikroTik** — parsing nama secret `Nama@-7.xxx,111.xxx` langsung ke `customers.lat/lng` (700+ pelanggan terpetakan tanpa input manual)
- 📍 **Popup detail pelanggan di peta** — klik marker → detail lengkap: telepon, paket + harga, username PPPoE, alamat, status, badge tunggakan/lunas (lazy-load dari server)
- 🛣 **Rute dari kantor pusat** — tombol di popup pelanggan menggambar jalur kantor pusat → lokasi user (via jalan OSRM, fallback garis lurus + estimasi km)
- 🏢 **Marker kantor pusat** di semua halaman peta (`/map` & `/fo`), pusat tampilan peta otomatis ke kantor
- 🔗 **Tombol "Rute" di PPPoE Active** — dari list user aktif langsung buka peta dengan rute tergambar (`/map?route=lat,lng&name=`)
- 🧭 **Cross-reference PPPoE Active diperbaiki** — pencocokan user aktif ↔ pelanggan kini juga berdasarkan nama secret (bukan hanya `pppoe_username`)
- 🗺 **Peta `/map` beralih ke OpenStreetMap** — tanpa watermark, zoom maksimal 19
- 🔴 **Notifikasi Telegram user kritis (SLA)** — daftar ONU uptime < 90% dikirim ke semua teknisi & admin via Telegram
  - Tombol manual "📢 Notify Teknisi (Kritis)" di halaman SLA
  - **Cron otomatis terjadwal harian** — jam & aktif/nonaktif dikonfigurasi dari **Pengaturan → Notifikasi User Kritis (SLA)**, tanpa restart server
  - Anti-spam: tidak kirim jika tidak ada user kritis; dibatasi 15 user per pesan
- ♻️ **Refactor komputasi SLA** — logika perhitungan uptime diekstrak ke fungsi bersama `computeSla()` (dipakai dashboard + notifikasi)

### v2.6 — AI Agent & ONU Checker via Bot (Juni 2026)
- 🤖 **AI Agent WhatsApp** — auto-reply pesan pelanggan menggunakan AI Groq/Llama (gratis). AI mendapat konteks otomatis: daftar paket + harga, area jangkauan, info pelanggan, tagihan, dan status isolir dari database
- 📡 **ONU Checker via Telegram Bot** — teknisi di lapangan bisa cek status ONU langsung dari Telegram: `/cek [nama]`, `/status`, `/lemah`, `/kritis`, `/offline`
- 💬 **ONU Checker via WhatsApp** — perintah `#cek`, `#status`, `#lemah`, dll khusus admin/teknisi terdaftar
- 📊 **Detail ONU lengkap** — setiap hasil `/cek` menyertakan: rx/tx power + indikator sinyal, redaman dari GenieACS (ACS), uptime, jumlah user konek, info pelanggan terhubung
- 🔔 **OLT Alert via WhatsApp** — notifikasi ONU offline massal kini dikirim ke semua admin & teknisi via WA (selain Telegram)
- ⚠️ **Filter Jatuh Tempo** — halaman Billing: kartu statistik klikable, banner overdue, warna baris, label "Telat X hari"
- 🔒 **Isolir dari Invoice** — tombol "Isolir Pelanggan" langsung di kolom aksi invoice yang sudah jatuh tempo
- 📤 **Kirim WA Tagihan via Sistem Lokal** — kirim tagihan langsung via WA lokal (bukan redirect ke wa.me)
- 📅 **Dana Operasional** — filter default otomatis ke bulan ini

---

## 📋 Daftar Isi

- [Fitur Lengkap](#-fitur-lengkap)
- [Persyaratan Sistem](#-persyaratan-sistem)
- [Instalasi Cepat](#-instalasi-cepat-ubuntudebian)
- [Instalasi Manual](#-instalasi-manual)
- [Konfigurasi Awal](#-konfigurasi-awal)
- [Alur Pembayaran Xendit QRIS](#-alur-pembayaran-xendit-qris)
- [Cron Job Otomatis](#-cron-job-otomatis)
- [Teknologi](#-teknologi)
- [Support](#-support--komunitas)

---

## ✨ Fitur Lengkap

### 1. 👥 Manajemen Pelanggan
- Data lengkap pelanggan: nama, telepon, alamat, email, koordinat GPS
- Integrasi PPPoE MikroTik: tambah, hapus, aktif, nonaktif langsung dari dashboard
- Pilih paket layanan & router yang digunakan
- Tanggal isolir per pelanggan dapat dikustomisasi
- Filter pelanggan: aktif, terisolir, menunggak, tidak aktif
- Status pelanggan: **Aktif**, **Terisolir**, **Berhenti Berlangganan**
- Import pelanggan massal via CSV
- Export data pelanggan ke CSV
- Tampilan peta sebaran pelanggan (Leaflet.js)
- Assign teknisi per pelanggan untuk instalasi baru
- Status instalasi: pending / selesai

### 2. 🗓 Billing & Invoice
- Generate invoice otomatis setiap bulan (berjalan tengah malam tanggal 1)
- Generate invoice manual untuk satu atau banyak pelanggan sekaligus
- Filter invoice: status (unpaid/paid/overdue), rentang tanggal, nama pelanggan
- **Filter Jatuh Tempo** — kartu statistik "Jatuh Tempo" klikable langsung filter invoice overdue
- **Label keterlambatan** — kolom "Telat X hari" + warna baris merah/oranye sesuai keterlambatan
- **Banner overdue** — muncul otomatis saat filter jatuh tempo aktif, dengan tombol Auto Isolir & WA Reminder
- Catat pembayaran manual (cash/transfer)
- Tunda (defer) invoice tanpa menghapus tagihan
- **Isolir dari Invoice** — tombol "Isolir Pelanggan" langsung di aksi invoice yang sudah jatuh tempo
- **Kirim WA Tagihan** — kirim tagihan via WhatsApp lokal langsung dari kolom aksi (tanpa redirect wa.me)
- Cetak invoice dengan pratinjau in-page (modal + iframe, tanpa buka tab baru)
- Layout cetak kompak — muat 1 halaman A4 saat disimpan sebagai PDF
- Logo perusahaan & nama tampil berdampingan di header invoice
- Export invoice ke CSV
- Statistik pendapatan bulanan
- Riwayat pembayaran per pelanggan

### 3. ⚡ Payment Gateway

#### Xendit QRIS (Utama)
- Buat QR Code dinamis per invoice langsung dari portal pelanggan
- QR Code tampil sebagai gambar (scan via aplikasi bank/e-wallet manapun)
- Polling status pembayaran otomatis setiap 5 detik
- Webhook callback: setelah bayar → invoice lunas → PPPoE aktif → notif WA dikirim
- Verifikasi `x-callback-token` dari Xendit untuk keamanan

#### Transfer Manual / Cash
- Data rekening bank ditampilkan otomatis di portal pelanggan
- Admin catat pembayaran secara manual dari dashboard

#### Tripay (Opsional)
- Integrasi Tripay untuk QRIS, Virtual Account, dan E-Wallet
- Pilih channel pembayaran aktif dari dashboard
- Callback webhook dengan verifikasi HMAC-SHA256
- Mode sandbox & production

### 4. 🔌 Integrasi MikroTik (RouterOS API)
- Kelola beberapa router MikroTik sekaligus
- Tambah, edit, hapus konfigurasi router
- Test koneksi ke router langsung dari dashboard
- Lihat daftar PPPoE active sessions secara real-time
- Ping & Traceroute IP user langsung dari tabel PPPoE aktif (output terminal real-time)
- **Tombol "Rute" di tabel PPPoE Active** — buka peta dengan rute dari kantor pusat langsung ke lokasi user (koordinat dari DB atau diparse dari nama secret)
- **Cross-reference user aktif ↔ pelanggan diperbaiki** — mencocokkan berdasarkan `pppoe_username` DAN nama secret PPPoE (memotong suffix koordinat), jauh lebih akurat
- Sync PPPoE secrets dari MikroTik ke database
- Fetch daftar PPP Profile dari MikroTik untuk assign ke paket
- Auto disable/enable PPPoE saat isolir/reaktivasi
- Monitoring traffic per router
- Dashboard PPPoE per router dengan donut chart online/offline
- Tampilkan active PPPoE yang belum terhubung ke data pelanggan

### 4b. 📈 Dashboard SLA (Service Level Agreement)
- Perhitungan uptime per ONU berdasarkan history status Up/Down dari OLT (`onu_status_history`)
- Filter per periode (bulan), OLT, cluster kualitas, dan pencarian nama ONU/pelanggan
- Cluster otomatis: 🔴 Kritis (< 90%), 🟠 Buruk (90–95%), 🟡 Perlu Pantau (95–99%), 🟢 Baik (≥ 99%)
- Timeline insiden Down→Up per ONU dengan durasi tiap insiden
- Mapping manual ONU → pelanggan (otomatis mengisi `pppoe_username` pelanggan)
- **Notifikasi Telegram user kritis** — daftar ONU uptime < 90% dikirim ke semua teknisi & admin:
  - Tombol manual "📢 Notify Teknisi (Kritis)" di halaman SLA
  - Cron otomatis harian — jam & aktif/nonaktif dikonfigurasi dari Pengaturan (tanpa restart server)
  - Anti-spam: pesan tidak dikirim jika tidak ada user kritis; dibatasi 15 user per pesan
  - Pesan berisi: nama pelanggan/ONU, OLT, uptime %, jam down, jumlah insiden, waktu down terakhir

### 5. 📡 Manajemen OLT (Optical Line Terminal)
- Multi-brand OLT via SNMP: **HIOSO C, HIOSO B, HIOSO GPON, HIOSO HA73, ZTE, HSGQ, HSGQ GPON, Huawei**
- Auto-detect tipe/brand OLT saat pertama kali sync
- Sync daftar ONU otomatis setiap 5 menit
- Data ONU: status online/offline, RX power, TX power, MAC address, serial number, ONU index
- **PON View**: tab khusus untuk melihat status ONU per PON port di setiap OLT
  - Jumlah online/offline per PON ditampilkan dengan progress bar
  - Expand tiap PON untuk melihat daftar ONU beserta sinyal Rx/Tx
  - Ekstraksi PON port otomatis dari onu_index (HSGQ: bit-shift, format X.Y / X.Y.Z.W)
- **OLT Alert Notifikasi** — kirim notif saat jumlah ONU offline melebihi threshold:
  - Via **Telegram** ke grup admin
  - Via **WhatsApp** ke semua user dengan role admin & teknisi yang memiliki nomor HP terdaftar
  - Threshold per OLT & threshold global (total semua OLT) dapat dikonfigurasi dari Pengaturan
  - Anti-spam: notifikasi hanya dikirim saat status berubah (normal → alert, alert → recovery)
  - Tombol test kirim notifikasi Telegram & WA dari halaman Pengaturan
- **ONU Checker via Bot** — teknisi cek status ONU real-time tanpa buka browser:
  - Telegram: `/cek [nama]`, `/status`, `/lemah`, `/kritis`, `/offline`, `/help`
  - WhatsApp: `#cek [nama]`, `#status`, `#lemah`, `#kritis`, `#offline` (khusus admin/teknisi terdaftar)
  - Hasil mencakup: rx/tx power + indikator sinyal 🟢🟡🔴, redaman dari GenieACS, uptime, user konek, info pelanggan
  - Hanya user dengan Telegram ID / nomor HP terdaftar di Kelola User yang bisa akses
- Reboot ONU dari dashboard
- SNMP walk discovery untuk temukan OLT baru di jaringan
- Tambah, edit, hapus konfigurasi OLT
- Test koneksi SNMP ke OLT

### 6. 🌐 Integrasi GenieACS (ONT/CPE Management via TR-069)
- Sync perangkat dari GenieACS server otomatis setiap 5 menit
- Tampilkan status online/offline berdasarkan waktu `last_inform`
- Threshold online/offline dapat dikonfigurasi (default: 15 menit, sesuai Periodic Inform)
- Lihat IP WAN, serial number, manufacturer, PPPoE username tiap perangkat
- Fetch SSID & Password WiFi real-time dari GenieACS
- Ubah nama WiFi (SSID) & password WiFi via modal dari dashboard admin GenieACS
- Ubah SSID & Password WiFi langsung dari portal pelanggan atau portal teknisi
- Pre-fill nilai SSID & password saat ini saat modal dibuka (auto-fetch dari ACS)
- Reboot ONT dari dashboard admin
- Refresh parameter ONT dari dashboard admin
- Factory reset ONT dari dashboard admin
- Hapus device dari tracking ACS (termasuk cleanup device orphan)
- Konfigurasi path virtual parameters (PPPoE, IP WAN, dll) dari Settings
- Dukungan autentikasi HTTP Basic ke GenieACS

### 7. 📊 NOC Dashboard (Network Operations Center)
- Dashboard monitoring real-time jaringan
- Status keseluruhan OLT, ONU online/offline, GenieACS device
- Ringkasan status per OLT dengan badge online/offline
- Integrasi data MikroTik, OLT, dan GenieACS dalam satu tampilan

### 8. 🖧 IP Monitor
- Monitor konektivitas IP/host secara periodik (ping)
- Konfigurasi interval cek per target (menit)
- Notifikasi Telegram otomatis saat host down atau kembali online
- Riwayat status per target
- Tambah, edit, hapus target monitoring dari dashboard
- Test kirim notifikasi Telegram dari Settings

### 9. 🗺 Peta Infrastruktur
- Peta interaktif (Leaflet.js + OpenStreetMap — tanpa watermark, zoom 19)
- Tampilkan objek infrastruktur: Server, ODP, dan titik kustom lainnya
- **Marker kantor pusat** (🏢) dengan popup — jadi titik awal rute ke pelanggan
- **Popup detail pelanggan** — klik marker pelanggan → nama, telepon, paket + harga, username PPPoE, alamat, status aktif/isolir, badge tunggakan/lunas (lazy-load dari server)
- **Rute dari kantor pusat** — tombol di popup menggambar jalur ke lokasi pelanggan:
  - Via jalan raya menggunakan OSRM (gratis) — mengikuti jalan sebenarnya
  - Fallback otomatis ke garis lurus + jarak haversine jika OSRM tidak terjangkau
  - Estimasi jarak km ditampilkan di popup garis rute + auto-fit bounds
- **Tombol "Hapus Rute"** untuk membersihkan garis rute
- **Pencarian berdasarkan username PPPoE** — kotak pencarian peta mencocokkan nama & username PPPoE
- Koordinat pelanggan dapat diisi manual atau **diparsing otomatis dari nama secret PPPoE MikroTik** (format `Nama@-7.xxx,111.xxx`)
- **URL langsung dengan rute** — `/map?route=lat,lng&name=Nama` langsung menggambar rute (dipakai dari halaman PPPoE Active)
- Gambar jalur kabel pada peta dengan warna yang dapat dipilih
- Tambah, edit, hapus objek dan kabel dari peta
- Koordinat pusat peta & zoom default dapat dikustomisasi dari Settings
- Ambil koordinat GPS perangkat sebagai pusat peta

### 10. 🔶 Manajemen Infrastruktur Fiber Optik (FO)
- Kelola node FO dengan tipe dinamis: **ODP, ODC, OLT, Splitter, Tiang, Closure, HandHole, dll**
- Tipe node FO dapat ditambah/edit/hapus dari dashboard (dengan ikon & warna kustom)
- **Form Tiang yang disederhanakan**: saat tipe "Tiang" dipilih, form otomatis hanya menampilkan Nama + Koordinat + Alamat — field teknis disembunyikan
- Berlaku di seluruh titik tambah node: Kelola Node & tombol +Node di peta
- Kelola kabel FO antar node dengan koordinat jalur
- Manajemen tube dalam kabel (nomor tube, warna standar ITU-T, jumlah core)
- Manajemen core dalam tube (nomor core, warna standar ITU-T, status: tersedia/terpakai/rusak)
- Assignment core ke node (many-to-many) — satu core bisa melalui banyak node
- Kabel FO penginduk: pilih kabel → tube → core yang menginduk suatu node
- Manajemen splice point per kabel
- Inventaris aset FO: kabel, splitter, ODP box, closure, konektor, dll
- Peta visual infrastruktur FO lengkap dengan jalur kabel
- **Popup detail pelanggan di peta FO** — klik titik pelanggan → telepon, paket, PPPoE, tunggakan + tombol "Rute dari Kantor" & "Profil"
- **Marker kantor pusat + rute** di peta FO (sama seperti halaman Peta), tombol "🧹 Hapus Rute" di toolbar

### 11. 🎫 Tiket Gangguan (Trouble Ticket)
- Buat tiket dari admin, portal pelanggan, atau portal teknisi
- Priority: low, normal, high, urgent
- Status: open, in_progress, closed
- Kategori tiket (gangguan, instalasi, request, dll)
- Assign tiket ke satu atau banyak teknisi (many-to-many)
- Riwayat komentar & update per tiket
- Komentar internal (tidak terlihat pelanggan)
- Lokasi gangguan dengan koordinat GPS
- Close & reopen tiket
- Laporan tiket: jumlah per status, resolve rate, rata-rata waktu penyelesaian

### 12. 🛠 Portal Teknisi
- Dashboard tiket terbuka yang ditugaskan ke teknisi yang login
- Antrian instalasi baru (pelanggan berstatus instalasi pending)
- Ambil info WiFi real-time (SSID/Password) dari GenieACS langsung di lapangan
- Cek sinyal ONU real-time (RX/TX power) dari OLT
- Mark instalasi selesai dari portal
- Tampilan peta lokasi pelanggan
- Check-in presensi berbasis GPS

### 13. 📊 Portal Sales
- Dashboard khusus tim sales
- Kelola prospek / lead pelanggan baru
- Tracking komisi dan balance

### 14. 🌐 Portal Pelanggan (Self-Service)
- Login menggunakan **username PPPoE** atau **nomor HP** (format bebas: `08xxx`, `628xxx`, `+628xxx`)
- Password default `1234`, bisa diganti sendiri kapan saja
- Lihat semua tagihan dan riwayat pembayaran (10 invoice terakhir)
- Bayar tagihan via Xendit QRIS langsung dari portal
- Upload bukti transfer langsung dari portal — langsung tampil setelah upload
- Lihat jumlah dan total tagihan belum lunas
- Buat laporan gangguan / trouble ticket sendiri
- Lihat riwayat tiket yang pernah dibuat
- Lihat dan ubah nama WiFi (SSID) & password WiFi (via GenieACS)
- Update nomor telepon & email profil
- Ganti password portal

### 15. 💬 Notifikasi & Manager WhatsApp
- **Provider lokal**: whatsapp-web.js (scan QR, gratis, butuh Google Chrome)
- **Provider eksternal**: Fonnte, MPWA, Wablas (API berbayar, lebih stabil untuk skala besar)
- Toggle on/off per jenis notifikasi (invoice, reminder, isolir, payment, teknisi, dll)
- Notifikasi otomatis yang dikirim:
  - Invoice baru diterbitkan (beserta nominal dan jatuh tempo)
  - Pengingat jatuh tempo (H-3 atau sesuai konfigurasi)
  - Peringatan layanan diisolir
  - Konfirmasi pembayaran diterima
  - Notifikasi teknisi: ada penugasan pelanggan baru
- Laporan harian otomatis ke admin (jumlah pelanggan, pendapatan bulan ini, tiket aktif)
- Rate limiting & delay antar pesan (untuk bulk send, hindari ban)
- Manager percakapan WhatsApp: lihat & balas chat dari dashboard
- Dropdown pencarian pelanggan by nama — kirim pesan langsung dari panel chat
- Riwayat pesan tersimpan di database
- Test kirim pesan dari Settings
- Restart koneksi WhatsApp dari Settings tanpa restart server
- Status koneksi WhatsApp real-time: QR Code, Connecting, Ready
- **Template Pesan**: buat & kelola template pesan dengan variabel dinamis (`{nama}`, `{nomor}`, `{paket}`, `{jumlah}`, `{tanggal}`) — pilih template langsung dari input chat
- **Auto Reply**: balas pesan masuk secara otomatis berdasarkan kata kunci, mode pencocokan `contains`, `exact`, atau `startswith`; variabel pelanggan otomatis terisi dari database
- **AI Agent** — auto-reply cerdas menggunakan AI Groq/Llama (gratis hingga ~14.400 req/hari):
  - Aktif jika tidak ada keyword Auto Reply yang cocok
  - AI mendapat konteks otomatis dari database: info perusahaan, seluruh daftar paket + harga, area jangkauan, data pelanggan (nama, paket, tagihan, status isolir)
  - Percakapan diingat selama 30 menit per nomor
  - Pilihan model: Llama 3.1 8B (cepat), Llama 3.3 70B (lebih pintar), Gemma, Mixtral
  - System prompt, max token, dan API key dapat dikonfigurasi dari Pengaturan → tab AI Agent
  - Tombol test AI langsung dari halaman pengaturan
- **ONU Checker via WA** — perintah khusus untuk admin/teknisi terdaftar:
  - `#cek [nama]` — status ONU lengkap: sinyal, redaman, pelanggan
  - `#status` — ringkasan semua OLT
  - `#lemah` — list ONU sinyal lemah (rx < -27 dBm)
  - `#kritis` — list ONU sinyal kritis (rx < -30 dBm)
  - `#offline` — list ONU Down

### 16. ✈️ Notifikasi & Bot Telegram
- Integrasi Telegram Bot
- Laporan harian otomatis dikirim ke group/channel Telegram admin
- Notifikasi OLT Alert (ONU offline massal) — lihat fitur OLT
- Notifikasi IP Monitor (host down/recovery)
- Test kirim pesan dari Settings
- **Bot Perintah untuk Teknisi** — polling bot aktif otomatis saat server start:
  - `/cek [nama]` — detail ONU: rx/tx power + indikator 🟢🟡🔴, redaman ACS, uptime, user konek, info pelanggan
  - `/status` — ringkasan semua OLT (online/offline/kritis/lemah per OLT)
  - `/lemah` — list ONU sinyal lemah (rx < -27 dBm)
  - `/kritis` — list ONU sinyal kritis (rx < -30 dBm)
  - `/offline` — list semua ONU yang Down
  - `/help` — daftar semua perintah
  - Hanya user dengan Telegram ID terdaftar di Kelola User (role admin/teknisi) yang bisa akses

### 17. 🎮 Hotspot & Voucher WiFi
- Manajemen hotspot user di MikroTik
- Tambah dan hapus hotspot profile
- Generate voucher WiFi otomatis (kode acak, harga, profile)
- Cetak voucher dalam batch (template siap print)
- Hapus voucher yang sudah terpakai sekaligus (bulk cleanup)
- Lihat status voucher: unused / used

### 18. 📦 Manajemen Inventaris
- Stok perangkat dan material (ONT, kabel, splitter, router, dll)
- Kategori dan satuan unit (pcs, meter, roll, dll)
- Tambah, edit, hapus item stok

### 19. 💰 Pencatatan Pengeluaran
- Catat pengeluaran operasional ISP harian
- Kategori pengeluaran dengan warna & ikon kustom (Operasional, Internet Upstream, Equipment, dll)
- Tambah, edit, hapus kategori pengeluaran
- Filter pengeluaran per kategori dan rentang tanggal
- **Filter default bulan ini** — saat pertama buka halaman, otomatis menampilkan pengeluaran bulan berjalan
- Ringkasan pengeluaran per kategori

### 20. 📍 Presensi Teknisi
- Form check-in berbasis GPS dari portal teknisi
- Validasi radius: presensi ditolak jika jarak melebihi batas dari titik kantor
- Batas jam tepat waktu dapat dikonfigurasi (contoh: 08:30, setelahnya = terlambat)
- Laporan presensi per user per periode (tepat waktu / terlambat)
- Admin dapat hapus data presensi

### 21. 🔧 Pengaturan Sistem
- **Profil Perusahaan**: nama ISP, logo, ikon, telepon, alamat, email, website, timezone, mata uang
- **Billing**: prefix nomor invoice, tanggal generate otomatis, hari jatuh tempo default, toleransi keterlambatan
- **Otomasi**: toggle auto-billing, toggle auto-isolir, hari kirim reminder sebelum jatuh tempo
- **WhatsApp**: pilih provider, API URL, API key, nomor pengirim, delay antar pesan, limit batch, nomor admin, toggle per jenis notifikasi
- **Template Pesan WA**: kustomisasi teks untuk invoice baru, payment received, isolir, reminder
- **Telegram**: bot token, admin chat ID, monitor chat ID (untuk alert OLT & IP)
- **OLT Alert**: threshold ONU offline per OLT & global, tombol test notifikasi Telegram & WA
- **AI Agent**: Groq API key, pilih model AI (Llama/Gemma/Mixtral), system prompt, max token, tombol test real-time
- **IP Monitor**: daftar target ping & interval, notifikasi Telegram
- **Payment Gateway**: pilih gateway default, konfigurasi Xendit & Tripay, data rekening bank manual
- **GenieACS**: URL ACS, username, password, threshold online/offline, path virtual parameters
- **Peta**: koordinat pusat, zoom default, mini preview map interaktif, ambil lokasi GPS
- **Notifikasi SLA**: toggle aktif/nonaktif notifikasi user kritis + pilihan jam pengiriman (otomatis tanpa restart server)
- **Presensi**: radius maksimal check-in (meter), jam batas tepat waktu
- **Manajemen User**: tambah/edit/hapus user admin, teknisi, sales; set role, nomor HP, Telegram ID
- **Import/Export**: export pelanggan & invoice ke CSV, import pelanggan massal dari CSV
- **Git Repository**: konfigurasi URL repo & branch untuk update sistem
- **Update Sistem**: update dari GitHub langsung via tombol di dashboard (git pull)
- **Multi-bahasa**: Indonesia & English (dapat diganti dari topbar)

### 22. 🔐 Keamanan & Akses
- Role-based access control: **Admin** (akses penuh), **Teknisi** (portal teknisi), **Sales** (portal sales)
- Password hashing dengan bcrypt (salt round 10)
- Session management dengan express-session
- Middleware autentikasi per route group
- Verifikasi webhook Xendit via `x-callback-token` header
- Verifikasi webhook Tripay via HMAC-SHA256 signature
- Web Installer mode: jika `.env` belum ada, semua route dialihkan ke halaman setup

---

## 🔧 Persyaratan Sistem

| Komponen | Minimum | Rekomendasi |
|---|---|---|
| OS | Ubuntu 20.04 / Debian 11 / Windows + WAMP | Ubuntu 22.04 LTS |
| CPU | 1 core | 2 core |
| RAM | 1 GB | 2 GB (jika pakai WA lokal) |
| Storage | 5 GB | 10 GB |
| Node.js | v18+ | v20 LTS |
| Database | MySQL 5.7+ / MariaDB 10.6+ | MySQL 8.0 |
| Port | 3999 | 3999 |

> ✅ Kompatibel dengan **MySQL 5.7** (WAMP/XAMPP) — tidak membutuhkan fitur MySQL 8 only.

---

## 🚀 Instalasi Cepat (Ubuntu/Debian)

Jalankan satu perintah ini di terminal server sebagai root:

```bash
curl -sSL https://raw.githubusercontent.com/iduronot/billing_dino/main/install.sh | sudo bash
```

Setelah selesai, buka browser dan akses:
```
http://IP-SERVER:3999
```

Web Installer akan memandu mengisi koneksi database dan membuat akun admin pertama.

---

## 🛠 Instalasi Manual

```bash
# 1. Clone repository
git clone https://github.com/iduronot/billing_dino.git /opt/dino-bill
cd /opt/dino-bill

# 2. Install dependensi (skip download Chromium bawaan Puppeteer)
PUPPETEER_SKIP_DOWNLOAD=true npm install

# 3. Jalankan — Web Installer aktif otomatis jika .env belum ada
node server.js

# 4. Atau jalankan dengan PM2 untuk production
pm2 start server.js --name dino-bill
pm2 save && pm2 startup
```

---

## ⚙️ Konfigurasi Awal

### 1. Login Admin
- URL: `http://IP-SERVER:3999`
- Username: `admin` | Password: `admin`
- **Ganti password segera setelah login pertama**

### 1b. Login Portal Pelanggan
- URL: `http://IP-SERVER:3999/portal/login`
- Username: nomor HP pelanggan (format bebas: `081234567890`, `6281234567890`, `+6281234567890`) **atau** username PPPoE
- Password default: `1234`
- Link **Portal Pelanggan** juga tersedia di sidebar dashboard admin

### 2. Profil Perusahaan
**Pengaturan → Perusahaan** → isi nama ISP, logo, telepon, alamat, timezone.

### 3. Xendit QRIS (Payment Gateway)
**Pengaturan → Payment → Xendit QRIS:**
1. Isi **API Key** — ambil dari Xendit Dashboard → Settings → API Keys (gunakan Secret Key)
2. Isi **Webhook Token** — ambil dari Xendit Dashboard → Settings → Webhooks → Callback Token
3. Salin **Callback URL** yang tampil → daftarkan ke Xendit Dashboard → Webhooks → QR Code
4. Klik **Test Koneksi Xendit** untuk verifikasi
5. Set **Default Gateway** ke `Xendit QRIS` → Simpan

### 4. WhatsApp
**Pengaturan → WhatsApp** → pilih provider:
- **Local** — klik Restart, scan QR Code yang muncul dengan HP, gratis
- **Fonnte / MPWA / Wablas** — isi API URL + API Key dari dashboard provider

### 5. MikroTik
**Router** → Tambah Router → isi nama, IP address, username, password API (port default 8728).

### 6. OLT
**OLT** → Tambah OLT → isi nama, host/IP, port SNMP (default 161), community string, pilih brand.

### 7. GenieACS
**Pengaturan → GenieACS** → isi URL ACS (`http://IP:7557`), username, password, path virtual parameter.

### 8. OLT Alert (Telegram)
**Pengaturan → OLT Alert:**
1. Pastikan Bot Token & Monitor Chat ID sudah diisi di tab Telegram
2. Set **Batas ONU Offline per OLT** (default: 100)
3. Set **Batas Global** jika ingin notif untuk total semua OLT (0 = nonaktif)
4. Klik **Test Kirim Notifikasi** untuk verifikasi

### 9. IP Monitor
**IP Monitor** → Tambah target → isi nama, IP/host, interval cek (menit).
Notifikasi Telegram dikirim saat host down atau kembali online.

---

## ⚡ Alur Pembayaran Xendit QRIS

```
Pelanggan buka Portal → klik "Bayar dengan QRIS"
            ↓
POST /portal/pay/:invoiceId
            ↓
Dino-Bill request ke Xendit API → buat QR Code dinamis (24 jam)
            ↓
QR Code tampil di modal (gambar + countdown waktu kedaluwarsa)
            ↓
Polling otomatis setiap 5 detik ke /portal/qr-status/:referenceId
            ↓
Pelanggan scan QR via aplikasi bank / e-wallet manapun
            ↓
Xendit kirim webhook → POST /api/xendit/callback
            ↓
Server verifikasi x-callback-token → proses pembayaran
            ↓
Invoice ditandai "paid" → PPPoE di-enable di MikroTik
            ↓
Notifikasi WhatsApp "Pembayaran Diterima" dikirim ke pelanggan
            ↓
Portal pelanggan otomatis tampilkan layar sukses ✅
```

---

## ⏰ Cron Job Otomatis

| Jadwal | Fungsi |
|---|---|
| Setiap hari pukul 00:00 | **Auto-Isolir**: cari invoice overdue → set status isolated → disable PPPoE MikroTik → kirim notif WA |
| Setiap hari pukul 08:00 | **Reminder Tagihan**: kirim WA ke pelanggan yang jatuh tempo H-3 (atau sesuai setting) |
| Setiap hari pukul 08:30 | **Laporan Harian**: ringkasan statistik ISP dikirim ke admin via WA & Telegram |
| Setiap hari (jam konfigurasi, default 15:00) | **Notifikasi User Kritis SLA**: daftar ONU uptime < 90% dikirim ke teknisi & admin via Telegram (aktif/nonaktif & jam diatur di Pengaturan) |
| Tanggal 1 setiap bulan pukul 06:00 | **Generate Invoice**: buat invoice bulanan untuk semua pelanggan aktif + kirim notif WA |
| Setiap 5 menit | **Sync OLT**: update status & sinyal ONU dari semua OLT via SNMP + cek OLT Alert |
| Setiap 5 menit | **Sync GenieACS**: update status online/offline device dari ACS server |
| Setiap 1 menit | **IP Monitor**: ping semua target sesuai interval yang dikonfigurasi per target |

> Auto-isolir dan auto-billing dapat dimatikan dari **Pengaturan → Billing**. Notifikasi SLA dari **Pengaturan → Notifikasi User Kritis (SLA)**.

---

## 🏗 Teknologi

| Komponen | Teknologi |
|---|---|
| Backend | Node.js + Express.js |
| Database | MySQL 5.7+ / MySQL 8 via mysql2/promise (connection pool) |
| Template Engine | EJS |
| Session | express-session |
| Scheduler | node-cron |
| MikroTik API | routeros-api |
| OLT SNMP | net-snmp |
| WhatsApp | whatsapp-web.js + Puppeteer / Google Chrome |
| AI Agent | Groq API (Llama 3.1 / 3.3, Gemma, Mixtral) |
| Payment | Xendit QRIS API + Tripay API |
| Notifikasi | WhatsApp (lokal/API) + Telegram Bot API |
| Peta | Leaflet.js + OpenStreetMap |
| QR Code | qrcode |
| Password | bcryptjs |
| Git Update | simple-git |
| HTTP Client | axios |
| Environment | dotenv |

---

## 💬 Support & Komunitas

- **Grup Telegram**: [t.me/dinosupports](https://t.me/dinosupports)
- **Bug Report / Feature Request**: buka Issue di repository GitHub

---

## 📄 Lisensi

MIT License — Bebas digunakan, dimodifikasi, dan dikembangkan untuk kebutuhan ISP lokal.
