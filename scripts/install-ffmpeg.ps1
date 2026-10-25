# Downloads a static FFmpeg build for Windows and places ffmpeg.exe + ffprobe.exe
# into <project>\ffmpeg\bin\. Exits 0 on success, 1 on failure.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $projectRoot 'ffmpeg\bin'
$tmp = Join-Path $env:TEMP ("p4us-ffmpeg-" + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $tmp 'ffmpeg.zip'

# Primary: gyan.dev (official Windows builds linked from ffmpeg.org)
# Fallback: BtbN GitHub release
$sources = @(
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
)

try {
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null

    $downloaded = $false
    foreach ($url in $sources) {
        try {
            Write-Host "      Mengunduh dari: $url"
            Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
            $downloaded = $true
            break
        } catch {
            Write-Host "      Sumber gagal, mencoba alternatif..."
        }
    }
    if (-not $downloaded) { throw "Semua sumber unduhan gagal." }

    Write-Host "      Mengekstrak..."
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    $ffmpeg = Get-ChildItem -Path $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    $ffprobe = Get-ChildItem -Path $tmp -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
    if (-not $ffmpeg) { throw "ffmpeg.exe tidak ditemukan dalam arsip." }

    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item $ffmpeg.FullName (Join-Path $binDir 'ffmpeg.exe') -Force
    if ($ffprobe) { Copy-Item $ffprobe.FullName (Join-Path $binDir 'ffprobe.exe') -Force }

    Write-Host "      Terpasang di: $binDir"
    exit 0
}
catch {
    Write-Host "      ERROR: $($_.Exception.Message)"
    exit 1
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
