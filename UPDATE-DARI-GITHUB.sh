#!/usr/bin/env bash
# =============================================================================
#  P4US CCTV — Auto-Update dari GitHub (server Linux + PM2)
#
#  Menyamakan kode dengan GitHub (origin/main), memasang dependency baru bila
#  ada, lalu reload aplikasi di PM2 ke versi terbaru. Migrasi database jalan
#  otomatis saat aplikasi start.
#
#  CARA PAKAI:
#    ./UPDATE-DARI-GITHUB.sh                 # cek & update sekali sekarang
#    ./UPDATE-DARI-GITHUB.sh --pasang-otomatis   # pasang cron: auto tiap 5 menit
#    ./UPDATE-DARI-GITHUB.sh --hapus-otomatis    # lepas cron auto-update
#
#  AMAN: git reset --hard hanya menyentuh file TERLACAK. File di .gitignore
#  (.env, backend/db/*.db, catalog_*.csv, ffmpeg/, backend/recordings) TIDAK
#  ikut berubah — data & konfigurasi server tetap utuh.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="main"
APP="p4us-cctv"
INTERVAL_MENIT=5                         # frekuensi cek saat mode otomatis
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
LOGDIR="backend/logs"
LOG="$LOGDIR/auto-update.log"
mkdir -p "$LOGDIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# ── Mode: pasang/lepas cron (jadikan otomatis) ───────────────────────────────
if [ "${1:-}" = "--pasang-otomatis" ] || [ "${1:-}" = "--setup-cron" ]; then
  DIR="$(dirname "$SELF")"
  # Path dikutip agar aman walau folder server mengandung spasi.
  CRON_LINE="*/$INTERVAL_MENIT * * * * cd \"$DIR\" && bash \"$SELF\" >> \"$DIR/$LOG\" 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "$SELF" ; echo "$CRON_LINE" ) | crontab -
  echo "✔ Auto-update terpasang di cron: cek tiap $INTERVAL_MENIT menit."
  echo "  Lihat jadwal : crontab -l"
  echo "  Lihat log    : tail -f $(dirname "$SELF")/$LOG"
  exit 0
fi
if [ "${1:-}" = "--hapus-otomatis" ] || [ "${1:-}" = "--remove-cron" ]; then
  ( crontab -l 2>/dev/null | grep -vF "$SELF" ) | crontab - || true
  echo "✔ Auto-update dilepas dari cron."
  exit 0
fi

# ── Update sekali ────────────────────────────────────────────────────────────
log "=== Cek update dari GitHub (origin/$BRANCH) ==="

if ! git fetch origin "$BRANCH" --quiet 2>>"$LOG"; then
  log "[!] Gagal fetch dari GitHub (cek koneksi/kredensial). Lewati siklus ini."
  exit 1
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  log "Sudah versi terbaru (${LOCAL:0:7}). Tidak ada perubahan."
  exit 0
fi

log "Versi baru: ${LOCAL:0:7} -> ${REMOTE:0:7}. Memperbarui..."

# 1. Samakan persis dengan GitHub (file .gitignore tetap aman).
git reset --hard "origin/$BRANCH" >>"$LOG" 2>&1

# 2. Pasang dependency hanya bila package.json berubah (atau belum ada).
if [ ! -d node_modules ] || ! git diff --quiet "$LOCAL" "$REMOTE" -- package.json; then
  log "Dependency berubah — menjalankan npm install..."
  npm install --omit=dev >>"$LOG" 2>&1
else
  log "Dependency tidak berubah — lewati npm install."
fi

# 3. Reload / start aplikasi di PM2 (migrasi DB jalan otomatis saat start).
mkdir -p "$LOGDIR"
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP" >/dev/null 2>&1; then
  log "Reload PM2 ($APP)..."
  pm2 reload ecosystem.config.js --update-env >>"$LOG" 2>&1
elif command -v pm2 >/dev/null 2>&1; then
  log "PM2 belum menjalankan $APP — start..."
  pm2 start ecosystem.config.js --update-env >>"$LOG" 2>&1
  pm2 save >>"$LOG" 2>&1 || true
else
  log "[!] PM2 tidak terpasang. Jalankan dulu INSTALL-SERVER-PM2.sh."
  exit 1
fi

log "=== Selesai. Website kini di versi ${REMOTE:0:7}. ==="
