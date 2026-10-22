# Generates the application icons (PNG + ICO) without any extra tooling.
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$iconDir = Join-Path $PSScriptRoot 'src-tauri\icons'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function New-WaifuBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # rounded square background with a pink -> purple gradient
    $pad = [int]($size * 0.06)
    $r = [int]($size * 0.24)
    $rect = New-Object System.Drawing.Rectangle($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 255, 150, 200), [System.Drawing.Color]::FromArgb(255, 120, 70, 190), 55.0)
    $g.FillPath($brush, $path)
    $g.DrawPath((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 255, 255), [Math]::Max(1.0, $size * 0.02))), $path)

    # heart
    $cx = $size * 0.5
    $cy = $size * 0.44
    $w = $size * 0.54
    $h = $size * 0.52
    $tipX = [float]$cx
    $tipY = [float]($cy + $h * 0.50)
    $dipX = [float]$cx
    $dipY = [float]($cy - $h * 0.05)
    $leftX = [float]($cx - $w * 0.5)
    $leftY = [float]($cy - $h * 0.10)
    $rightX = [float]($cx + $w * 0.5)
    $rightY = [float]($cy - $h * 0.10)

    $heart = New-Object System.Drawing.Drawing2D.GraphicsPath
    $heart.StartFigure()
    $heart.AddBezier($tipX, $tipY, [float]($cx - $w * 0.30), [float]($cy + $h * 0.22), [float]($cx - $w * 0.50), [float]($cy + $h * 0.12), $leftX, $leftY)
    $heart.AddBezier($leftX, $leftY, [float]($cx - $w * 0.50), [float]($cy - $h * 0.48), [float]($cx - $w * 0.18), [float]($cy - $h * 0.42), $dipX, $dipY)
    $heart.AddBezier($dipX, $dipY, [float]($cx + $w * 0.18), [float]($cy - $h * 0.42), [float]($cx + $w * 0.50), [float]($cy - $h * 0.48), $rightX, $rightY)
    $heart.AddBezier($rightX, $rightY, [float]($cx + $w * 0.50), [float]($cy + $h * 0.12), [float]($cx + $w * 0.30), [float]($cy + $h * 0.22), $tipX, $tipY)
    $heart.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))), $heart)

    $g.Dispose()
    $brush.Dispose()
    $path.Dispose()
    $heart.Dispose()
    return $bmp
}

function Save-Png([int]$size, [string]$file) {
    $bmp = New-WaifuBitmap $size
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $file"
}

function Get-PngBytes([int]$size) {
    $bmp = New-WaifuBitmap $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return ,$ms.ToArray()
}

Save-Png 32  (Join-Path $iconDir '32x32.png')
Save-Png 128 (Join-Path $iconDir '128x128.png')
Save-Png 256 (Join-Path $iconDir '128x128@2x.png')
Save-Png 512 (Join-Path $iconDir 'icon.png')

# --- build the .ico (PNG compressed entries, supported since Windows Vista) ---
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($s in $sizes) { $images += ,@{ Size = $s; Data = (Get-PngBytes $s) } }

$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0)          # reserved
$writer.Write([UInt16]1)          # type: icon
$writer.Write([UInt16]$images.Count)

$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $writer.Write([Byte]$dim)
    $writer.Write([Byte]$dim)
    $writer.Write([Byte]0)        # palette
    $writer.Write([Byte]0)        # reserved
    $writer.Write([UInt16]1)      # colour planes
    $writer.Write([UInt16]32)     # bits per pixel
    $writer.Write([UInt32]$img.Data.Length)
    $writer.Write([UInt32]$offset)
    $offset += $img.Data.Length
}
foreach ($img in $images) { $writer.Write($img.Data) }
$writer.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $iconDir 'icon.ico'), $stream.ToArray())
$writer.Dispose()
$stream.Dispose()
Write-Host "wrote icon.ico"
