#!/usr/bin/env python3
"""Build Zeiklijst Admin icons (ZLA) from a single SVG source.

Lettering font is Rubik Distressed (OFL), same as the staff ZL icons.

    FONT_PATH=fonts/rubik-distressed.ttf python3 admin/icon-src/build-icons.py

Override with FONT_PATH, or drop a font at admin/icon-src/lettering.ttf.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.misc.transform import Transform
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent
REPO_ADMIN = ROOT.parent
REPO_ROOT = REPO_ADMIN.parent
ICONS = REPO_ADMIN / "icons"
SVG_PATH = ROOT / "icon.svg"

CANVAS = 512
BG = "#231F20"
ORANGE = "#F99D27"
MAGENTA = "#C40070"
STRIPE_OPACITY = 0.20
# Orange:magenta ≈ 2:1, 45° ↗, matching the generic stripe rhythm of the reference.
STRIPE_ORANGE = 48
STRIPE_MAGENTA = 24
STRIPE_PERIOD = STRIPE_ORANGE + STRIPE_MAGENTA
OUTLINE = "#000000"
# Visible outline ≈ stroke/2. ~12px at 512, matching the staff ZL icons.
STROKE = 26
# Content stays inside the maskable safe zone (~80% of the canvas), stroke included.
TARGET_WIDTH = 360
TRACKING = 20  # font units between letters

FONT_CANDIDATES = [
    os.environ.get("FONT_PATH"),
    str(ROOT / "lettering.ttf"),
    str(ROOT / "lettering.otf"),
    str(REPO_ROOT / "fonts" / "rubik-distressed.ttf"),
]

SIZES = {
    "icon-512.png": 512,
    "icon-192.png": 192,
    "apple-touch-icon.png": 180,
}


def resolve_font() -> Path:
    for raw in FONT_CANDIDATES:
        if not raw:
            continue
        expanded = Path(raw).expanduser()
        candidates = [expanded]
        if not expanded.is_absolute():
            candidates.extend([Path.cwd() / expanded, REPO_ROOT / expanded])
        for path in candidates:
            if path.is_file():
                return path.resolve()
    sys.stderr.write(
        "No lettering font found. Set FONT_PATH (e.g. fonts/rubik-distressed.ttf) "
        "or place a font at admin/icon-src/lettering.ttf\n"
    )
    sys.exit(1)


def letter_paths(font_path: Path) -> tuple[str, float, float, float]:
    """Return combined SVG path data, plus width, cap-height, and y-min in font units."""
    font = TTFont(font_path)
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    parts: list[str] = []
    x = 0.0
    y_min = 0.0
    y_max = 0.0
    for index, char in enumerate("ZLA"):
        if index:
            x += TRACKING
        name = cmap.get(ord(char))
        if name is None:
            font.close()
            raise SystemExit(f"Font has no glyph for {char!r}: {font_path}")
        advance, _lsb = font["hmtx"].metrics[name]
        bounds_pen = BoundsPen(glyph_set)
        glyph_set[name].draw(bounds_pen)
        if bounds_pen.bounds:
            _x0, ymin, _x1, ymax = bounds_pen.bounds
            y_min = min(y_min, ymin)
            y_max = max(y_max, ymax)
        path_pen = SVGPathPen(glyph_set)
        transform = Transform(1, 0, 0, 1, x, 0)
        glyph_set[name].draw(TransformPen(path_pen, transform))
        parts.append(path_pen.getCommands())
        x += advance
    font.close()
    return " ".join(parts), x, y_max, y_min


def build_svg(font_path: Path) -> str:
    d, width, cap, y_min = letter_paths(font_path)
    scale = TARGET_WIDTH / width
    # Font y-up → SVG y-down; optically center on cap height.
    height = cap - y_min
    cx = CANVAS / 2
    cy = CANVAS / 2
    # Shift so the visual box of the letters is centered.
    tx = -width / 2
    ty = -(y_min + height / 2)
    transform = f"translate({cx:.2f} {cy:.2f}) scale({scale:.6f} {-scale:.6f}) translate({tx:.2f} {ty:.2f})"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}" width="{CANVAS}" height="{CANVAS}">
  <!-- Temporary lettering: {font_path.name}. Rebuild with FONT_PATH when Dirty Suburban is available. -->
  <defs>
    <pattern id="stripes" patternUnits="userSpaceOnUse" width="{STRIPE_PERIOD}" height="{STRIPE_PERIOD}" patternTransform="rotate(-45 {CANVAS/2} {CANVAS/2})">
      <rect width="{STRIPE_ORANGE}" height="{STRIPE_PERIOD}" fill="{ORANGE}" fill-opacity="{STRIPE_OPACITY}"/>
      <rect x="{STRIPE_ORANGE}" width="{STRIPE_MAGENTA}" height="{STRIPE_PERIOD}" fill="{MAGENTA}" fill-opacity="{STRIPE_OPACITY}"/>
    </pattern>
  </defs>
  <rect width="{CANVAS}" height="{CANVAS}" fill="{BG}"/>
  <rect width="{CANVAS}" height="{CANVAS}" fill="url(#stripes)"/>
  <g transform="{transform}">
    <path d="{d}" fill="{OUTLINE}" stroke="{OUTLINE}" stroke-width="{STROKE / scale:.3f}" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="{d}" fill="{ORANGE}"/>
  </g>
</svg>
"""


def which(names: list[str]) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def render_png(svg: Path, dest: Path, size: int) -> None:
    rsvg = which(["rsvg-convert"])
    if rsvg:
        subprocess.check_call(
            [rsvg, "-w", str(size), "-h", str(size), "-o", str(dest), str(svg)],
        )
        return

    chrome = which(["google-chrome", "chromium", "chromium-browser", "google-chrome-stable"])
    if not chrome:
        sys.stderr.write("Need rsvg-convert or Chrome to rasterize the SVG.\n")
        sys.exit(1)

    html = f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  html, body {{ margin: 0; padding: 0; width: {size}px; height: {size}px; overflow: hidden; background: {BG}; }}
  img {{ display: block; width: {size}px; height: {size}px; }}
</style>
</head>
<body><img src="{svg.name}" alt=""></body>
</html>
"""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        shutil.copy(svg, tmp_dir / svg.name)
        page = tmp_dir / "icon.html"
        page.write_text(html, encoding="utf-8")
        shot = tmp_dir / "shot.png"
        subprocess.check_call(
            [
                chrome,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--no-sandbox",
                "--force-device-scale-factor=1",
                f"--window-size={size},{size}",
                f"--screenshot={shot}",
                f"file://{page}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        from PIL import Image

        image = Image.open(shot).convert("RGBA")
        if image.size != (size, size):
            image = image.resize((size, size), Image.Resampling.LANCZOS)
        # Flatten onto anthracite in case the browser added a transparent edge.
        bg = Image.new("RGBA", (size, size), (35, 31, 32, 255))
        bg.alpha_composite(image)
        bg.convert("RGB").save(dest, "PNG", optimize=True)
        return

    # rsvg path already returned. Chrome path saves and returns.
    # If we used rsvg, dest was written by rsvg (may be RGBA). Normalize below.


def normalize_png(path: Path, size: int) -> None:
    from PIL import Image

    image = Image.open(path).convert("RGBA")
    if image.size != (size, size):
        image = image.resize((size, size), Image.Resampling.LANCZOS)
    bg = Image.new("RGBA", (size, size), (35, 31, 32, 255))
    bg.alpha_composite(image)
    bg.convert("RGB").save(path, "PNG", optimize=True)


def main() -> None:
    font_path = resolve_font()
    print(f"Lettering font: {font_path}")
    svg = build_svg(font_path)
    SVG_PATH.write_text(svg, encoding="utf-8")
    print(f"Wrote {SVG_PATH.relative_to(REPO_ADMIN.parent)}")
    ICONS.mkdir(parents=True, exist_ok=True)
    for name, size in SIZES.items():
        dest = ICONS / name
        render_png(SVG_PATH, dest, size)
        # rsvg may leave RGBA; chrome path already normalizes, but this is safe either way
        normalize_png(dest, size)
        print(f"Wrote {dest.relative_to(REPO_ADMIN.parent)} ({size}x{size})")


if __name__ == "__main__":
    main()
