from pathlib import Path
from PIL import Image, ImageDraw, ImageOps


SOURCE = Path(r"C:\Users\LD\.codex\generated_images\01a046e7-d8b2-7183-9ca0-a0e9977b512a")
OUTPUT = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\field-photos")

SECTIONS = [
    "01-toilet-unclogging",
    "02-removed-foreign-objects",
    "03-open-drain-trap",
    "04-removed-sediment",
    "05-kitchen-sink-drain",
    "06-hardened-grease",
    "07-washbasin-pipe",
    "08-pipe-camera",
    "09-full-equipment",
    "10-after-cleanup",
]

FIRST = [
    "exec-bb14dc97-9d81-4968-bfcf-6b9bfed802ae.png",
    "exec-709f87f4-8f8e-43dd-b8d5-743f6d5f0295.png",
    "exec-b9d1db5e-4f18-4006-9bb2-9076cc91a428.png",
    "exec-7e323a8b-c458-4699-ba3d-d3a584b3f67a.png",
    "exec-503fda15-0674-4b9f-8468-3fa75f688263.png",
]


def convert(source: Path, destination: Path) -> None:
    with Image.open(source) as image:
        image = image.convert("RGB")
        target_width = min(1200, max(800, image.width))
        if image.width != target_width:
            target_height = round(image.height * target_width / image.width)
            image = image.resize((target_width, target_height), Image.Resampling.LANCZOS)
        image.save(destination, "WEBP", quality=86, method=6)


def main() -> None:
    first_paths = [SOURCE / name for name in FIRST]
    cutoff = max(path.stat().st_mtime for path in first_paths)
    remaining = sorted(
        (path for path in SOURCE.glob("*.png") if path.stat().st_mtime > cutoff),
        key=lambda path: path.stat().st_mtime,
    )
    if len(remaining) != 45:
        raise RuntimeError(f"Expected 45 later images, found {len(remaining)}")

    sources = first_paths + remaining
    for index, section in enumerate(SECTIONS):
        folder = OUTPUT / section
        folder.mkdir(parents=True, exist_ok=True)
        for variant in range(5):
            source = sources[index * 5 + variant]
            destination = folder / f"{section}-{variant + 1:02d}.webp"
            convert(source, destination)

    thumbs = []
    for index, section in enumerate(SECTIONS):
        for variant in range(5):
            path = OUTPUT / section / f"{section}-{variant + 1:02d}.webp"
            with Image.open(path) as image:
                thumb = ImageOps.fit(image.convert("RGB"), (240, 160), method=Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", (240, 184), "white")
            canvas.paste(thumb, (0, 0))
            ImageDraw.Draw(canvas).text((6, 165), f"{index + 1:02d}-{variant + 1:02d}", fill="black")
            thumbs.append(canvas)

    sheet = Image.new("RGB", (1200, 1840), "#dddddd")
    for index, thumb in enumerate(thumbs):
        sheet.paste(thumb, ((index % 5) * 240, (index // 5) * 184))
    sheet.save(OUTPUT / "contact-sheet.jpg", quality=90)

    webps = list(OUTPUT.glob("*/*.webp"))
    if len(webps) != 50:
        raise RuntimeError(f"Expected 50 WebP files, found {len(webps)}")
    for path in webps:
        with Image.open(path) as image:
            if not 800 <= image.width <= 1200:
                raise RuntimeError(f"Invalid width {image.width}: {path}")
    print(f"Prepared and verified {len(webps)} WebP files")


if __name__ == "__main__":
    main()
