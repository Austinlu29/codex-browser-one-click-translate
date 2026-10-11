# Render this project's simple, outlined SVG icon without requiring fonts.
Add-Type -AssemblyName System.Drawing
$iconDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'page-translator/icons'
[xml]$source = Get-Content -LiteralPath (Join-Path $iconDirectory 'icon.svg') -Raw
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$radius = [single]::Parse($source.svg.rect.rx, $culture)
$blue = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($source.svg.rect.fill))
$white = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($source.svg.path.fill))
$coordinates = [regex]::Matches($source.svg.path.d, '-?\d+(?:\.\d+)?')
$points = [System.Collections.Generic.List[System.Drawing.PointF]]::new()
for ($i = 0; $i -lt $coordinates.Count; $i += 2) {
    $points.Add([System.Drawing.PointF]::new([single]::Parse($coordinates[$i].Value, $culture), [single]::Parse($coordinates[$i + 1].Value, $culture)))
}
$letter = [System.Drawing.Drawing2D.GraphicsPath]::new()
$letter.AddPolygon($points.ToArray())
$background = [System.Drawing.Drawing2D.GraphicsPath]::new()
$diameter = $radius * 2
$background.AddArc(0, 0, $diameter, $diameter, 180, 90)
$background.AddArc(512 - $diameter, 0, $diameter, $diameter, 270, 90)
$background.AddArc(512 - $diameter, 512 - $diameter, $diameter, $diameter, 0, 90)
$background.AddArc(0, 512 - $diameter, $diameter, $diameter, 90, 90)
$background.CloseFigure()
foreach ($size in @(16, 32, 48, 128, 512)) {
    $large = [System.Drawing.Bitmap]::new($size * 4, $size * 4, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($large)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform([single]($size * 4 / 512), [single]($size * 4 / 512))
    $graphics.FillPath($blue, $background)
    $graphics.FillPath($white, $letter)
    $image = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $resize = [System.Drawing.Graphics]::FromImage($image)
    $resize.Clear([System.Drawing.Color]::Transparent)
    $resize.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $resize.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $edges = [System.Drawing.Imaging.ImageAttributes]::new()
    $edges.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $resize.DrawImage($large, [System.Drawing.Rectangle]::new(0, 0, $size, $size), 0, 0, $large.Width, $large.Height, [System.Drawing.GraphicsUnit]::Pixel, $edges)
    if ($image.GetPixel(0, 0).A -ne 0 -or $image.GetPixel([int]($size / 2), [int]($size / 2)).R -ne 255) {
        throw "Icon transparency or white letter verification failed: $size"
    }
    $image.Save((Join-Path $iconDirectory "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $edges.Dispose(); $resize.Dispose(); $image.Dispose(); $graphics.Dispose(); $large.Dispose()
}
$background.Dispose(); $letter.Dispose(); $blue.Dispose(); $white.Dispose()
Write-Output 'Rendered rounded icons at 16, 32, 48, 128 and 512 px; transparent corners verified.'
