"""
Icon generator for «ترجمان» (v2.0.2).

The mark: a squircle with the brand's own accent gradient (sky → violet, the
same two colours the appearance sheet ships), a soft top-left light, and the
Persian letter «ت» — the first letter of the name — as a clean white glyph.
One letter is all that survives at 16px, so everything else is restraint:
no outlines, no text, no gloss.

Rendered at 8x and box-filtered down, which is what keeps the 16px version
crisp instead of muddy. Run:  python tools/make_icons.py
"""

import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = (128, 48, 32, 16)
MASTER = 1024

# Brand accents (shared/theme.js: sky #1d9bf0, violet #7c5cf5).
C_TOP = (56, 176, 255)
C_BOTTOM = (108, 76, 240)
GLYPH_FONT = os.environ.get("TARJOMAN_ICON_FONT", os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", "tahomabd.ttf"))  # has Arabic-script glyphs


def gradient(size, top, bottom):
    """Vertical-ish diagonal gradient, drawn once at master resolution."""
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(size):
            # Diagonal blend factor: top-right is lightest, bottom-left deepest.
            t = (x * 0.35 + y * 0.65) / size
            px[x, y] = (
                int(top[0] + (bottom[0] - top[0]) * t),
                int(top[1] + (bottom[1] - top[1]) * t),
                int(top[2] + (bottom[2] - top[2]) * t),
            )
    return grad


def squircle_mask(size, radius_ratio=0.235):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255
    )
    return mask


def draw_glyph(size):
    """
    The «ت» drawn as geometry rather than typeset.

    A font's «ت» is symmetric enough that at icon scale it reads as a smiley
    face. Drawing it lets the letter keep what actually identifies it: a bowl
    that is deeper on the left, a taller upward tick on the right, and the two
    dots set closer together than any typeface would place them.
    """
    S = size
    g = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(g)
    w = S * 0.125  # stroke weight
    left, right = S * 0.190, S * 0.810
    # A wide, shallow bowl: deep enough to be a «ت», flat enough not to grin.
    top, bottom = S * 0.365, S * 0.815
    mid_y = (top + bottom) / 2

    d.arc((left, top, right, bottom), 0, 180, fill=255, width=int(w))
    # Both ends turn up, the right one further — that asymmetry is the letter.
    for cx, rise in ((left, S * 0.070), (right, S * 0.150)):
        tick_top = mid_y - rise
        d.rectangle((cx - w / 2, tick_top, cx + w / 2, mid_y), fill=255)
        d.ellipse((cx - w / 2, tick_top - w / 2, cx + w / 2, tick_top + w / 2), fill=255)

    # The two dots as ONE bar. Persian calligraphy joins them exactly this way,
    # and it is what stops the mark from reading as a pair of eyes over a smile.
    bar_w, bar_h = S * 0.315, w * 0.86
    bx, by = (S - bar_w) / 2, S * 0.215
    cy = by + bar_h / 2
    d.rectangle((bx, by, bx + bar_w, by + bar_h), fill=255)
    for cx in (bx, bx + bar_w):
        d.ellipse((cx - bar_h / 2, cy - bar_h / 2, cx + bar_h / 2, cy + bar_h / 2), fill=255)
    return g


def build_master():
    size = MASTER
    tile = gradient(size, C_TOP, C_BOTTOM).convert("RGBA")

    # Soft light from the top-left: depth without a border or a shadow.
    glow = Image.new("L", (size, size), 0)
    ImageDraw.Draw(glow).ellipse(
        (-size * 0.35, -size * 0.55, size * 0.75, size * 0.35), fill=90
    )
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.10))
    tile = Image.composite(Image.new("RGBA", (size, size), (255, 255, 255, 255)), tile, glow)

    glyph = draw_glyph(size)

    # A whisper of shadow under the glyph so it reads on the lighter corner.
    shadow = glyph.filter(ImageFilter.GaussianBlur(size * 0.012))
    tile = Image.composite(
        Image.new("RGBA", (size, size), (12, 20, 60, 255)),
        tile,
        shadow.point(lambda v: int(v * 0.35)),
    )
    tile = Image.composite(Image.new("RGBA", (size, size), (255, 255, 255, 255)), tile, glyph)

    tile.putalpha(squircle_mask(size))
    return tile


def main():
    master = build_master()
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        # Two-step downscale keeps small sizes from going soft.
        img = master.resize((size * 4, size * 4), Image.LANCZOS)
        img = img.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT, f"icon{size}.png")
        img.save(path, "PNG", optimize=True)
        print("wrote", path, img.size)
    master.resize((512, 512), Image.LANCZOS).save(
        os.path.join(OUT, "icon-source-512.png"), "PNG", optimize=True
    )
    print("wrote", os.path.join(OUT, "icon-source-512.png"))

    # Contact sheet: every shipped size at 1:1 and magnified, on light and on
    # dark, so the small sizes can be judged instead of guessed at.
    pad, cell = 22, 224
    cols = [(s, max(1, cell // s)) for s in SIZES]
    sheet_w = pad + sum(s + z * s + pad * 2 for s, z in cols)
    row_h = cell + pad * 2
    sheet = Image.new("RGB", (sheet_w, row_h * 2), (245, 247, 250))
    ImageDraw.Draw(sheet).rectangle((0, row_h, sheet_w, row_h * 2), fill=(14, 16, 20))
    x = pad
    for size, zoom in cols:
        img = Image.open(os.path.join(OUT, f"icon{size}.png")).convert("RGBA")
        big = img.resize((size * zoom, size * zoom), Image.NEAREST)
        for row in (0, 1):
            top = row * row_h + pad
            sheet.paste(img, (x, top + (cell - size) // 2), img)
            sheet.paste(big, (x + size + pad, top + (cell - size * zoom) // 2), big)
        x += size + size * zoom + pad * 2
    path = os.path.join(OUT, "icon-contact-sheet.png")
    sheet.save(path, "PNG")
    print("wrote", path)


if __name__ == "__main__":
    main()
