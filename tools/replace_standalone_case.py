from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import shutil

generated = Path(r"C:\Users\LD\.codex\generated_images\01a0571b-658a-7193-8d59-5978212248d0")
output = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\개별사용_작업이미지_50장_WEBP")
target = output / "01_변기막힘" / "01_변기막힘_개별이미지_03.webp"
source = max(generated.glob("*.png"), key=lambda path: path.stat().st_mtime)

with Image.open(source) as image:
    image.convert("RGB").save(target, "WEBP", quality=90, method=6)

files = sorted(output.rglob("*.webp"))
thumb_w, thumb_h, cell_h = 300, 225, 255
sheet = Image.new("RGB", (thumb_w * 5, cell_h * 10), "white")
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default()
for index, path in enumerate(files):
    with Image.open(path) as image:
        thumb = image.convert("RGB")
        thumb.thumbnail((thumb_w, thumb_h))
        x, y = (index % 5) * thumb_w, (index // 5) * cell_h
        sheet.paste(thumb, (x, y))
        draw.text((x + 6, y + 230), f"{index + 1:02d} {path.stem}", fill="black", font=font)
sheet.save(output.parent / "개별사용_50장_검수시트.jpg", "JPEG", quality=88)
shutil.make_archive(str(output), "zip", output.parent, output.name)
print(f"replaced={target}")
print(f"count={len(files)}")
