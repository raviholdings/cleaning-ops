from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "branding"
FONT = Path(r"C:\Windows\Fonts\malgunbd.ttf")

BRANDS = [
    ("dream-com", "드림컴뚜러", Path(r"C:\Users\LD\.codex\generated_images\01a05714-1a77-7a10-b403-b68c4f100e3d\exec-bddecd1e-1fcf-4d07-a2de-475323bc2c66.png"), "#102a72", "#28d9ef"),
    ("thunder-pipe", "썬더배관", Path(r"C:\Users\LD\.codex\generated_images\01a05714-1a77-7a10-b403-b68c4f100e3d\exec-e664911b-0f06-4e20-8a4e-a8e28b36f65e.png"), "#092559", "#ffd400"),
    ("beaver-pipe", "비버배관", Path(r"C:\Users\LD\.codex\generated_images\01a05714-1a77-7a10-b403-b68c4f100e3d\exec-5ab2e4dc-333d-4c8c-9de8-71a3dd5c2792.png"), "#082c52", "#f4ead0"),
    ("ssakssri-pipe", "싹쓰리배관", Path(r"C:\Users\LD\.codex\generated_images\01a05714-1a77-7a10-b403-b68c4f100e3d\exec-c8036008-fa46-4b3d-956b-73d960bd5cbe.png"), "#082957", "#64df00"),
    ("drain-master", "하수구도사", Path(r"C:\Users\LD\.codex\generated_images\01a05714-1a77-7a10-b403-b68c4f100e3d\exec-44976885-3ce8-4aea-80f1-44634f20625c.png"), "#063d2c", "#f3bd32"),
]


def alpha_bbox(im: Image.Image):
    return im.getchannel("A").getbbox()


def find_split(im: Image.Image) -> int:
    alpha = im.getchannel("A")
    w, h = im.size
    counts = []
    for y in range(int(h * 0.48), int(h * 0.78)):
        row = alpha.crop((0, y, w, y + 1))
        counts.append((row.getbbox()[2] if row.getbbox() else 0, y))
    # Prefer the visual valley separating emblem and generated wordmark.
    return min(counts, key=lambda item: item[0])[1]


def fit_image(im: Image.Image, box: tuple[int, int]) -> Image.Image:
    copy = im.copy()
    copy.thumbnail(box, Image.Resampling.LANCZOS)
    return copy


def make_assets(slug: str, name: str, source: Path, dark: str, accent: str):
    target = OUT / slug
    target.mkdir(parents=True, exist_ok=True)
    original = Image.open(source).convert("RGBA")
    original.save(target / "concept-original.png")

    split = find_split(original)
    emblem = original.crop((0, 0, original.width, split))
    bbox = alpha_bbox(emblem)
    if bbox:
        emblem = emblem.crop(bbox)

    # Final primary logo: generated emblem + deterministic, exact Korean wordmark.
    canvas = Image.new("RGBA", (1200, 1200), (0, 0, 0, 0))
    fitted = fit_image(emblem, (960, 820))
    canvas.alpha_composite(fitted, ((1200 - fitted.width) // 2, 42 + (810 - fitted.height) // 2))
    draw = ImageDraw.Draw(canvas)
    font_size = 166 if len(name) <= 5 else 146
    font = ImageFont.truetype(str(FONT), font_size)
    stroke = max(8, font_size // 15)
    text_box = draw.textbbox((0, 0), name, font=font, stroke_width=stroke)
    text_w = text_box[2] - text_box[0]
    while text_w > 1080:
        font_size -= 4
        font = ImageFont.truetype(str(FONT), font_size)
        stroke = max(8, font_size // 15)
        text_box = draw.textbbox((0, 0), name, font=font, stroke_width=stroke)
        text_w = text_box[2] - text_box[0]
    x = (1200 - text_w) // 2
    draw.text((x, 925), name, font=font, fill=accent, stroke_width=stroke, stroke_fill=dark)
    canvas.save(target / "logo.png", optimize=True)

    # Favicon master and multi-resolution .ico, using the emblem only.
    fav = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    fav_emblem = fit_image(emblem, (456, 456))
    fav.alpha_composite(fav_emblem, ((512 - fav_emblem.width) // 2, (512 - fav_emblem.height) // 2))
    fav.save(target / "favicon.png", optimize=True)
    fav.save(target / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    for brand in BRANDS:
        make_assets(*brand)
    print(f"Built {len(BRANDS)} brand kits in {OUT}")
