from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps
import csv
import random
import shutil
import sys

from detect_uniform_patches import detect_patch, patch_mode

SOURCE = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_기본이미지_PNG")
OUTPUT = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드별_직접인쇄_작업이미지_300장_WEBP")
SAMPLE = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\업체명_직접인쇄_대표검수.jpg")
FONT = Path(r"C:\Windows\Fonts\malgunbd.ttf")

BRANDS = ["썬더배관", "드림컴뚜러", "비버배관", "하수구도사", "싹쓰리배관"]
PARTS = {
    "썬더배관": ("썬더", "배관"),
    "드림컴뚜러": ("드림컴", "뚜러"),
    "비버배관": ("비버", "배관"),
    "하수구도사": ("하수구", "도사"),
    "싹쓰리배관": ("싹쓰리", "배관"),
}
KEYWORDS = {"01_하수구":"하수구","02_변기":"변기","03_싱크대":"싱크대","04_식당주방":"식당주방","05_누수":"누수","06_고압세척":"고압세척"}
AGES = ["30대","40대","50대","60대","30대","40대","50대","60대","40대","50대"]
MANUAL = {
    "01_하수구_08.png": (660,190,1035,465),
    "01_하수구_10.png": (724,242,839,348),
    "02_변기_08.png": (824,365,1228,590),
    "04_식당주방_10.png": (840,265,995,390),
    "05_누수_05.png": (1012,540,1202,696),
}

def keyword_group(path):
    return "_".join(path.stem.split("_")[:2])

def mean_navy(image, box):
    x1,y1,x2,y2=box
    pad=max(24,int(min(x2-x1,y2-y1)*.35))
    region=image.crop((max(0,x1-pad),max(0,y1-pad),min(image.width,x2+pad),min(image.height,y2+pad)))
    pixels=[]
    for r,g,b in region.getdata():
        value=(r+g+b)/3
        if 18 < value < 145 and b >= r*.82 and b >= g*.75:
            pixels.append((r,g,b))
    if not pixels:
        return (30,48,76)
    return tuple(sum(p[i] for p in pixels)//len(pixels) for i in range(3))

def erase_white_patch(image, box, seed):
    x1,y1,x2,y2=box
    width,height=x2-x1,y2-y1
    margin=max(8,int(min(width,height)*.09))
    ex1,ey1=max(0,x1-margin),max(0,y1-margin)
    ex2,ey2=min(image.width,x2+margin),min(image.height,y2+margin)
    ew,eh=ex2-ex1,ey2-ey1
    base=mean_navy(image,(ex1,ey1,ex2,ey2))
    rng=random.Random(seed)
    texture=Image.new("RGB",(ew,eh))
    px=texture.load()
    for yy in range(eh):
        vertical=int((yy/eh-.5)*5)
        for xx in range(ew):
            noise=rng.randint(-4,4)
            weave=2 if (xx+yy)%5==0 else 0
            px[xx,yy]=tuple(max(0,min(255,c+vertical+noise+weave)) for c in base)
    mask=Image.new("L",(ew,eh),255)
    feather=max(7,int(min(ew,eh)*.10))
    inner=Image.new("L",(ew,eh),0)
    d=ImageDraw.Draw(inner)
    d.rounded_rectangle((feather,feather,ew-feather,eh-feather),radius=feather,fill=255)
    mask=inner.filter(ImageFilter.GaussianBlur(feather/2))
    result=image.copy()
    result.paste(texture,(ex1,ey1),mask)
    # Text placement is slightly taller and wider than the old badge to mimic shoulder printing.
    print_box=(max(0,x1-int(width*.12)),max(0,y1-int(height*.03)),min(image.width,x2+int(width*.12)),min(image.height,y2+int(height*.03)))
    return result,print_box

def transform(image, box, brand_index):
    width,height=image.size
    if brand_index==0:
        return image,box
    if brand_index==1:
        mx,my=10,8
        image=image.crop((mx,my,width-mx,height-my)).resize((width,height),Image.Resampling.LANCZOS)
        if box:
            sx,sy=width/(width-2*mx),height/(height-2*my)
            x1,y1,x2,y2=box
            box=(int((x1-mx)*sx),int((y1-my)*sy),int((x2-mx)*sx),int((y2-my)*sy))
        return image,box
    if brand_index==2:
        image=ImageOps.mirror(image)
        if box:
            x1,y1,x2,y2=box
            box=(width-x2,y1,width-x1,y2)
        return image,box
    if brand_index==3:
        image=ImageEnhance.Color(image).enhance(.95)
        image=ImageEnhance.Brightness(image).enhance(1.012)
        return image,box
    image=ImageOps.mirror(image)
    image=ImageEnhance.Contrast(image).enhance(1.02)
    if box:
        x1,y1,x2,y2=box
        box=(width-x2,y1,width-x1,y2)
    return image,box

def fit_font(text,max_width,max_height,mode):
    cap=52 if mode=="back" else 34
    size=min(cap,int(max_height*.72))
    while size>=13:
        font=ImageFont.truetype(str(FONT),size)
        box=font.getbbox(text)
        if box[2]-box[0]<=max_width and box[3]-box[1]<=max_height:
            return font
        size-=1
    return ImageFont.truetype(str(FONT),13)

def add_direct_text(image,box,brand,mode):
    if not box:
        return image
    first,second=PARTS[brand]
    x1,y1,x2,y2=box
    width,height=x2-x1,y2-y1
    inset_x=int(width*(.07 if mode=="back" else .03))
    inset_y=int(height*(.14 if mode=="back" else .08))
    usable_w=max(20,width-2*inset_x)
    usable_h=max(18,height-2*inset_y)
    font=fit_font(first+second,usable_w,usable_h,mode)
    d=ImageDraw.Draw(image,"RGBA")
    b1=d.textbbox((0,0),first,font=font,stroke_width=1)
    b2=d.textbbox((0,0),second,font=font,stroke_width=1)
    total=(b1[2]-b1[0])+(b2[2]-b2[0])
    text_h=max(b1[3]-b1[1],b2[3]-b2[1])
    px=x1+(width-total)/2
    py=y1+(height-text_h)/2-min(b1[1],b2[1])
    # A subtle navy stroke keeps the embroidered lettering readable on fabric folds.
    d.text((px,py),first,font=font,fill=(244,246,248,255),stroke_width=1,stroke_fill=(16,34,55,180))
    px+=b1[2]-b1[0]
    d.text((px,py),second,font=font,fill=(55,171,239,255),stroke_width=1,stroke_fill=(16,34,55,180))
    return image

def prepare(source,brand,brand_index):
    mode=patch_mode(source)
    with Image.open(source) as opened:
        image=opened.convert("RGB")
    box=None
    if mode!="none":
        box=MANUAL.get(source.name) or detect_patch(image,mode)
        if not box:
            raise RuntimeError(f"Patch not found: {source.name}")
        image,box=erase_white_patch(image,box,source.name)
    image,box=transform(image,box,brand_index)
    image=add_direct_text(image,box,brand,mode)
    return image,mode

def sample():
    picks=["01_하수구_02.png","02_변기_03.png","03_싱크대_05.png","04_식당주방_06.png","06_고압세척_08.png"]
    canvas=Image.new("RGB",(724*2,543*3),"white")
    for i,(brand,name) in enumerate(zip(BRANDS,picks)):
        image,_=prepare(SOURCE/name,brand,i)
        image.thumbnail((724,543))
        canvas.paste(image,((i%2)*724,(i//2)*543))
    canvas.save(SAMPLE,"JPEG",quality=92)
    print(SAMPLE)

def contact_sheet(brand,files):
    tw,th,ch=240,180,205
    sheet=Image.new("RGB",(tw*6,ch*10),"white")
    draw=ImageDraw.Draw(sheet)
    font=ImageFont.load_default()
    for idx,path in enumerate(files):
        with Image.open(path) as opened:
            image=opened.convert("RGB")
            image.thumbnail((tw,th))
        x,y=(idx%6)*tw,(idx//6)*ch
        sheet.paste(image,(x,y))
        draw.text((x+4,y+184),path.stem,fill="black",font=font)
    target=OUTPUT.parent/f"{brand}_직접인쇄_60장_검수시트.jpg"
    sheet.save(target,"JPEG",quality=88)

def build():
    files=sorted(SOURCE.glob("*.png"))
    OUTPUT.mkdir(parents=True,exist_ok=True)
    rows=[]
    for bi,brand in enumerate(BRANDS):
        outputs=[]
        for source in files:
            group=keyword_group(source)
            keyword=KEYWORDS[group]
            number=int(source.stem.rsplit("_",1)[1])
            image,mode=prepare(source,brand,bi)
            folder=OUTPUT/brand/group
            folder.mkdir(parents=True,exist_ok=True)
            target=folder/f"{brand}_{keyword}_{number:02d}.webp"
            image.save(target,"WEBP",quality=88,method=6)
            outputs.append(target)
            age="해당 없음" if mode=="none" else AGES[number-1]
            rows.append([brand,keyword,number,mode,age,str(target.relative_to(OUTPUT)),target.stat().st_size])
        contact_sheet(brand,outputs)
        shutil.make_archive(str(OUTPUT.parent/f"{brand}_직접인쇄_작업이미지_60장_WEBP"),"zip",OUTPUT,brand)
        print(f"completed={brand} count={len(outputs)}")
    with (OUTPUT/"브랜드별_직접인쇄_이미지_목록.csv").open("w",newline="",encoding="utf-8-sig") as handle:
        writer=csv.writer(handle)
        writer.writerow(["브랜드","키워드","번호","구도","연령대","파일","용량(bytes)"])
        writer.writerows(rows)
    (OUTPUT/"README.txt").write_text(
        "업체명이 흰 사각 명찰 없이 작업복 가슴 또는 등 상단에 직접 인쇄된 스타일입니다.\n"
        "브랜드 5개 × 키워드 6개 × 각 10장 = 총 300장 WEBP입니다.\n"
        "모든 이미지는 AI 생성 홍보용 예시이며 실제 고객 현장 촬영본으로 표시하면 안 됩니다.\n",
        encoding="utf-8",
    )
    shutil.make_archive(str(OUTPUT),"zip",OUTPUT.parent,OUTPUT.name)
    print(f"total={len(rows)}")

if __name__=="__main__":
    if "--sample" in sys.argv:
        sample()
    else:
        build()
