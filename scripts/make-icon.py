"""Renders Atelier's icon (accent tile, prompt chevron and cursor) to resources/icon.png and icon.ico.

Run: python scripts/make-icon.py  (needs Pillow). The mark matches src/renderer/components/Logo.tsx.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ACCENT = (116, 128, 255, 255)  # #7480FF
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / 'resources'


def render(size: int) -> Image.Image:
    s = 4  # supersample for smooth edges
    n = size * s
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    unit = n / 18
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=4.5 * unit, fill=ACCENT)
    w = max(1, round(1.7 * unit))
    pts = [(4.6 * unit, 5.4 * unit), (8.2 * unit, 9 * unit), (4.6 * unit, 12.6 * unit)]
    d.line(pts, fill=WHITE, width=w, joint='curve')
    r = w / 2
    for x, y in (pts[0], pts[2]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)
    d.rounded_rectangle([9.6 * unit, 11.4 * unit, 13.8 * unit, 13.1 * unit], radius=0.85 * unit, fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
render(512).save(OUT / 'icon.png')
big = render(256)
big.save(OUT / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('wrote', OUT / 'icon.png', OUT / 'icon.ico')
