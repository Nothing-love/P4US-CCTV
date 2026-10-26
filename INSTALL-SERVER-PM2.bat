@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title P4US CCTV - Pemasang Server (PM2, port 6969)
cd /d "%~dp0"
set "PORT=6969"

echo.
echo ================================================================
echo        P4US CCTV - PEMASANGAN SERVER (PM2, port %PORT%)
echo ================================================================
echo   Memasang semua kebutuhan lalu menjalankan lewat PM2 (daemon).
echo   Setelah selesai, aplikasi tetap jalan walau jendela ditutup.
echo ================================================================
echo.

REM ------------------------------------------------------------------
REM  1. Node.js
REM ------------------------------------------------------------------
echo [1/6] Memeriksa Node.js...
where node >nul 2>nul
if %errorlevel%==0 (
    for /f "delims=" %%v in ('node -v') do echo       Node.js terpasang: %%v
) else (
    echo       Node.js belum ada. Memasang lewat winget...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
    where node >nul 2>nul
    if !errorlevel! NEQ 0 (
        echo.
        echo   [!] Node.js tidak dapat dipasang otomatis.
        echo       Unduh dan pasang Node.js ^(>=22.5, disarankan 24^) dari https://nodejs.org
        echo       lalu jalankan file ini lagi.
        echo.
        pause
        exit /b 1
    )
)
echo.

REM ------------------------------------------------------------------
REM  2. FFmpeg (untuk RTSP dan perekaman)
REM ------------------------------------------------------------------
echo [2/6] Memeriksa FFmpeg...
if exist "ffmpeg\bin\ffmpeg.exe" (
    echo       FFmpeg sudah ada di folder proyek.
) else (
    where ffmpeg >nul 2>nul
    if !errorlevel!==0 (
        echo       FFmpeg ditemukan di sistem.
    ) else (
        echo       Mengunduh FFmpeg... ^(~80 MB, mohon tunggu^)
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-ffmpeg.ps1"
        if !errorlevel! NEQ 0 echo       [!] FFmpeg gagal diunduh. RTSP/rekaman nonaktif.
    )
)
echo.

REM ------------------------------------------------------------------
REM  3. Dependency Node (npm install)
REM ------------------------------------------------------------------
echo [3/6] Memasang dependency aplikasi...
if exist "node_modules" (
    echo       node_modules sudah ada, melewati... ^(hapus folder untuk pasang ulang^)
) else (
    call npm install --omit=dev
    if !errorlevel! NEQ 0 (
        echo   [!] npm install gagal. Periksa koneksi internet lalu coba lagi.
        pause
        exit /b 1
    )
)
echo.

REM ------------------------------------------------------------------
REM  4. Konfigurasi .env (port 6969)
REM ------------------------------------------------------------------
echo [4/6] Menyiapkan konfigurasi...
if exist ".env" (
    echo       File .env sudah ada, dipertahankan.
) else (
    set "GEN_PORT=%PORT%"
    node "%~dp0scripts\gen-env.js"
    if !errorlevel! NEQ 0 (
        echo   [!] Gagal membuat .env
        pause
        exit /b 1
    )
    echo       File .env dibuat ^(PORT=%PORT%, kunci acak^).
    echo       Password admin awal dicetak ke log saat pertama jalan - lihat: pm2 logs p4us-cctv
)
echo.

REM ------------------------------------------------------------------
REM  5. Impor data kamera ke database
REM ------------------------------------------------------------------
echo [5/6] Mengimpor data kamera...
if exist "backend\db\p4us.db" (
    echo       Database sudah ada, melewati impor. ^(hapus backend\db\p4us.db untuk impor ulang^)
) else (
    if exist "catalog_cctv.csv" (
        call npm run import-cameras
        if !errorlevel! NEQ 0 echo       [!] Impor kamera gagal ^(lanjut^).
    ) else (
        echo       [i] Katalog CSV tidak ada - database dibuat kosong ^(hanya akun admin^).
        echo           Salin catalog_*.csv ke folder ini lalu: npm run import-cameras
    )
)
echo.

REM ------------------------------------------------------------------
REM  6. Jalankan via PM2
REM ------------------------------------------------------------------
echo [6/6] Menjalankan via PM2...
where pm2 >nul 2>nul
if !errorlevel! NEQ 0 (
    echo       Memasang PM2 global...
    call npm install -g pm2
)
if not exist "backend\logs" mkdir "backend\logs"
call pm2 start ecosystem.config.js --update-env
call pm2 save

echo.
echo ================================================================
echo   P4US CCTV berjalan di PM2  -^>  http://localhost:%PORT%
echo.
echo   Perintah berguna:
echo     pm2 logs p4us-cctv      (lihat log + password admin awal)
echo     pm2 restart p4us-cctv   (restart setelah ubah .env)
echo     pm2 stop p4us-cctv      (hentikan)
echo.
echo   Agar PM2 otomatis jalan saat Windows start, pasang pm2-windows-startup:
echo     npm install -g pm2-windows-startup ^&^& pm2-startup install ^&^& pm2 save
echo ================================================================
echo.
start "" http://localhost:%PORT%
pause
