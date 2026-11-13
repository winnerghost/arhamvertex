# Draws the launcher icon: a stencil "F" cut by a waterline, on deep-sea ink.
import sys, os
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for name, s in sizes.items():
    S = s * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=(8, 18, 22, 255))
    wl = int(S * 0.6)
    d.rounded_rectangle([0, wl, S - 1, S - 1], radius=int(S * 0.22), fill=(16, 82, 86, 255))
    d.rectangle([0, wl, S - 1, wl + int(S * 0.2)], fill=(16, 82, 86, 255))
    try:
        f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf', int(S * 0.72))
    except Exception:
        f = ImageFont.load_default()
    txt = Image.new('L', (S, S), 0)
    ImageDraw.Draw(txt).text((S * 0.5, S * 0.52), 'F', font=f, fill=255, anchor='mm')
    top = Image.new('RGBA', (S, S), (233, 241, 238, 255))
    bot = Image.new('RGBA', (S, S), (57, 224, 207, 255))
    mask_top = txt.copy(); ImageDraw.Draw(mask_top).rectangle([0, wl, S, S], fill=0)
    mask_bot = txt.copy(); ImageDraw.Draw(mask_bot).rectangle([0, 0, S, wl], fill=0)
    im.paste(top, (0, 0), mask_top)
    im.paste(bot, (0, 0), mask_bot)
    d.rectangle([int(S * 0.12), wl - int(S * 0.012), int(S * 0.88), wl + int(S * 0.012)], fill=(57, 224, 207, 255))
    im = im.resize((s, s), Image.LANCZOS)
    p = os.path.join(out, 'mipmap-' + name)
    os.makedirs(p, exist_ok=True)
    im.save(os.path.join(p, 'ic_launcher.png'))
print('icons ok')
