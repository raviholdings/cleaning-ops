from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\최종_납품_이미지_모음")
SOURCE = ROOT / "03_브랜드별_최종작업이미지_300장_WEBP"
TARGET = ROOT / "07_최종검수시트"
TARGET.mkdir(parents=True, exist_ok=True)
FONT = ImageFont.truetype(r"C:\Windows\Fonts\malgun.ttf", 15)

for brand_dir in sorted(path for path in SOURCE.iterdir() if path.is_dir()):
    files = sorted(brand_dir.rglob("*.webp"))
    if len(files) != 60:
        raise RuntimeError(f"{brand_dir.name}: expected 60, got {len(files)}")
    tile_w, tile_h, caption_h = 300, 225, 24
    sheet = Image.new("RGB", (tile_w * 6, (tile_h + caption_h) * 10), "white")
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(files):
        with Image.open(path) as opened:
            image = opened.convert("RGB")
            image.thumbnail((tile_w, tile_h), Image.Resampling.LANCZOS)
        x = (index % 6) * tile_w
        y = (index // 6) * (tile_h + caption_h)
        sheet.paste(image, (x, y))
        draw.text((x + 5, y + tile_h + 3), path.stem, fill="black", font=FONT)
    target = TARGET / f"{brand_dir.name}_최종60장_검수시트.jpg"
    sheet.save(target, "JPEG", quality=90)
    print(target)
