"""从 icons/icon128.png 重新生成 16/48 尺寸（需 Pillow）。"""
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "icons" / "icon128.png"
OUT = ROOT / "icons"


def main():
    img = Image.open(SRC).convert("RGBA")
    w, h = img.size
    side = min(w, h)
    img = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))

    for size in (16, 48, 128):
        out = img.resize((size, size), Image.Resampling.LANCZOS)
        if size == 16:
            out = out.filter(ImageFilter.SHARPEN)
            out = ImageEnhance.Contrast(out).enhance(1.08)
        path = OUT / f"icon{size}.png"
        out.save(path, "PNG", optimize=True)
        print(path)


if __name__ == "__main__":
    main()
