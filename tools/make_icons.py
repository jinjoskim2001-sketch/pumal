#!/usr/bin/env python3
"""Generate every icon in icons/ from our own pixel art.

usage: python3 tools/make_icons.py

The picture is the baby creature (`mongsil`) as chunky LCD dots on the pea backing, inside
a dark bezel, on a yolk-yellow field. The bitmap is read from js/art/young.js through node
(the same way tools/sheet.py does); until that module exists the style anchor in
js/art/anchor.js stands in, so re-run this script once the real baby is drawn.

Outputs (all fully opaque RGB, square corners — the platforms apply their own masks):
  apple-touch-icon-180.png   icon-192.png   icon-512.png
  icon-maskable-512.png      (art inside the central 60 %)
  favicon-32.png             (pixel-exact, 2 px per dot)
  og-800x400.png             (link preview; everything that matters sits in the centre square)
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"

YOLK = (255, 200, 61)
YOLK_HI = (255, 214, 96)
YOLK_LO = (244, 180, 34)
BEZEL = (43, 43, 46)
PEA = (197, 207, 164)
INK = (30, 42, 28)
PAGE = (16, 17, 20)
MILK = (243, 239, 228)
MILK_SHADE = (207, 200, 182)
SOFT = (207, 203, 191)

SS = 4  # supersampling factor for everything that has curves

HANGUL_FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
HANGUL_FONT_INDEX = 4  # SemiBold

DUMP = r"""
const load = async (p) => { try { return await import(p); } catch { return null; } };
const young = await load(process.argv[1]);
const anchor = await load(process.argv[2]);
const real = young && young.YOUNG && young.YOUNG.mongsil && young.YOUNG.mongsil.idle;
const idle = real || (anchor && anchor.ANCHOR && anchor.ANCHOR.idle) || null;
console.log(JSON.stringify({ source: real ? 'js/art/young.js' : 'js/art/anchor.js', idle }));
"""

# The wordmark as dots, drawn here by hand so the preview image needs no web font.
WORD_PUM = [
    "###########",
    "..#.....#..",
    "..#.....#..",
    "###########",
    "...........",
    "###########",
    ".....#.....",
    ".....#.....",
    ".#########.",
    ".#.......#.",
    ".#.......#.",
    ".#########.",
]
WORD_AL = [
    "..####...#.",
    ".#....#..#.",
    ".#....#..##",
    ".#....#..#.",
    "..####...#.",
    "...........",
    ".#########.",
    ".........#.",
    ".#########.",
    ".#.........",
    ".#.........",
    ".#########.",
]
DECO_HEART = [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."]
DECO_SPARK = ["..#..", "..#..", "##.##", "..#..", "..#.."]
DECO_STAR = ["...#...", "..###..", "#######", ".#####.", ".##.##.", "##...##"]


def load_mascot():
    young = (ROOT / "js/art/young.js").resolve().as_uri()
    anchor = (ROOT / "js/art/anchor.js").resolve().as_uri()
    res = subprocess.run(
        ["node", "--input-type=module", "-e", DUMP, young, anchor],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        print(res.stderr, file=sys.stderr)
        sys.exit(1)
    data = json.loads(res.stdout)
    if not data["idle"]:
        print("no mascot bitmap found in js/art/young.js or js/art/anchor.js", file=sys.stderr)
        sys.exit(1)
    return data["idle"][0], data["source"]


def bbox(bmp):
    xs = [x for row in bmp for x, c in enumerate(row) if c == "#"]
    ys = [y for y, row in enumerate(bmp) if "#" in row]
    return min(xs), min(ys), max(xs), max(ys)


def window(bmp, cols, rows, ground=1):
    """Lit cells of `bmp` placed in a cols x rows matrix: centred, standing `ground` dots
    above the bottom edge."""
    x0, y0, x1, y1 = bbox(bmp)
    w, h = x1 - x0 + 1, y1 - y0 + 1
    ox = (cols - w) // 2
    oy = rows - ground - h
    cells = set()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if bmp[y][x] == "#":
                cells.add((x - x0 + ox, y - y0 + oy))
    return cells


def vgradient(size, top, mid, bottom):
    w, h = size
    col = Image.new("RGB", (1, h))
    px = col.load()
    for y in range(h):
        t = y / max(1, h - 1)
        a, b, u = (top, mid, t / 0.5) if t < 0.5 else (mid, bottom, (t - 0.5) / 0.5)
        px[0, y] = tuple(round(a[i] + (b[i] - a[i]) * u) for i in range(3))
    return col.resize((w, h))


def paste_alpha(base, colour, mask, opacity=1.0):
    """Composite a flat colour through an L mask onto an RGB image."""
    if opacity < 1.0:
        mask = mask.point(lambda v: int(v * opacity))
    base.paste(Image.new("RGB", base.size, colour), (0, 0), mask)


def rounded_mask(size, box, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m


def draw_lcd(img, box, cells, cols, rows, ghost=0.08, gap=0.12, shadow=0.22):
    """Pea backing + dot matrix inside `box` (already in supersampled pixels)."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    radius = min(w, h) * 0.13
    size = img.size
    paste_alpha(img, PEA, rounded_mask(size, box, radius))

    pitch = min(w / cols, h / rows)
    ox = x0 + (w - pitch * cols) / 2
    oy = y0 + (h - pitch * rows) / 2
    dot = pitch * (1 - gap)
    pad = (pitch - dot) / 2
    corner = dot * 0.12

    def layer(which, shift=0.0):
        m = Image.new("L", size, 0)
        d = ImageDraw.Draw(m)
        for cy in range(rows):
            for cx in range(cols):
                if which == "lit" and (cx, cy) not in cells:
                    continue
                px = ox + cx * pitch + pad + shift
                py = oy + cy * pitch + pad + shift
                d.rounded_rectangle((px, py, px + dot, py + dot), radius=corner, fill=255)
        return m

    clip = rounded_mask(size, box, radius)
    if ghost > 0:
        paste_alpha(img, INK, ImageChops.multiply(layer("all"), clip), ghost)
    if shadow > 0:
        paste_alpha(img, INK, ImageChops.multiply(layer("lit", pitch * 0.13), clip), shadow)
    paste_alpha(img, INK, layer("lit"), 0.94)

    # Glass: a soft inner shadow along the top edge and one diagonal glare.
    inner = Image.new("L", size, 0)
    ImageDraw.Draw(inner).rounded_rectangle(
        (x0 + w * 0.02, y0 + h * 0.07, x1 - w * 0.02, y1 + h * 0.2), radius=radius, fill=255)
    inner = inner.filter(ImageFilter.GaussianBlur(h * 0.035))
    edge = ImageChops.multiply(ImageChops.invert(inner), clip)
    paste_alpha(img, (0, 0, 0), edge, 0.22)

    glare = Image.new("L", size, 0)
    ImageDraw.Draw(glare).polygon(
        [(x0, y0), (x0 + w * 0.62, y0), (x0 + w * 0.18, y1), (x0, y1)], fill=255)
    glare = glare.filter(ImageFilter.GaussianBlur(w * 0.11))
    paste_alpha(img, (255, 255, 255), ImageChops.multiply(glare, clip), 0.16)


def draw_plate(img, cx, cy, side, cells, cols, rows, ghost):
    """The dark bezel with the LCD in it, centred on (cx, cy)."""
    size = img.size
    half = side / 2
    box = (cx - half, cy - half, cx + half, cy + half)
    radius = side * 0.2

    # Lift the plate off the yolk with a short, warm shadow.
    sh = rounded_mask(size, (box[0], box[1] + side * 0.035, box[2], box[3] + side * 0.035), radius)
    sh = sh.filter(ImageFilter.GaussianBlur(side * 0.03))
    paste_alpha(img, (120, 74, 0), sh, 0.42)

    paste_alpha(img, BEZEL, rounded_mask(size, box, radius))
    # 1-step lighter lip on the top edge of the bezel.
    lip = ImageChops.subtract(
        rounded_mask(size, box, radius),
        rounded_mask(size, (box[0], box[1] + side * 0.012, box[2], box[3] + side * 0.012), radius))
    paste_alpha(img, (255, 255, 255), lip, 0.16)

    inset = side * 0.088
    draw_lcd(img, (box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset),
             cells, cols, rows, ghost=ghost)


def make_icon(px, mascot, plate=0.78, ghost=0.08):
    n = px * SS
    img = vgradient((n, n), YOLK_HI, YOLK, YOLK_LO)
    x0, y0, x1, y1 = bbox(mascot)
    # 13 dots across keeps the dots chunky; a bigger sprite widens the matrix instead of being cut.
    cols = rows = max(13, x1 - x0 + 3, y1 - y0 + 3)
    cells = window(mascot, cols, rows, ground=1)
    draw_plate(img, n / 2, n / 2, n * plate, cells, cols, rows, ghost)
    return img.resize((px, px), Image.LANCZOS)


def make_favicon(mascot):
    """32 px, no resampling: 1 px yolk, 2 px bezel, 26 px LCD at exactly 2 px per dot."""
    img = Image.new("RGB", (32, 32), YOLK)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((1, 1, 30, 30), radius=6, fill=BEZEL)
    d.rounded_rectangle((3, 3, 28, 28), radius=3, fill=PEA)
    n = 13
    x0, y0, x1, y1 = bbox(mascot)
    for (cx, cy) in window(mascot, n, n, ground=1 if y1 - y0 + 1 < n else 0):
        if 0 <= cx < n and 0 <= cy < n:
            x, y = 3 + cx * 2, 3 + cy * 2
            d.rectangle((x, y, x + 1, y + 1), fill=INK)
    return img


def draw_dots(img, bmp, x, y, pitch, colour, opacity=1.0, gap=0.12):
    m = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(m)
    dot = pitch * (1 - gap)
    for cy, row in enumerate(bmp):
        for cx, c in enumerate(row):
            if c == "#":
                px, py = x + cx * pitch, y + cy * pitch
                d.rectangle((px, py, px + dot, py + dot), fill=255)
    paste_alpha(img, colour, m, opacity)


def make_og(mascot):
    W, H = 800 * SS, 400 * SS
    s = SS
    img = Image.new("RGB", (W, H), PAGE)

    # A low lamp behind the device.
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).ellipse((400 * s - 190 * s, 130 * s - 130 * s, 400 * s + 190 * s, 130 * s + 130 * s), fill=255)
    glow = glow.filter(ImageFilter.GaussianBlur(64 * s))
    paste_alpha(img, YOLK, glow, 0.15)

    # Quiet dot-sprites out in the margins; a 1:1 crop simply loses them.
    for bmp, x, y, pitch, colour, op in [
        (DECO_HEART, 96, 86, 6, YOLK, 0.5),
        (DECO_SPARK, 196, 232, 5, MILK, 0.26),
        (DECO_STAR, 70, 268, 5, MILK, 0.2),
        (DECO_STAR, 664, 78, 6, YOLK, 0.5),
        (DECO_SPARK, 582, 190, 5, MILK, 0.26),
        (DECO_HEART, 690, 262, 5, MILK, 0.2),
    ]:
        draw_dots(img, bmp, x * s, y * s, pitch * s, colour, op)

    # The device: our tall pebble, bezel in the upper half, three keys in a shallow arc.
    cx = 400 * s
    top, dw, dh = 20 * s, 156 * s, 204 * s
    body = (cx - dw / 2, top, cx + dw / 2, top + dh)
    radius = 58 * s
    sh = rounded_mask((W, H), (body[0], body[1] + 10 * s, body[2], body[3] + 10 * s), radius)
    paste_alpha(img, (0, 0, 0), sh.filter(ImageFilter.GaussianBlur(14 * s)), 0.55)
    shell = vgradient((W, H), MILK, MILK, MILK_SHADE)
    img.paste(shell.crop((0, 0, W, H)), (0, 0), rounded_mask((W, H), body, radius))
    # re-shade: the gradient above spans the whole canvas, so tint the lower shell directly
    low = Image.new("L", (W, H), 0)
    ImageDraw.Draw(low).rectangle((body[0], top + dh * 0.55, body[2], body[3]), fill=255)
    low = ImageChops.multiply(low.filter(ImageFilter.GaussianBlur(26 * s)), rounded_mask((W, H), body, radius))
    paste_alpha(img, MILK_SHADE, low, 0.9)
    rim = ImageChops.subtract(
        rounded_mask((W, H), body, radius),
        rounded_mask((W, H), (body[0], body[1] + 2 * s, body[2], body[3] + 2 * s), radius))
    paste_alpha(img, (255, 255, 255), rim, 0.9)

    bw, bh = 122 * s, 100 * s
    bezel = (cx - bw / 2, top + 22 * s, cx + bw / 2, top + 22 * s + bh)
    paste_alpha(img, BEZEL, rounded_mask((W, H), bezel, 20 * s))
    inset = 9 * s
    cols, rows = 16, 12
    cells = window(mascot, cols, rows, ground=0 if bbox(mascot)[3] - bbox(mascot)[1] + 1 >= rows else 1)
    draw_lcd(img, (bezel[0] + inset, bezel[1] + inset, bezel[2] - inset, bezel[3] - inset),
             cells, cols, rows, ghost=0.08)

    d = ImageDraw.Draw(img)
    key_y = top + 22 * s + bh + 38 * s
    for i, dx in enumerate((-40, 0, 40)):
        kx = cx + dx * s
        ky = key_y + (9 * s if i == 1 else 0)
        r = 13 * s
        d.ellipse((kx - r, ky - r + 3 * s, kx + r, ky + r + 3 * s), fill=(180, 170, 148))
        d.ellipse((kx - r, ky - r, kx + r, ky + r), fill=YOLK)
        d.ellipse((kx - r + 3 * s, ky - r + 2 * s, kx + r - 3 * s, ky + r - 5 * s), fill=YOLK_HI)

    # Wordmark as dots, then the line in a system Hangul face.
    pitch = 6 * s
    gw = len(WORD_PUM[0]) * pitch
    gapw = 2 * pitch
    wx = cx - (gw * 2 + gapw) / 2 + pitch * 0.06
    wy = 244 * s
    draw_dots(img, WORD_PUM, wx, wy, pitch, MILK, 1.0, gap=0.0)
    draw_dots(img, WORD_AL, wx + gw + gapw, wy, pitch, MILK, 1.0, gap=0.0)

    font = ImageFont.truetype(HANGUL_FONT, 23 * s, index=HANGUL_FONT_INDEX)
    line = "품에 안고 키우는 포켓 펫"
    tw = d.textlength(line, font=font)
    d.text((cx - tw / 2, 336 * s), line, font=font, fill=SOFT)

    return img.resize((800, 400), Image.LANCZOS)


def main():
    mascot, source = load_mascot()
    OUT.mkdir(exist_ok=True)
    outputs = {
        "apple-touch-icon-180.png": make_icon(180, mascot),
        "icon-192.png": make_icon(192, mascot),
        "icon-512.png": make_icon(512, mascot),
        # Maskable: the launcher may crop to the central 80 % circle, so the plate stays
        # inside the central 60 % and the yolk field carries the rest.
        "icon-maskable-512.png": make_icon(512, mascot, plate=0.58),
        "favicon-32.png": make_favicon(mascot),
        "og-800x400.png": make_og(mascot),
    }
    for name, im in outputs.items():
        im = im.convert("RGB")  # no alpha channel anywhere: iOS paints transparency black
        im.save(OUT / name, optimize=True)
        print(f"{name}  {im.size[0]}x{im.size[1]}  {(OUT / name).stat().st_size} bytes")
    print(f"mascot bitmap from {source}")


if __name__ == "__main__":
    main()
