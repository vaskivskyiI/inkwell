# Writes windows/Inkwell/inkwell.ico (PNG entries at 16-256 px) from the web app's icon (web/public/icon-512.png).
# Run after changing that icon: powershell -File windows/tools/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$src = [System.Drawing.Image]::FromFile((Resolve-Path (Join-Path $PSScriptRoot '..\..\web\public\icon-512.png')))
$out = Join-Path $PSScriptRoot '..\Inkwell\inkwell.ico'

function Scale([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  return , $ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs = $sizes | ForEach-Object { , (Scale $_) }
$f = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $f
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $n = $sizes[$i] % 256
  $w.Write([byte]$n); $w.Write([byte]$n); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$pngs[$i].Length); $w.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
[System.IO.File]::WriteAllBytes([System.IO.Path]::GetFullPath($out), $f.ToArray())
$src.Dispose()
Write-Output "Wrote $out"
