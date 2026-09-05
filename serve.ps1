# ============================================================
#  serve.ps1 - local preview server for this site
#  Usage: double-click this file (or run ./serve.ps1)
#  It starts a static server and opens the page in your browser.
#  Stop the server with Ctrl+C in the window that opens.
#  ASCII-only on purpose: Windows PowerShell 5.1 needs a UTF-8 BOM
#  for non-ASCII content, and a no-BOM file would garble it.
# ============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path (Join-Path $root 'index.html'))) {
    Write-Error "index.html not found next to this script. Run it from the repo folder."
}

# pick the first free port among common ones
$port = $null
foreach ($p in 8000, 8080, 8888) {
    $busy = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
    if (-not $busy) { $port = $p; break }
}
if (-not $port) {
    Write-Error 'Ports 8000/8080/8888 are all in use. Close something and retry.'
}

$url = "http://127.0.0.1:$port/"
Write-Host ''
Write-Host "  Serving: $root" -ForegroundColor Cyan
Write-Host "  Open:    $url"   -ForegroundColor Cyan
Write-Host '  Edit files -> refresh the browser (Ctrl+F5) to see changes.'
Write-Host '  Press Ctrl+C in this window to stop the server.'
Write-Host ''

# locate python (3.x), fall back to py launcher
$py = $null
foreach ($c in 'python', 'py') {
    if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break }
}
if (-not $py) {
    Write-Warning 'python was not found. Alternative one-liner:  npx serve .'
    exit 1
}

# open the browser, then keep the server in the foreground
Start-Process $url
& $py -m http.server $port --bind 127.0.0.1 --directory $root
