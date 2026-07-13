#!/usr/bin/env python3
"""Build platform app icons from the canonical transparent Tevada mark."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE_MARK = ROOT / "src/assets/app-icon-v9-transparent.png"
RESOURCES = ROOT / "resources"
PUBLIC = ROOT / "public"
CANVAS_SIZE = 1024
TILE_INSET = 85
TILE_RADIUS = 195
MARK_WIDTH = 554


def rounded_tile() -> Image.Image:
    image = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    tile_mask = Image.new("L", image.size, 0)
    draw = ImageDraw.Draw(tile_mask)
    bounds = (TILE_INSET, TILE_INSET, CANVAS_SIZE - TILE_INSET, CANVAS_SIZE - TILE_INSET)
    draw.rounded_rectangle(bounds, radius=TILE_RADIUS, fill=255)

    # A restrained graphite gradient keeps the icon from reading as a flat
    # black hole in the Dock while retaining the quiet developer-tool palette.
    gradient = Image.new("RGBA", image.size)
    pixels = gradient.load()
    for y in range(CANVAS_SIZE):
        t = y / (CANVAS_SIZE - 1)
        value = round(42 + (25 - 42) * t)
        for x in range(CANVAS_SIZE):
            pixels[x, y] = (value, value + 1, value + 4, 255)
    image.paste(gradient, (0, 0), tile_mask)

    # Hairline highlights retain definition against both light and dark docks.
    edge = Image.new("RGBA", image.size, (0, 0, 0, 0))
    edge_draw = ImageDraw.Draw(edge)
    edge_draw.rounded_rectangle(
        bounds, radius=TILE_RADIUS, outline=(255, 255, 255, 30), width=3
    )
    inner_bounds = tuple(value + offset for value, offset in zip(bounds, (4, 4, -4, -4)))
    edge_draw.rounded_rectangle(
        inner_bounds, radius=TILE_RADIUS - 4, outline=(0, 0, 0, 42), width=2
    )
    image.alpha_composite(edge)
    return image


def add_mark(image: Image.Image) -> None:
    source = Image.open(SOURCE_MARK).convert("RGBA")
    alpha = source.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise RuntimeError(f"Tevada mark is empty: {SOURCE_MARK}")

    alpha = alpha.crop(bbox)
    target_width = MARK_WIDTH
    target_height = round(alpha.height * target_width / alpha.width)
    alpha = alpha.resize((target_width, target_height), Image.Resampling.LANCZOS)

    # Warm white avoids the harsh pasted-on appearance of pure white.
    mark = Image.new("RGBA", alpha.size, (247, 247, 244, 255))
    mark.putalpha(alpha)
    position = ((CANVAS_SIZE - target_width) // 2, (CANVAS_SIZE - target_height) // 2 + 4)
    image.alpha_composite(mark, position)


def write_pngs(master: Image.Image) -> None:
    for destination in (
        RESOURCES / "icon.png",
        RESOURCES / "dock-icon.png",
        PUBLIC / "icon.png",
    ):
        master.save(destination, "PNG", optimize=True)


def write_ico(master: Image.Image) -> None:
    master.save(
        RESOURCES / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def write_icns(master: Image.Image) -> None:
    iconutil = shutil.which("iconutil")
    if not iconutil:
        raise RuntimeError("iconutil is required to build the macOS .icns file")

    with tempfile.TemporaryDirectory() as temporary_directory:
        iconset = Path(temporary_directory) / "icon.iconset"
        iconset.mkdir()
        entries = (
            (16, "icon_16x16.png"),
            (32, "icon_16x16@2x.png"),
            (32, "icon_32x32.png"),
            (64, "icon_32x32@2x.png"),
            (128, "icon_128x128.png"),
            (256, "icon_128x128@2x.png"),
            (256, "icon_256x256.png"),
            (512, "icon_256x256@2x.png"),
            (512, "icon_512x512.png"),
            (1024, "icon_512x512@2x.png"),
        )
        for size, filename in entries:
            resized = master.resize((size, size), Image.Resampling.LANCZOS)
            resized.save(iconset / filename, "PNG", optimize=True)
        subprocess.run(
            [iconutil, "--convert", "icns", "--output", str(RESOURCES / "icon.icns"), str(iconset)],
            check=True,
        )


def main() -> None:
    master = rounded_tile()
    add_mark(master)
    write_pngs(master)
    write_ico(master)
    write_icns(master)


if __name__ == "__main__":
    main()
