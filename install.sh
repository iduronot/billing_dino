#!/bin/bash
set -e

# ─────────────────────────────────────────────
#  Dino-Bill Auto Installer — Ubuntu 20.04/22.04
# ─────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     🦖  Dino-Bill Installer v2       ║${NC}"
echo -e "${GREEN}║   ISP Billing & Management System    ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""

# ─── Root check ───────────────────────────────
if [ "$EUID" -ne 0 ]; then
    error "Jalankan installer sebagai root: sudo bash install.sh"
fi

# ─── Detect OS ────────────────────────────────
OS_ID=$(grep -oP '(?<=^ID=).+' /etc/os-release | tr -d '"')
OS_VER=$(grep -oP '(?<=^VERSION_ID=).+' /etc/os-release | tr -d '"')
info "Sistem terdeteksi: $OS_ID $OS_VER"

if [[ "$OS_ID" != "ubuntu" ]] && [[ "$OS_ID" != "debian" ]]; then
    warn "Installer dioptimalkan untuk Ubuntu/Debian. Lanjutkan dengan risiko sendiri."
fi

# ─── System update ────────────────────────────
info "Update package list..."
apt-get update -qq

# ─── Node.js v20 LTS ──────────────────────────
if ! command -v node &>/dev/null || [[ $(node -v | tr -d 'v' | cut -d. -f1) -lt 18 ]]; then
    info "Menginstall Node.js v20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null
    success "Node.js $(node -v) terinstall"
else
    success "Node.js $(node -v) sudah tersedia"
fi

# ─── MySQL / MariaDB ──────────────────────────
if ! command -v mysql &>/dev/null; then
    info "Menginstall MySQL Server..."
    apt-get install -y mysql-server >/dev/null
    systemctl enable --now mysql 2>/dev/null || systemctl enable --now mariadb 2>/dev/null || true
    success "MySQL terinstall"
else
    success "MySQL sudah tersedia"
fi

# ─── Git ──────────────────────────────────────
if ! command -v git &>/dev/null; then
    info "Menginstall Git..."
    apt-get install -y git >/dev/null
fi
success "Git $(git --version | awk '{print $3}') siap"

# ─── PM2 ──────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
    info "Menginstall PM2..."
    npm install -g pm2 --silent
fi
success "PM2 $(pm2 -v) siap"

# ─── Google Chrome (untuk WhatsApp engine) ────
if ! command -v google-chrome-stable &>/dev/null && ! command -v google-chrome &>/dev/null; then
    info "Menginstall Google Chrome (WhatsApp engine)..."
    CHROME_DEB="google-chrome-stable_current_amd64.deb"
    wget -q https://dl.google.com/linux/direct/$CHROME_DEB -O /tmp/$CHROME_DEB
    apt-get install -y /tmp/$CHROME_DEB >/dev/null 2>&1 || apt-get -f install -y >/dev/null
    rm -f /tmp/$CHROME_DEB
    success "Google Chrome terinstall"
else
    success "Google Chrome sudah tersedia"
fi

# ─── Clone / Update App ───────────────────────
APP_DIR="/opt/dino-bill"

if [ ! -d "$APP_DIR" ]; then
    info "Cloning Dino-Bill ke $APP_DIR ..."
    git clone https://github.com/ittosolution-png/Dino-Bill.git "$APP_DIR"
    success "Repository berhasil di-clone"
else
    info "Update Dino-Bill dari repository..."
    git -C "$APP_DIR" pull
    success "Repository berhasil di-update"
fi

# ─── Install npm dependencies ─────────────────
info "Menginstall dependensi Node.js..."
cd "$APP_DIR"
PUPPETEER_SKIP_DOWNLOAD=true npm install --silent
success "Dependensi terinstall"

# ─── Setup PM2 ────────────────────────────────
info "Konfigurasi PM2..."
pm2 delete dino-bill 2>/dev/null || true
pm2 start "$APP_DIR/server.js" --name dino-bill \
    --env production \
    -e "$APP_DIR/logs/error.log" \
    -o "$APP_DIR/logs/out.log" \
    -- 2>/dev/null || pm2 start "$APP_DIR/server.js" --name dino-bill

pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

# ─── Firewall (UFW) ───────────────────────────
if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    ufw allow 3999/tcp >/dev/null 2>&1 || true
    info "UFW: port 3999 dibuka"
fi

# ─── Done ─────────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        ✅  Instalasi Selesai!            ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  🌐 Buka Web Installer di:               ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}     ${CYAN}http://$SERVER_IP:3999${NC}             ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                          ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  📋 Langkah selanjutnya:                 ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  1. Buka URL di atas di browser          ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  2. Isi data koneksi database MySQL      ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  3. Login admin / admin                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  4. Isi Pengaturan (Perusahaan, WA,      ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}     Xendit QRIS, MikroTik, dll)          ${GREEN}║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  💬 Support: https://t.me/dinosupports   ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
