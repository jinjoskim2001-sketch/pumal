#!/usr/bin/env python3
"""Render every bitmap exported by a JS art module into one labelled contact sheet PNG.

usage: python3 tools/sheet.py js/art/young.js out.png [scale]

A bitmap is an array of equal-length strings where '#' is a lit dot and '.' is unlit.
The module is imported with node, walked recursively, and every bitmap found is drawn
LCD-style (ink dots on the pea backing) with its key path underneath, so the artist can
look at the real result instead of imagining it.
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BG = (197, 207, 164)
INK = (30, 42, 28)
GHOST = (184, 194, 152)
LABEL = (60, 70, 50)

DUMP = r"""
const mod = await import(process.argv[1]);
const out = [];
const isBmp = (v) => Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'string') && /^[#.]+$/.test(v[0]);
const walk = (v, path) => {
  if (isBmp(v)) { out.push({ path, rows: v }); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k); }
};
for (const k of Object.keys(mod)) walk(mod[k], k);
console.log(JSON.stringify(out));
"""


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    module = Path(sys.argv[1]).resolve()
    out_path = sys.argv[2]
    scale = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    res = subprocess.run(
        ["node", "--input-type=module", "-e", DUMP, module.as_uri()],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        print(res.stderr, file=sys.stderr)
        sys.exit(1)
    items = json.loads(res.stdout)
    if not items:
        print("no bitmaps found", file=sys.stderr)
        sys.exit(1)

    problems = []
    for it in items:
        widths = {len(r) for r in it["rows"]}
        if len(widths) != 1:
            problems.append(f"{it['path']}: ragged rows {sorted(widths)}")
        bad = {c for r in it["rows"] for c in r} - {"#", "."}
        if bad:
            problems.append(f"{it['path']}: bad chars {bad}")

    cell_w = max(max(len(r) for r in it["rows"]) for it in items) * scale + 16
    cell_h = max(len(it["rows"]) for it in items) * scale + 30
    cols = max(1, min(6, 1500 // cell_w))
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), BG)
    d = ImageDraw.Draw(sheet)
    for i, it in enumerate(items):
        ox = (i % cols) * cell_w + 8
        oy = (i // cols) * cell_h + 6
        for y, row in enumerate(it["rows"]):
            for x, ch in enumerate(row):
                x0, y0 = ox + x * scale, oy + y * scale
                d.rectangle([x0, y0, x0 + scale - 2, y0 + scale - 2], fill=INK if ch == "#" else GHOST)
        label = it["path"]
        h = len(it["rows"])
        w = len(it["rows"][0])
        d.text((ox, oy + h * scale + 4), f"{label} {w}x{h}"[: cell_w // 6], fill=LABEL)
    sheet.save(out_path)
    print(f"saved {out_path}: {len(items)} bitmaps")
    for p in problems:
        print("PROBLEM:", p)
    if problems:
        sys.exit(3)


if __name__ == "__main__":
    main()
