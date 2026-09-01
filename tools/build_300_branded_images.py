from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps
import csv
import shutil

from detect_uniform_patches import detect_patch, patch_mode

SOURCE = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_기본이미지_PNG")
OUTPUT = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드별_작업이미지_300장_WEBP")
FONT = Path(r"C:\Windows\Fonts\malgunbd.ttf")

BRANDS = ["썬더배관", "드림컴뚜러", "비버배관", "하수구도사", "싹쓰리배관"]
KEYWORDS = {
    "01_하수구": "하수구",
    "02_변기": "변기",
    "03_싱크대": "싱크대",
    "04_식당주방": "식당주방",
    "05_누수": "누수",
    "06_고압세척": "고압세척",
}
AGES = ["30대", "40대", "50대", "60대", "30대", "40대", "50대", "60대", "40대", "50대"]

# Boxes were inspected at full 1448 x 1086 resolution for the three poses
# whose patches are too oblique or large for reliable automatic segmentation.
MANUAL = {
    "01_하수구_10.png": (724, 242, 839, 348),
    "02_변기_08.png": (824, 365, 1228, 590),
    "05_누수_05.png": (1012, 540, 1202, 696),
}

def keyword_group(path):
    return "_".join(path.stem.split("_")[:2])

def transform(image, box, brand_index):
    width, height = image.size
    if brand_index == 0:
        return image, box
    if brand_index == 1:
        margin_x, margin_y = 10, 8
        image = image.crop((margin_x, margin_y, width-margin_x, height-margin_y)).resize((width,height), Image.Resampling.LANCZOS)
        if box:
            sx, sy = width/(width-2*margin_x), height/(height-2*margin_y)
            x1,y1,x2,y2=box
            box=(int((x1-margin_x)*sx),int((y1-margin_y)*sy),int((x2-margin_x)*sx),int((y2-margin_y)*sy))
        return image, box
    if brand_index == 2:
        image = ImageOps.mirror(image)
        if box:
            x1,y1,x2,y2=box
            box=(width-x2,y1,width-x1,y2)
        return image, box
    if brand_index == 3:
        image = ImageEnhance.Color(image).enhance(.94)
        image = ImageEnhance.Brightness(image).enhance(1.015)
        return image, box
    image = ImageOps.mirror(image)
    image = ImageEnhance.Contrast(image).enhance(1.025)
    if box:
        x1,y1,x2,y2=box
        box=(width-x2,y1,width-x1,y2)
    return image, box

def fitted_font(text, max_width, max_height):
    size = max(14, min(46, int(max_height * .62)))
    while size > 12:
        font = ImageFont.truetype(str(FONT), size)
        left, top, right, bottom = font.getbbox(text)
        if right-left <= max_width and bottom-top <= max_height:
            return font
        size -= 1
    return ImageFont.truetype(str(FONT), 12)

def add_badge(image, box, brand):
    if not box:
        return image
    x1,y1,x2,y2=box
    width, height=x2-x1,y2-y1
    inset_x=max(5,int(width*.07))
    inset_y=max(4,int(height*.22))
    tx1,ty1,tx2,ty2=x1+inset_x,y1+inset_y,x2-inset_x,y2-inset_y
    draw=ImageDraw.Draw(image,"RGBA")
    font=fitted_font(brand,tx2-tx1-8,ty2-ty1-6)
    bbox=draw.textbbox((0,0),brand,font=font)
    tw,th=bbox[2]-bbox[0],bbox[3]-bbox[1]
    px=tx1+(tx2-tx1-tw)/2
    py=ty1+(ty2-ty1-th)/2-bbox[1]
    draw.text((px,py),brand,font=font,fill=(18,42,72,255))
    return image

def make_contact_sheet(brand, files):
    tw,th,ch=240,180,205
    sheet=Image.new("RGB",(tw*6,ch*10),"white")
    draw=ImageDraw.Draw(sheet)
    font=ImageFont.load_default()
    for idx,path in enumerate(files):
        with Image.open(path) as image:
            thumb=image.convert("RGB")
            thumb.thumbnail((tw,th))
            x,y=(idx%6)*tw,(idx//6)*ch
            sheet.paste(thumb,(x,y))
            draw.text((x+4,y+184),path.stem,fill="black",font=font)
    target=OUTPUT.parent/f"{brand}_60장_검수시트.jpg"
    sheet.save(target,"JPEG",quality=88)
    return target

def main():
    source_files=sorted(SOURCE.glob("*.png"))
    if len(source_files)!=60:
        raise RuntimeError(f"Expected 60 base images, got {len(source_files)}")
    OUTPUT.mkdir(parents=True,exist_ok=True)
    rows=[]
    previews=[]
    for brand_index,brand in enumerate(BRANDS):
        brand_files=[]
        for source in source_files:
            group=keyword_group(source)
            keyword=KEYWORDS[group]
            number=int(source.stem.rsplit("_",1)[1])
            mode=patch_mode(source)
            age="해당 없음" if mode=="none" else AGES[number-1]
            with Image.open(source) as opened:
                image=opened.convert("RGB")
            box=None
            if mode!="none":
                box=MANUAL.get(source.name) or detect_patch(image,mode)
                if not box:
                    raise RuntimeError(f"Badge patch not found: {source.name}")
            image,box=transform(image,box,brand_index)
            image=add_badge(image,box,brand)
            folder=OUTPUT/brand/group
            folder.mkdir(parents=True,exist_ok=True)
            target=folder/f"{brand}_{keyword}_{number:02d}.webp"
            image.save(target,"WEBP",quality=88,method=6)
            brand_files.append(target)
            rows.append([brand,keyword,number,mode,age,str(target.relative_to(OUTPUT)),target.stat().st_size])
        previews.append(make_contact_sheet(brand,brand_files))
        shutil.make_archive(str(OUTPUT.parent/f"{brand}_작업이미지_60장_WEBP"),"zip",OUTPUT,brand)
        print(f"completed={brand} count={len(brand_files)}")

    with (OUTPUT/"브랜드별_이미지_목록.csv").open("w",newline="",encoding="utf-8-sig") as handle:
        writer=csv.writer(handle)
        writer.writerow(["브랜드","키워드","번호","구도","연령대","파일","용량(bytes)"])
        writer.writerows(rows)
    (OUTPUT/"README.txt").write_text(
        "브랜드 5개 × 키워드 6개 × 각 10장 = 총 300장 WEBP 이미지입니다.\n"
        "작업자가 있는 사진은 가슴 또는 등 명찰에 브랜드명을 넣었습니다.\n"
        "사람이 없는 사진은 현장·설비·장비 중심의 독립 이미지입니다.\n"
        "모든 이미지는 AI 생성 홍보용 예시이며 실제 고객 현장 촬영본으로 표시하면 안 됩니다.\n",
        encoding="utf-8",
    )
    shutil.make_archive(str(OUTPUT),"zip",OUTPUT.parent,OUTPUT.name)
    print(f"total={len(rows)}")
    print(f"zip={OUTPUT}.zip")

if __name__=="__main__":
    main()
