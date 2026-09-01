from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps
import csv

from detect_new_worker_back import detect_worker


ROOT = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops")
WORKERS = ROOT / "output" / "브랜드작업_신규작업자_PNG"
FINAL = ROOT / "output" / "최종_납품_이미지_모음"
OUTPUT = FINAL / "03_브랜드별_최종작업이미지_300장_WEBP"
LOGOS = FINAL / "06_브랜드로고_투명원본_PNG"
FONT = Path(r"C:\Windows\Fonts\malgunbd.ttf")

BRANDS = ["썬더배관", "드림컴뚜러", "비버배관", "하수구도사", "싹쓰리배관"]
GROUPS = ["01_하수구", "02_변기", "03_싱크대", "04_식당주방", "05_누수", "06_고압세척"]
KEYWORDS = {
    "01_하수구": "하수구",
    "02_변기": "변기",
    "03_싱크대": "싱크대",
    "04_식당주방": "식당주방",
    "05_누수": "누수",
    "06_고압세척": "고압세척",
}
WORKER_NUMBERS = (2, 3, 5, 6, 8, 10)


def transform_worker(image: Image.Image, brand_index: int) -> Image.Image:
    """Make mild brand variants without changing the work scene."""
    width, height = image.size
    if brand_index == 0:
        return image
    if brand_index == 1:
        margin_x, margin_y = 10, 8
        return image.crop((margin_x, margin_y, width - margin_x, height - margin_y)).resize(
            (width, height), Image.Resampling.LANCZOS
        )
    if brand_index == 2:
        return ImageOps.mirror(image)
    if brand_index == 3:
        return ImageEnhance.Brightness(ImageEnhance.Color(image).enhance(0.96)).enhance(1.01)
    return ImageEnhance.Contrast(ImageOps.mirror(image)).enhance(1.02)


def transparent_thunder_logo(source: Image.Image) -> Image.Image:
    """Recover the colored pipe/lightning mark and rebuild the exact Korean wordmark."""
    source = source.convert("RGB")
    icon = source.crop((0, 0, int(source.width * 0.34), source.height))
    hsv = icon.convert("HSV")
    saturation = hsv.getchannel("S")
    mask = saturation.point(lambda value: 255 if value > 48 else 0)
    mask = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(1.0))
    icon_rgba = icon.convert("RGBA")
    icon_rgba.putalpha(mask)
    bbox = mask.getbbox()
    if bbox:
        icon_rgba = icon_rgba.crop(bbox)

    font = ImageFont.truetype(str(FONT), 250)
    first, second = "썬더", "배관"
    probe = Image.new("RGBA", (10, 10))
    draw = ImageDraw.Draw(probe)
    b1 = draw.textbbox((0, 0), first, font=font, stroke_width=5)
    b2 = draw.textbbox((0, 0), second, font=font, stroke_width=5)
    text_w = (b1[2] - b1[0]) + (b2[2] - b2[0])
    text_h = max(b1[3] - b1[1], b2[3] - b2[1])
    icon_h = 330
    icon_w = round(icon_rgba.width * icon_h / icon_rgba.height)
    canvas = Image.new("RGBA", (icon_w + 45 + text_w + 30, max(icon_h, text_h + 30)), (0, 0, 0, 0))
    icon_rgba.thumbnail((icon_w, icon_h), Image.Resampling.LANCZOS)
    canvas.alpha_composite(icon_rgba, (0, (canvas.height - icon_rgba.height) // 2))
    draw = ImageDraw.Draw(canvas)
    tx = icon_w + 45
    ty = (canvas.height - text_h) // 2 - min(b1[1], b2[1])
    outline = (7, 31, 72, 215)
    draw.text((tx, ty), first, font=font, fill=(246, 248, 251, 255), stroke_width=5, stroke_fill=outline)
    draw.text(
        (tx + b1[2] - b1[0], ty),
        second,
        font=font,
        fill=(18, 157, 239, 255),
        stroke_width=5,
        stroke_fill=outline,
    )
    return canvas


def load_logo(brand: str) -> Image.Image:
    source = Image.open(LOGOS / f"{brand}_로고.png")
    if brand == "썬더배관" and source.mode != "RGBA":
        logo = transparent_thunder_logo(source)
        logo.save(LOGOS / f"{brand}_로고.png")
    else:
        logo = source.convert("RGBA")
    alpha = logo.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        raise RuntimeError(f"Empty logo alpha: {brand}")
    return logo.crop(bbox)


def add_printed_logo(image: Image.Image, logo: Image.Image, box: tuple[int, int, int, int], seed: int) -> Image.Image:
    x1, y1, x2, y2 = box
    box_w, box_h = x2 - x1, y2 - y1
    max_w = max(220, int(box_w * 0.97))
    max_h = max(72, int(box_h * 0.92))
    scale = min(max_w / logo.width, max_h / logo.height)
    size = (max(1, round(logo.width * scale)), max(1, round(logo.height * scale)))
    mark = logo.resize(size, Image.Resampling.LANCZOS)

    # Small tilt follows natural shoulder variations instead of looking pasted on.
    angle = (-1.4, -0.6, 0.4, 1.0, 0.0)[seed % 5]
    mark = mark.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    px = int((x1 + x2 - mark.width) / 2)
    py = int(y1 + max(0, (box_h - mark.height) * 0.45))
    px = max(0, min(image.width - mark.width, px))
    py = max(0, min(image.height - mark.height, py))

    # Let the local fabric brightness/mesh modulate the ink opacity.
    fabric = image.crop((px, py, px + mark.width, py + mark.height)).convert("L")
    fabric = ImageEnhance.Contrast(fabric).enhance(1.35)
    texture = fabric.point(lambda value: 150 + int(value * 0.36))
    alpha = ImageChops.multiply(mark.getchannel("A"), texture)
    alpha = ImageEnhance.Brightness(alpha).enhance(0.93)
    mark.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.18)))

    result = image.convert("RGBA")
    result.alpha_composite(mark, (px, py))
    return result.convert("RGB")


def main() -> None:
    logos = {brand: load_logo(brand) for brand in BRANDS}
    rows = []
    for brand_index, brand in enumerate(BRANDS):
        for group in GROUPS:
            keyword = KEYWORDS[group]
            target_dir = OUTPUT / brand / group
            target_dir.mkdir(parents=True, exist_ok=True)
            for number in WORKER_NUMBERS:
                source = WORKERS / f"{group}_{number:02d}.png"
                with Image.open(source) as opened:
                    image = opened.convert("RGB")
                image = transform_worker(image, brand_index)
                if image.size != (1448, 1086):
                    image = image.resize((1448, 1086), Image.Resampling.LANCZOS)
                box = detect_worker(image)
                image = add_printed_logo(image, logos[brand], box, number + brand_index * 7)
                target = target_dir / f"{brand}_{keyword}_{number:02d}.webp"
                image.save(target, "WEBP", quality=91, method=6)
                rows.append((brand, keyword, number, "작업자+캐릭터로고", str(target.relative_to(OUTPUT))))
        print(f"completed={brand}")

    # The five approved PNG previews were temporary placeholders in the brand tree.
    for path in OUTPUT.rglob("*.png"):
        path.unlink()

    csv_path = OUTPUT / "브랜드별_최종이미지_목록.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(["브랜드", "키워드", "번호", "유형", "파일"])
        writer.writerows(rows)

    print(f"worker_images={len(rows)}")


if __name__ == "__main__":
    main()
