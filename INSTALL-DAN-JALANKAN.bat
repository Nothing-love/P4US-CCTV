@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title P4US CCTV - Pemasang Otomatis
cd /d "%~dp0"

echo.
echo ================================================================
echo              P4US CCTV - PEMASANGAN OTOMATIS
echo ================================================================
echo   File ini akan memasang semua yang dibutuhkan lalu menjalankan
echo   aplikasi. Biarkan jendela ini terbuka selama aplikasi dipakai.
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
        echo       Silakan unduh dan pasang dari: https://nodejs.org
        echo       lalu jalankan file ini lagi.
        echo.
        pause
        exit /b 1
    )
    echo       Node.js berhasil dipasang.
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
        echo       Mengunduh FFmpeg... ^(ukuran ~80 MB, mohon tunggu^)
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-ffmpeg.ps1"
        if !errorlevel! NEQ 0 (
            echo.
            echo   [!] Gagal mengunduh FFmpeg otomatis.
            echo       RTSP tetap tidak bisa diputar tanpa FFmpeg.
            echo       Anda dapat memasukkan ffmpeg.exe ke folder: ffmpeg\bin\
            echo.
            echo       Tekan tombol apa saja untuk lanjut tanpa FFmpeg...
            pause >nul
        ) else (
            echo       FFmpeg berhasil dipasang di folder proyek.
        )
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
REM  4. Konfigurasi .env
REM ------------------------------------------------------------------
echo [4/6] Menyiapkan konfigurasi...
if exist ".env" (
    echo       File .env sudah ada, dipertahankan.
) else (
    node "%~dp0scripts\gen-env.js"
    if !errorlevel! NEQ 0 (
        echo   [!] Gagal membuat .env
        pause
        exit /b 1
    )
    echo       File .env dibuat dengan kunci rahasia acak.
)
echo.

REM ------------------------------------------------------------------
REM  5. Impor data kamera ke database
REM ------------------------------------------------------------------
echo [5/6] Mengimpor data kamera...
if exist "backend\db\p4us.db" (
    echo       Database sudah ada, melewati impor. ^(hapus backend\db\p4us.db untuk impor ulang^)
) else (
    call npm run import-cameras
    if !errorlevel! NEQ 0 (
        echo   [!] Impor kamera gagal.
        pause
        exit /b 1
    )
)
echo.

REM ------------------------------------------------------------------
REM  6. Jalankan server + buka browser
REM ------------------------------------------------------------------
echo [6/6] Menjalankan server P4US CCTV...
echo.
echo ================================================================
echo   Server berjalan di:  http://localhost:3000
echo   Browser akan terbuka otomatis sebentar lagi.
echo   Tutup jendela ini untuk menghentikan aplikasi.
echo ================================================================
echo.

REM Buka browser setelah 4 detik (memberi server waktu untuk start)
start "" /b cmd /c "timeout /t 4 >nul & start http://localhost:3000"

node backend\server.js

echo.
echo Server berhenti.
pause
