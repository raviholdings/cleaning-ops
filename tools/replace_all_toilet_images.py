from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import shutil

generated = Path(r"C:\Users\LD\.codex\generated_images\01a0571b-658a-7193-8d59-5978212248d0")
root = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output")
story_root = root / "작업사례_50장_WEBP"
single_root = root / "개별사용_작업이미지_50장_WEBP"

story_targets = sorted((story_root / "01_변기막힘").glob("*.webp"))
single_targets = sorted((single_root / "01_변기막힘").glob("*.webp"))
targets = story_targets + single_targets
sources = sorted(generated.glob("*.png"), key=lambda p: p.stat().st_mtime)[-10:]
if len(sources) != 10 or len(targets) != 10:
    raise RuntimeError(f"Expected 10 sources and targets, got {len(sources)} and {len(targets)}")

for source, target in zip(sources, targets):
    with Image.open(source) as image:
        image.convert("RGB").save(target, "WEBP", quality=90, method=6)

thumb_w, thumb_h, cell_h = 362, 272, 310
sheet = Image.new("RGB", (thumb_w * 5, cell_h * 2), "white")
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default()
for index, target in enumerate(targets):
    with Image.open(target) as image:
        thumb = image.convert("RGB")
        thumb.thumbnail((thumb_w, thumb_h))
        x, y = (index % 5) * thumb_w, (index // 5) * cell_h
        sheet.paste(thumb, (x, y))
        label = ("STORY" if index < 5 else "SINGLE") + f" {index % 5 + 1}"
        draw.text((x + 8, y + 278), label, fill="black", font=font)
sheet.save(root / "변기이미지_10장_재검수.jpg", "JPEG", quality=92)

all_single = sorted(single_root.rglob("*.webp"))
full = Image.new("RGB", (300 * 5, 255 * 10), "white")
full_draw = ImageDraw.Draw(full)
for index, target in enumerate(all_single):
    with Image.open(target) as image:
        thumb = image.convert("RGB")
        thumb.thumbnail((300, 225))
        x, y = (index % 5) * 300, (index // 5) * 255
        full.paste(thumb, (x, y))
        full_draw.text((x + 6, y + 230), f"{index + 1:02d} {target.stem}", fill="black", font=font)
full.save(root / "개별사용_50장_검수시트.jpg", "JPEG", quality=88)

shutil.make_archive(str(story_root), "zip", story_root.parent, story_root.name)
shutil.make_archive(str(single_root), "zip", single_root.parent, single_root.name)
print("replaced=10")
print(root / "변기이미지_10장_재검수.jpg")
