from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

source = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_기본이미지_PNG")
target = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_기본이미지_검수시트.jpg")
files = sorted(source.glob("*.png"))
if len(files) != 60:
    raise RuntimeError(f"Expected 60 images, got {len(files)}")
tw, th, ch = 240, 180, 205
sheet = Image.new("RGB", (tw * 6, ch * 10), "white")
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default()
for idx, path in enumerate(files):
    with Image.open(path) as image:
        thumb = image.convert("RGB")
        thumb.thumbnail((tw, th))
        x, y = (idx % 6) * tw, (idx // 6) * ch
        sheet.paste(thumb, (x, y))
        draw.text((x + 4, y + 184), path.stem, fill="black", font=font)
sheet.save(target, "JPEG", quality=90)
print(target)
