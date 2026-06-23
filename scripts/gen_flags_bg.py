#!/usr/bin/env python3
"""Generate flags-bg.svg: a mosaic of the 48 World Cup 2026 flags, arranged by color.

Uses accurate public-domain flag artwork from flagcdn.com, embedded as base64 PNGs
so the output SVG is fully self-contained (no external requests at render time).
Flags are placed into a grid sorted by an assigned dominant hue, so similar colors
cluster into a rainbow.

Run:  python3 scripts/gen_flags_bg.py   (writes flags-bg.svg in the repo root)
Downloads are cached in scripts/.flag-cache/ so reruns are offline/fast.
"""
import argparse
import base64
import os
import urllib.request

CELL_W, CELL_H = 120, 80          # 3:2 tiles
COLS, ROWS = 8, 6                 # 48 flags
RES = "w640"                      # flagcdn raster width
CACHE = os.path.join(os.path.dirname(__file__), ".flag-cache")

# name -> (flagcdn ISO code, dominant hue for color sorting)
FLAGS = {
    "Switzerland": ("ch", 0),   "England": ("gb-eng", 2), "Canada": ("ca", 3),
    "Qatar": ("qa", 4),         "Austria": ("at", 5),     "Türkiye": ("tr", 6),
    "Tunisia": ("tn", 7),       "Morocco": ("ma", 8),     "Czechia": ("cz", 10),
    "Croatia": ("hr", 12),      "Paraguay": ("py", 13),   "Netherlands": ("nl", 14),
    "Spain": ("es", 15),        "Panama": ("pa", 16),     "Norway": ("no", 17),
    "Ivory Coast": ("ci", 30),  "Belgium": ("be", 48),    "Colombia": ("co", 50),
    "Ecuador": ("ec", 52),      "Ghana": ("gh", 54),      "Germany": ("de", 56),
    "Mexico": ("mx", 120),      "Saudi Arabia": ("sa", 122), "Brazil": ("br", 124),
    "Senegal": ("sn", 126),     "Algeria": ("dz", 128),   "Iran": ("ir", 130),
    "Portugal": ("pt", 132),    "Jordan": ("jo", 134),    "South Africa": ("za", 135),
    "Argentina": ("ar", 195),   "Uruguay": ("uy", 198),   "Scotland": ("gb-sct", 210),
    "Bosnia and Herzegovina": ("ba", 212), "Cape Verde": ("cv", 214), "Curaçao": ("cw", 216),
    "Uzbekistan": ("uz", 218),  "DR Congo": ("cd", 220),  "Sweden": ("se", 222),
    "Haiti": ("ht", 224),       "France": ("fr", 226),    "Iraq": ("iq", 228),
    "Egypt": ("eg", 230),       "United States": ("us", 232), "Australia": ("au", 234),
    "New Zealand": ("nz", 236), "Japan": ("jp", 300),     "South Korea": ("kr", 302),
}
assert len(FLAGS) == 48, f"expected 48 flags, got {len(FLAGS)}"


def positions_serpentine(n):
    """Row-major, reversing every other row so the hue sequence never wraps."""
    out = []
    for idx in range(n):
        row, col = idx // COLS, idx % COLS
        if row % 2 == 1:
            col = COLS - 1 - col
        out.append((col, row))
    return out


def positions_column_serpentine(n):
    """Column-major boustrophedon: down col 0, up col 1, down col 2, ...

    e.g. A1 A2 A3 A4 A5 A6  B6 B5 B4 B3 B2 B1  C1 C2 ...  so the hue sequence
    flows continuously with no jump at the bottom/top of each column.
    """
    out = []
    for idx in range(n):
        col, pos = idx // ROWS, idx % ROWS
        row = ROWS - 1 - pos if col % 2 == 1 else pos
        out.append((col, row))
    return out


def positions_gilbert(n):
    """Generalized Hilbert (Gilbert) curve over the COLS x ROWS grid.

    Maps the 1-D hue sequence onto a space-filling path so that flags close in
    color cluster into 2-D blobs (locality in both axes), not just along a snake.
    Algorithm: Jakub Cerveny's gilbert2d.
    """
    coords = []
    sgn = lambda v: (v > 0) - (v < 0)

    def gen(x, y, ax, ay, bx, by):
        w, h = abs(ax + ay), abs(bx + by)
        dax, day, dbx, dby = sgn(ax), sgn(ay), sgn(bx), sgn(by)
        if h == 1:
            for _ in range(w):
                coords.append((x, y)); x += dax; y += day
            return
        if w == 1:
            for _ in range(h):
                coords.append((x, y)); x += dbx; y += dby
            return
        ax2, ay2, bx2, by2 = ax // 2, ay // 2, bx // 2, by // 2
        w2, h2 = abs(ax2 + ay2), abs(bx2 + by2)
        if 2 * w > 3 * h:
            if w2 % 2 and w > 2:
                ax2 += dax; ay2 += day
            gen(x, y, ax2, ay2, bx, by)
            gen(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by)
        else:
            if h2 % 2 and h > 2:
                bx2 += dbx; by2 += dby
            gen(x, y, bx2, by2, ax2, ay2)
            gen(x + bx2, y + by2, ax, ay, bx - bx2, by - by2)
            gen(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
                -bx2, -by2, -(ax - ax2), -(ay - ay2))

    if COLS >= ROWS:
        gen(0, 0, COLS, 0, 0, ROWS)
    else:
        gen(0, 0, 0, ROWS, COLS, 0)
    return coords[:n]


LAYOUTS = {
    "serpentine": positions_serpentine,
    "column-serpentine": positions_column_serpentine,
    "gilbert": positions_gilbert,
}


def flag_png(code):
    """Return the PNG bytes for a flag, using an on-disk cache."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{code}.png")
    if not os.path.exists(path):
        url = f"https://flagcdn.com/{RES}/{code}.png"
        req = urllib.request.Request(url, headers={"User-Agent": "wc2026-flag-mosaic"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        with open(path, "wb") as fh:
            fh.write(data)
    with open(path, "rb") as fh:
        return fh.read()


def png_size(data):
    """Return (width, height) read from a PNG's IHDR chunk."""
    return (int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"))


def boxes_strip(ordered):
    """1x48 ribbon: every flag keeps the row height and its NATURAL width, so
    nothing is cropped (wide flags like Australia/New Zealand stay intact)."""
    boxes, x = [], 0.0
    for name, (code, _hue) in ordered:
        data = flag_png(code)
        pw, ph = png_size(data)
        w = CELL_H * pw / ph
        boxes.append((name, code, x, 0.0, w, float(CELL_H)))
        x += w
    return boxes, x, float(CELL_H), "none", "none"  # boxes, W, H, img_par, root_par


def boxes_grid(ordered, layout):
    """8x6 mosaic: equal 3:2 cells; flags sliced to fill (intentional crop)."""
    boxes = []
    for (name, (code, _hue)), (col, row) in zip(ordered, LAYOUTS[layout](len(ordered))):
        boxes.append((name, code, col * CELL_W, row * CELL_H, float(CELL_W), float(CELL_H)))
    return boxes, COLS * CELL_W, ROWS * CELL_H, "xMidYMid slice", "xMidYMid slice"


def main():
    repo = os.path.dirname(os.path.dirname(__file__))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shape", choices=("strip", "grid"), default="strip",
                    help="strip = 1x48 horizontal ribbon; grid = 8x6 mosaic")
    ap.add_argument("--layout", choices=LAYOUTS, default="column-serpentine",
                    help="grid placement only (ignored for --shape strip)")
    ap.add_argument("--out", help="defaults to flags-strip.svg / flags-bg.svg by shape")
    args = ap.parse_args()

    ordered = sorted(FLAGS.items(), key=lambda kv: (kv[1][1], kv[0]))
    if args.shape == "strip":
        boxes, W, H, img_par, root_par = boxes_strip(ordered)
        out = args.out or os.path.join(repo, "flags-strip.svg")
    else:
        boxes, W, H, img_par, root_par = boxes_grid(ordered, args.layout)
        out = args.out or os.path.join(repo, "flags-bg.svg")

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{W:.2f}" height="{H:.2f}" viewBox="0 0 {W:.2f} {H:.2f}" '
        f'preserveAspectRatio="{root_par}">'
    ]
    for name, code, ox, oy, w, h in boxes:
        b64 = base64.b64encode(flag_png(code)).decode("ascii")
        parts.append(f'<g><title>{name}</title>')
        parts.append(
            f'<image x="{ox:.2f}" y="{oy:.2f}" width="{w:.2f}" height="{h:.2f}" '
            f'preserveAspectRatio="{img_par}" xlink:href="data:image/png;base64,{b64}"/>'
        )
        parts.append(
            f'<rect x="{ox:.2f}" y="{oy:.2f}" width="{w:.2f}" height="{h:.2f}" '
            f'fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1"/>'
        )
        parts.append('</g>')
    parts.append('</svg>')

    with open(out, "w") as fh:
        fh.write("\n".join(parts))
    tag = args.shape if args.shape == "strip" else f"{args.shape}/{args.layout}"
    print(f"wrote {out} ({tag}, {len(boxes)} flags, {W:.0f}x{H:.0f}, "
          f"{os.path.getsize(out)//1024} KB)")


if __name__ == "__main__":
    main()
