from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import csv
import shutil

SOURCE = Path(r"C:\Users\LD\.codex\generated_images\01a0571b-658a-7193-8d59-5978212248d0")
OUTPUT = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\개별사용_작업이미지_50장_WEBP")

groups = [
    ("01_변기막힘", 5), ("02_하수구막힘", 5), ("03_싱크대막힘", 4),
    ("04_누수탐지", 4), ("05_수전교체", 4), ("06_상가주방", 4),
    ("07_샤워기수전", 4), ("08_고압세척", 4), ("09_아파트화장실냄새", 4),
    ("10_아파트누수", 4), ("11_보일러누수", 4), ("12_베란다천장누수", 4),
]

def main():
    source_files = sorted(SOURCE.glob("*.png"), key=lambda p: p.stat().st_mtime)[-50:]
    labels = [(group, i) for group, count in groups for i in range(1, count + 1)]
    if len(source_files) != 50 or len(labels) != 50:
        raise RuntimeError(f"Expected 50 files and labels, got {len(source_files)} and {len(labels)}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rows = []
    outputs = []
    for source, (group, number) in zip(source_files, labels):
        folder = OUTPUT / group
        folder.mkdir(exist_ok=True)
        target = folder / f"{group}_개별이미지_{number:02d}.webp"
        with Image.open(source) as image:
            image.convert("RGB").save(target, "WEBP", quality=90, method=6)
        outputs.append(target)
        rows.append([group, number, str(target.relative_to(OUTPUT)), target.stat().st_size])

    with (OUTPUT / "개별이미지_목록.csv").open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(["키워드", "번호", "파일", "용량(bytes)"])
        writer.writerows(rows)

    thumb_w, thumb_h = 300, 225
    cell_h = 255
    sheet = Image.new("RGB", (thumb_w * 5, cell_h * 10), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, target in enumerate(outputs):
        with Image.open(target) as image:
            thumb = image.convert("RGB")
            thumb.thumbnail((thumb_w, thumb_h))
            x = (index % 5) * thumb_w
            y = (index // 5) * cell_h
            sheet.paste(thumb, (x, y))
            draw.text((x + 6, y + 230), f"{index + 1:02d} {target.stem}", fill="black", font=font)
    preview = OUTPUT.parent / "개별사용_50장_검수시트.jpg"
    sheet.save(preview, "JPEG", quality=88)

    (OUTPUT / "README.txt").write_text(
        "서로 연결되지 않는 독립형 작업 이미지 50장입니다. 각 파일은 개별 게시물에 사용할 수 있습니다.\n"
        "이미지는 AI 생성 홍보용 예시이며 실제 고객 현장 촬영본으로 표시하면 안 됩니다.\n",
        encoding="utf-8",
    )
    shutil.make_archive(str(OUTPUT), "zip", OUTPUT.parent, OUTPUT.name)
    print(f"count={len(outputs)}")
    print(f"preview={preview}")
    print(f"zip={OUTPUT}.zip")

if __name__ == "__main__":
    main()
