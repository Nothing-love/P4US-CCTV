#!/usr/bin/env bash
# =============================================================================
#  P4US CCTV — Pemasang Server (PM2, port 6969)
#  Memasang semua kebutuhan lalu menjalankan aplikasi lewat PM2.
#
#  Pemakaian:
#     chmod +x INSTALL-SERVER-PM2.sh
#     ./INSTALL-SERVER-PM2.sh
#  (atau cukup:  bash INSTALL-SERVER-PM2.sh )
#
#  Syarat: Node.js >= 22.5 (disarankan 24). node:sqlite butuh versi ini.
# =============================================================================
set -e
cd "$(dirname "$0")"

PORT=6969

echo "=============================================================="
echo "   P4US CCTV — PEMASANGAN SERVER (PM2, port ${PORT})"
echo "=============================================================="

# --- 1. Node.js ---------------------------------------------------------------
echo "[1/6] Memeriksa Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "  [!] Node.js belum terpasang. Pasang Node.js LTS (>=22.5) dulu, mis.:"
  echo "        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "        sudo apt-get install -y nodejs"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
echo "      Node.js: $(node -v)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "  [!] Versi Node terlalu lama untuk node:sqlite. Perlu >= 22.5 (disarankan 24)."
  exit 1
fi

# --- 2. FFmpeg (opsional: RTSP/transcode & rekaman) ---------------------------
echo "[2/6] Memasang FFmpeg (untuk RTSP/transcode H.265 & rekaman)..."
if command -v ffmpeg >/dev/null 2>&1; then
  echo "      FFmpeg sudah ada: $(ffmpeg -version | head -n1)"
else
  echo "      FFmpeg belum ada — memasang otomatis..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y ffmpeg
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y ffmpeg
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y ffmpeg
  fi
  if command -v ffmpeg >/dev/null 2>&1; then
    echo "      FFmpeg berhasil dipasang: $(ffmpeg -version | head -n1)"
  else
    echo "      [!] Gagal pasang FFmpeg otomatis. Pasang manual lalu restart:"
    echo "          sudo apt-get install -y ffmpeg   (atau paket distro Anda)"
  fi
fi

# --- 3. Dependency Node -------------------------------------------------------
echo "[3/6] Memasang dependency (npm install)..."
npm install --omit=dev

# --- 4. Konfigurasi .env (port 6969) ------------------------------------------
echo "[4/6] Menyiapkan .env..."
if [ -f .env ]; then
  echo "      .env sudah ada, dipertahankan. (hapus untuk buat ulang)"
else
  GEN_PORT=$PORT node scripts/gen-env.js
  echo "      .env dibuat (PORT=${PORT}, kunci rahasia acak)."
  echo "      Password admin awal akan dicetak ke log saat pertama jalan — lihat 'pm2 logs'."
  echo "      (Atau atur sendiri ADMIN_PASSWORD di .env lalu 'pm2 restart p4us-cctv'.)"
fi

# --- 5. Impor data kamera (jika katalog CSV tersedia) -------------------------
echo "[5/6] Mengimpor data kamera..."
if [ -f backend/db/p4us.db ]; then
  echo "      Database sudah ada, melewati impor. (hapus backend/db/p4us.db untuk ulang)"
elif ls catalog_*.csv >/dev/null 2>&1; then
  npm run import-cameras || echo "      [!] Impor gagal (lanjut tanpa data)."
else
  echo "      [i] Katalog CSV tidak ada — database dibuat kosong (hanya akun admin)."
  echo "          Salin catalog_*.csv ke folder ini lalu: npm run import-cameras"
fi

# --- 6. Jalankan via PM2 ------------------------------------------------------
echo "[6/6] Menjalankan via PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
  echo "      Memasang PM2 global..."
  npm install -g pm2
fi
mkdir -p backend/logs
pm2 start ecosystem.config.js --update-env
pm2 save

echo "=============================================================="
echo "   P4US CCTV berjalan di PM2  →  http://localhost:${PORT}"
echo ""
echo "   Perintah berguna:"
echo "     pm2 logs p4us-cctv      # lihat log (termasuk password admin awal)"
echo "     pm2 restart p4us-cctv   # restart setelah ubah .env"
echo "     pm2 stop p4us-cctv      # hentikan"
echo "     pm2 startup             # auto-start saat server boot (ikuti instruksinya)"
echo "=============================================================="
