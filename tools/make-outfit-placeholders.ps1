<#
.SYNOPSIS
  Creates the placeholder texture atlases for every outfit of a character.

.DESCRIPTION
  Aria's model has two texture pages: `texture_00` holds the body, the head,
  the hair and the face, `texture_01` holds the clothes. An outfit is
  therefore only the second page: the engine loads
  `outfits/<outfit id>/texture_01.png` and binds it to the texture index of
  the clothes, the first page stays the base artwork.

  This script writes a placeholder for that page for every outfit folder. The
  placeholder is the base artwork with the colours of the clothes replaced by
  the palette of the outfit and a label on it, so the outfit switch can be
  seen at a glance and the UV layout stays readable. The real artwork can be
  painted over it later, the file name and the pixel size do not change.

  The alpha channel is never touched: the placeholders have the exact same
  silhouette as the base model, so the click through of the overlay keeps
  working and the hit map does not change.

  Run it again after you replaced a placeholder, it only writes the files that
  are missing.

.PARAMETER Root
  The folder that holds the character folders, e.g. "...\assets\characters".

.PARAMETER Character
  The name of the character folder, e.g. "aria".

.PARAMETER Force
  Overwrite the placeholders that are already there.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\make-outfit-placeholders.ps1
#>
param(
  [string]$Root = (Join-Path (Split-Path $PSScriptRoot -Parent) "assets\characters"),
  [string]$Character = "aria",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# The palette of every outfit. The colours of the clothes of the base artwork
# are replaced by them, the shading of every piece is kept.
#
# The order matters: the first colour is the biggest piece of clothing, the
# second one the next and so on.
$PALETTES = @{
  "default"       = @( @( 63, 48, 62 ), @( 48, 30, 40 ), @( 32, 20, 63 ), @( 99, 85, 96 ), @( 146, 130, 136 ), @( 224, 224, 222 ), @( 245, 243, 241 ), @( 89, 69, 78 ), @( 174, 121, 47 ), @( 109, 36, 18 ) )
  "bunny"         = @( @( 238, 236, 240 ), @( 255, 79, 163 ), @( 255, 173, 208 ), @( 250, 246, 250 ), @( 255, 226, 240 ), @( 255, 255, 255 ), @( 245, 240, 246 ), @( 214, 60, 138 ), @( 120, 40, 80 ), @( 255, 190, 120 ) )
  "knit"          = @( @( 242, 227, 208 ), @( 232, 115, 90 ), @( 196, 85, 63 ), @( 250, 236, 218 ), @( 255, 245, 232 ), @( 255, 246, 234 ), @( 232, 214, 190 ), @( 170, 60, 45 ), @( 120, 90, 70 ), @( 220, 160, 120 ) )
  "qipao"         = @( @( 192, 24, 43 ), @( 232, 178, 58 ), @( 120, 14, 30 ), @( 226, 110, 100 ), @( 245, 220, 190 ), @( 247, 233, 210 ), @( 210, 200, 180 ), @( 150, 30, 40 ), @( 90, 20, 25 ), @( 200, 150, 60 ) )
  "streetwear"    = @( @( 30, 124, 140 ), @( 42, 47, 54 ), @( 87, 210, 224 ), @( 60, 160, 175 ), @( 150, 200, 210 ), @( 215, 228, 230 ), @( 195, 210, 212 ), @( 30, 60, 70 ), @( 90, 100, 110 ), @( 240, 190, 60 ) )
  "smart_casual"  = @( @( 38, 69, 110 ), @( 78, 124, 176 ), @( 168, 196, 224 ), @( 90, 140, 190 ), @( 200, 220, 240 ), @( 240, 244, 248 ), @( 220, 230, 240 ), @( 30, 45, 70 ), @( 120, 140, 160 ), @( 200, 180, 140 ) )
  "gothic_maid"   = @( @( 23, 20, 28 ), @( 43, 37, 51 ), @( 183, 154, 222 ), @( 60, 52, 72 ), @( 110, 100, 125 ), @( 242, 238, 246 ), @( 215, 210, 225 ), @( 90, 80, 105 ), @( 140, 40, 60 ), @( 200, 190, 210 ) )
  "vintage_swing" = @( @( 216, 162, 43 ), @( 168, 50, 47 ), @( 47, 125, 116 ), @( 235, 190, 90 ), @( 245, 225, 180 ), @( 246, 233, 200 ), @( 225, 210, 175 ), @( 120, 60, 40 ), @( 60, 110, 100 ), @( 220, 120, 60 ) )
}

if (-not ("AtlasTools" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class AtlasTools
{
    /// The alpha coverage of every cell of the atlas, 0..1.
    public static float[] Coverage(Bitmap bmp, int cols, int rows)
    {
        Rectangle rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] px = new byte[data.Stride * data.Height];
        Marshal.Copy(data.Scan0, px, 0, px.Length);
        bmp.UnlockBits(data);

        float[] cells = new float[cols * rows];
        int cellW = (bmp.Width + cols - 1) / cols;
        int cellH = (bmp.Height + rows - 1) / cols;
        for (int row = 0; row < rows; row++)
        {
            for (int col = 0; col < cols; col++)
            {
                int solid = 0;
                int total = 0;
                for (int y = row * cellH; y < Math.Min((row + 1) * cellH, bmp.Height); y += 2)
                {
                    int offset = y * data.Stride + col * cellW * 4 + 3;
                    for (int x = 0; x < cellW; x += 2)
                    {
                        int at = offset + x * 4;
                        if (at + 3 >= px.Length) break;
                        if (px[at + 3] > 24) solid++;
                        total++;
                    }
                }
                cells[row * cols + col] = total > 0 ? (float)solid / total : 0f;
            }
        }
        return cells;
    }

    /// The pieces of the artwork: the colours that are used, grouped by how
    /// close they are to each other. The biggest piece comes first.
    static List<int[]> Pieces(Bitmap bmp, int radius)
    {
        Rectangle rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] px = new byte[data.Stride * data.Height];
        Marshal.Copy(data.Scan0, px, 0, px.Length);
        bmp.UnlockBits(data);

        int buckets = 32;
        int[] hits = new int[buckets * buckets * buckets];
        long[] sumR = new long[hits.Length], sumG = new long[hits.Length], sumB = new long[hits.Length];
        for (int y = 0; y < bmp.Height; y++)
        {
            int row = y * data.Stride;
            for (int x = 0; x < bmp.Width; x++)
            {
                int i = row + x * 4;
                if (px[i + 3] < 200) continue;
                int r = px[i], g = px[i + 1], b = px[i + 2];
                int key = ((r * 32) / 256) * 1024 + ((g * 32) / 256) * 32 + ((b * 32) / 256);
                hits[key]++; sumR[key] += r; sumG[key] += g; sumB[key] += b;
            }
        }

        List<int> order = new List<int>();
        for (int i = 0; i < hits.Length; i++) if (hits[i] > 0) order.Add(i);
        order.Sort((a, b) => hits[b].CompareTo(hits[a]));

        List<int[]> pieces = new List<int[]>();
        int limit = Math.Min(order.Count, 400);
        for (int i = 0; i < limit; i++)
        {
            int key = order[i];
            int r = (int)(sumR[key] / hits[key]), g = (int)(sumG[key] / hits[key]), b = (int)(sumB[key] / hits[key]);
            int found = -1;
            for (int p = 0; p < pieces.Count; p++)
            {
                int[] piece = pieces[p];
                int d = (piece[0] - r) * (piece[0] - r) + (piece[1] - g) * (piece[1] - g) + (piece[2] - b) * (piece[2] - b);
                if (d <= radius * radius) { found = p; break; }
            }
            if (found < 0)
            {
                pieces.Add(new int[] { r, g, b, hits[key] });
            }
            else
            {
                int[] piece = pieces[found];
                long total = piece[3] + hits[key];
                piece[0] = (int)((piece[0] * piece[3] + r * hits[key]) / total);
                piece[1] = (int)((piece[1] * piece[3] + g * hits[key]) / total);
                piece[2] = (int)((piece[2] * piece[3] + b * hits[key]) / total);
                piece[3] = (int)total;
            }
        }
        pieces.Sort((a, b) => b[3].CompareTo(a[3]));
        return pieces;
    }

    /// Replaces the colours of the artwork with the palette of the outfit.
    ///
    /// The shading of every piece is kept: the colour of a pixel is the new
    /// colour scaled by how bright the old one was. The alpha channel is not
    /// touched at all.
    ///
    /// @return the number of pixels that were recoloured.
    public static int PaletteSwap(Bitmap bmp, int[] palette, int radius, int tolerance)
    {
        List<int[]> pieces = Pieces(bmp, radius);
        int count = Math.Min(pieces.Count, palette.Length / 3);
        if (count == 0) return 0;

        Rectangle rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        byte[] px = new byte[data.Stride * data.Height];
        Marshal.Copy(data.Scan0, px, 0, px.Length);

        int changed = 0;
        for (int y = 0; y < bmp.Height; y++)
        {
            int row = y * data.Stride;
            for (int x = 0; x < bmp.Width; x++)
            {
                int i = row + x * 4;
                if (px[i + 3] == 0) continue;
                int r = px[i], g = px[i + 1], b = px[i + 2];

                int best = -1;
                int bestDist = tolerance * tolerance;
                for (int p = 0; p < count; p++)
                {
                    int[] piece = pieces[p];
                    int d = (piece[0] - r) * (piece[0] - r) + (piece[1] - g) * (piece[1] - g) + (piece[2] - b) * (piece[2] - b);
                    if (d <= bestDist) { bestDist = d; best = p; }
                }
                if (best < 0) continue;

                int[] source = pieces[best];
                int[] target = new int[] {
                    palette[best * 3], palette[best * 3 + 1], palette[best * 3 + 2]
                };
                double lum = 0.299 * r + 0.587 * g + 0.114 * b;
                double srcLum = 0.299 * source[0] + 0.587 * source[1] + 0.114 * source[2];
                double scale = srcLum > 12.0 ? lum / srcLum : 1.0;
                if (scale > 3.0) scale = 3.0;
                if (scale < 0.0) scale = 0.0;

                int nr = (int)(target[0] * scale);
                int ng = (int)(target[1] * scale);
                int nb = (int)(target[2] * scale);
                if (nr > 255) nr = 255;
                if (ng > 255) ng = 255;
                if (nb > 255) nb = 255;
                if (nr == r && ng == g && nb == b) continue;

                px[i] = (byte)nr;
                px[i + 1] = (byte)ng;
                px[i + 2] = (byte)nb;
                changed++;
            }
        }

        Marshal.Copy(px, 0, data.Scan0, px.Length);
        bmp.UnlockBits(data);
        return changed;
    }

    /// Paints a label layer over the atlas. Only the colours are taken over,
    /// the alpha channel of the atlas stays exactly as it is, so the
    /// silhouette of the character does not change at all.
    public static void BlendLabel(Bitmap target, Bitmap layer)
    {
        Rectangle rect = new Rectangle(0, 0, target.Width, target.Height);
        BitmapData dstData = target.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        BitmapData srcData = layer.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] dst = new byte[dstData.Stride * dstData.Height];
        byte[] src = new byte[srcData.Stride * srcData.Height];
        Marshal.Copy(dstData.Scan0, dst, 0, dst.Length);
        Marshal.Copy(srcData.Scan0, src, 0, src.Length);
        for (int row = 0; row < target.Height; row++)
        {
            int d = row * dstData.Stride;
            int s = row * srcData.Stride;
            for (int col = 0; col < target.Width; col++)
            {
                int di = d + col * 4;
                int si = s + col * 4;
                if (dst[di + 3] == 0) continue;
                int la = src[si + 3];
                if (la == 0) continue;
                for (int c = 0; c < 3; c++)
                {
                    dst[di + c] = (byte)((dst[di + c] * (255 - la) + src[si + c] * la) / 255);
                }
            }
        }
        Marshal.Copy(dst, 0, dstData.Scan0, dst.Length);
        target.UnlockBits(dstData);
        layer.UnlockBits(srcData);
    }

    /// True when both bitmaps have the exact same alpha channel.
    public static bool SameAlpha(Bitmap a, Bitmap b)
    {
        if (a.Width != b.Width || a.Height != b.Height) return false;
        byte[] x = Alpha(a);
        byte[] y = Alpha(b);
        for (int i = 0; i < x.Length; i++) if (x[i] != y[i]) return false;
        return true;
    }

    static byte[] Alpha(Bitmap bmp)
    {
        Rectangle rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] px = new byte[data.Stride * data.Height];
        Marshal.Copy(data.Scan0, px, 0, px.Length);
        bmp.UnlockBits(data);
        byte[] alpha = new byte[bmp.Width * bmp.Height];
        for (int row = 0; row < bmp.Height; row++)
        {
            for (int col = 0; col < bmp.Width; col++)
            {
                alpha[row * bmp.Width + col] = px[row * data.Stride + col * 4 + 3];
            }
        }
        return alpha;
    }
}
"@ -ReferencedAssemblies System.Drawing
}

function Get-ModelAtlases([string]$baseDir) {
  $model = Get-ChildItem (Join-Path $baseDir "*.model3.json") | Select-Object -First 1
  if (-not $model) { throw "no .model3.json in $baseDir" }
  $json = Get-Content $model.FullName -Raw | ConvertFrom-Json
  $atlases = @()
  foreach ($rel in $json.FileReferences.Textures) {
    $path = Join-Path $baseDir ($rel -replace "/", "\")
    if (-not (Test-Path $path)) { continue }
    $img = [System.Drawing.Image]::FromFile($path)
    $atlases += [pscustomobject]@{
      Rel    = $rel
      Name   = Split-Path $rel -Leaf
      Width  = $img.Width
      Height = $img.Height
      Path   = $path
    }
    $img.Dispose()
  }
  if ($atlases.Count -eq 0) { throw "the model has no textures" }
  return $atlases
}

function Find-LabelSpot($coverage, [int]$width, [int]$height) {
  # The label is put on a part of the atlas that is already opaque. There the
  # alpha does not change, so the silhouette of the character stays exactly
  # the same and no ghost appears in a transparent hole.
  $cols = 64
  $cellW = [int][Math]::Ceiling($width / $cols)
  $cellH = [int][Math]::Ceiling($height / $cols)
  $best = $null
  for ($top = 0; $top -le $cols - 3; $top++) {
    $run = 0
    $runStart = 0
    for ($col = 0; $col -lt $cols; $col++) {
      $solid = $true
      for ($r = $top; $r -lt $top + 3; $r++) {
        if ($coverage[$r * $cols + $col] -lt 0.6) { $solid = $false; break }
      }
      if ($solid) {
        if ($run -eq 0) { $runStart = $col }
        $run++
      } else {
        if ($run -gt 0 -and ($null -eq $best -or $run -gt $best.Cells)) {
          $best = [pscustomobject]@{ Cells = $run; Col = $runStart; Row = $top }
        }
        $run = 0
      }
    }
    if ($run -gt 0 -and ($null -eq $best -or $run -gt $best.Cells)) {
      $best = [pscustomobject]@{ Cells = $run; Col = $runStart; Row = $top }
    }
  }
  if ($null -eq $best) {
    return [pscustomobject]@{ X = 0; Y = 0; W = $width; H = 150 }
  }
  $w = $best.Cells * $cellW
  $h = 3 * $cellH
  if ($w -gt $width - 60) { $w = $width - 60 }
  if ($h -gt 190) { $h = 190 }
  if ($w -lt 420) { $w = [Math]::Min(420, $width - 60) }
  return [pscustomobject]@{
    X = [Math]::Max(0, $best.Col * $cellW)
    Y = [Math]::Max(0, $best.Row * $cellH)
    W = $w
    H = $h
  }
}

function New-Placeholder([string]$basePath, [string]$outPath, [string]$label, [string]$sub, [int[]]$palette) {
  $base = New-Object System.Drawing.Bitmap($basePath)
  $bmp = New-Object System.Drawing.Bitmap($base.Width, $base.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($base, 0, 0)
  $g.Dispose()

  # The clothes get the colours of the outfit. The shading of every piece is
  # kept and the alpha channel is untouched.
  $changed = [AtlasTools]::PaletteSwap($bmp, $palette, 26, 64)

  $coverage = [AtlasTools]::Coverage($bmp, 64, 64)
  $spot = Find-LabelSpot $coverage $bmp.Width $bmp.Height

  # The label is drawn on its own layer and is mixed into the atlas without
  # touching the alpha channel.
  $layer = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($layer)
  $g.Clear([System.Drawing.Color]::Transparent)
  $pad = 16
  $boxX = $spot.X + $pad
  $boxY = $spot.Y + $pad
  $boxW = $spot.W - 2 * $pad
  $boxH = $spot.H - 2 * $pad
  if ($boxW -gt 60 -and $boxH -gt 60) {
    $plate = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 18, 14, 26))
    $g.FillRectangle($plate, $boxX, $boxY, $boxW, $boxH)
    $plate.Dispose()
    $edge = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 158, 199), 4)
    $g.DrawRectangle($edge, $boxX, $boxY, $boxW, $boxH)
    $edge.Dispose()

    $size = 58
    $font = $null
    while ($size -ge 22) {
      $candidate = New-Object System.Drawing.Font("Segoe UI", $size, [System.Drawing.FontStyle]::Bold)
      $measured = $g.MeasureString($label, $candidate)
      if ($measured.Width -le $boxW - 28) { $font = $candidate; break }
      $candidate.Dispose()
      $size -= 4
    }
    if ($font) {
      $g.DrawString($label, $font, [System.Drawing.Brushes]::White, ($boxX + 14), ($boxY + 4))
      $font.Dispose()
    }
    $small = New-Object System.Drawing.Font("Segoe UI", 21)
    $grey = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 205, 195, 220))
    $g.DrawString($sub, $small, $grey, ($boxX + 14), ($boxY + $boxH - 30))
    $small.Dispose()
    $grey.Dispose()
  }
  $g.Dispose()
  [AtlasTools]::BlendLabel($bmp, $layer)
  $layer.Dispose()

  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  # The silhouette must not change, the click through depends on it.
  $check = New-Object System.Drawing.Bitmap($outPath)
  $same = [AtlasTools]::SameAlpha($base, $check)
  $check.Dispose()
  $base.Dispose()
  if (-not $same) {
    throw "the alpha of $outPath differs from the base atlas"
  }
  return $changed
}

$charDir = Join-Path $Root $Character
$baseDir = Join-Path $charDir "base"
$outfitsDir = Join-Path $charDir "outfits"
if (-not (Test-Path $baseDir)) { throw "the character has no base folder: $baseDir" }

$atlases = Get-ModelAtlases $baseDir
Write-Host "Base model: $baseDir"
foreach ($atlas in $atlases) {
  Write-Host ("  page {0,-18} {1}x{2}  ({3})" -f $atlas.Name, $atlas.Width, $atlas.Height, $atlas.Rel)
}

# The page with the clothes. The page with the body, the head and the face
# belongs to the model and is never part of an outfit.
$clothing = $atlases | Where-Object { $_.Name -eq "texture_01.png" } | Select-Object -First 1
if (-not $clothing) { $clothing = $atlases[1] }
if (-not $clothing) { throw "the model has no clothing page" }
Write-Host ("Clothing page: {0} ({1}x{2})" -f $clothing.Name, $clothing.Width, $clothing.Height)
Write-Host ""

$written = @()
foreach ($folder in (Get-ChildItem $outfitsDir -Directory | Sort-Object Name)) {
  $id = $folder.Name
  $manifestPath = Join-Path $folder.FullName "outfit.json"
  $label = $id
  if (Test-Path $manifestPath) {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.label) { $label = $manifest.label }
  }
  if (-not $PALETTES.ContainsKey($id)) { throw "there is no palette for the outfit $id" }
  # The palette is a flat list of colours: r, g, b for every piece.
  $palette = [int[]]@($PALETTES[$id] | ForEach-Object { $_ })

  # The outfit folder holds the clothing page and nothing else. A file of the
  # face page would be ignored by the engine.
  foreach ($stray in (Get-ChildItem $folder.FullName -Filter "*.png" | Where-Object { $_.Name -ne $clothing.Name })) {
    Write-Warning "$($stray.FullName) is not used by the engine, the face page belongs to the model"
  }

  $out = Join-Path $folder.FullName $clothing.Name
  if ((Test-Path $out) -and -not $Force) { continue }
  $sub = "placeholder $($clothing.Width)x$($clothing.Height) - paint over it, keep the size"
  $changed = New-Placeholder $clothing.Path $out $label $sub $palette
  $written += [pscustomobject]@{ File = $out; Changed = $changed }
}

Write-Host ""
if ($written.Count -eq 0) {
  Write-Host "Everything is already there, nothing was written."
} else {
  Write-Host "Written:"
  foreach ($item in $written) {
    $info = Get-Item $item.File
    Write-Host ("  {0}  ({1:N0} bytes, {2:N0} pixels recoloured)" -f $item.File, $info.Length, $item.Changed)
  }
}
Write-Host ""
Write-Host "Every placeholder has the same alpha channel as the base atlas."
