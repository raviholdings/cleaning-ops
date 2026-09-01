from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps
import csv
import shutil

from detect_new_worker_back import detect_worker

EQUIPMENT=Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_기본이미지_PNG")
WORKERS=Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_신규작업자_PNG")
OUTPUT=Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드별_신규작업자_작업이미지_300장_WEBP")
FONT=Path(r"C:\Windows\Fonts\malgunbd.ttf")

BRANDS=["썬더배관","드림컴뚜러","비버배관","하수구도사","싹쓰리배관"]
PARTS={"썬더배관":("썬더","배관"),"드림컴뚜러":("드림컴","뚜러"),"비버배관":("비버","배관"),"하수구도사":("하수구","도사"),"싹쓰리배관":("싹쓰리","배관")}
GROUPS=["01_하수구","02_변기","03_싱크대","04_식당주방","05_누수","06_고압세척"]
KEYWORDS={"01_하수구":"하수구","02_변기":"변기","03_싱크대":"싱크대","04_식당주방":"식당주방","05_누수":"누수","06_고압세척":"고압세척"}
WORKER_NUMBERS={2,3,5,6,8,10}
AGES={2:"30대",3:"40대",5:"50대",6:"60대",8:"40대",10:"50대"}

def transform(image,box,index):
    width,height=image.size
    if index==0:return image,box
    if index==1:
        mx,my=10,8
        image=image.crop((mx,my,width-mx,height-my)).resize((width,height),Image.Resampling.LANCZOS)
        if box:
            sx,sy=width/(width-2*mx),height/(height-2*my)
            x1,y1,x2,y2=box
            box=(int((x1-mx)*sx),int((y1-my)*sy),int((x2-mx)*sx),int((y2-my)*sy))
        return image,box
    if index==2:
        image=ImageOps.mirror(image)
        if box:
            x1,y1,x2,y2=box;box=(width-x2,y1,width-x1,y2)
        return image,box
    if index==3:
        return ImageEnhance.Brightness(ImageEnhance.Color(image).enhance(.95)).enhance(1.012),box
    image=ImageEnhance.Contrast(ImageOps.mirror(image)).enhance(1.02)
    if box:
        x1,y1,x2,y2=box;box=(width-x2,y1,width-x1,y2)
    return image,box

def fit_font(text,max_width,max_height):
    size=min(48,int(max_height*.75))
    while size>=16:
        font=ImageFont.truetype(str(FONT),size)
        b=font.getbbox(text)
        if b[2]-b[0]<=max_width and b[3]-b[1]<=max_height:return font
        size-=1
    return ImageFont.truetype(str(FONT),16)

def add_brand(image,box,brand):
    x1,y1,x2,y2=box
    height=y2-y1
    # Move below the collar/hair line while keeping the text in the mesh shoulder yoke.
    y1+=int(height*.15);y2+=int(height*.15)
    first,second=PARTS[brand]
    d=ImageDraw.Draw(image,"RGBA")
    font=fit_font(first+second,(x2-x1)*.92,(y2-y1)*.8)
    b1=d.textbbox((0,0),first,font=font,stroke_width=1)
    b2=d.textbbox((0,0),second,font=font,stroke_width=1)
    w1,w2=b1[2]-b1[0],b2[2]-b2[0]
    th=max(b1[3]-b1[1],b2[3]-b2[1])
    px=x1+(x2-x1-w1-w2)/2
    py=y1+(y2-y1-th)/2-min(b1[1],b2[1])
    d.text((px,py),first,font=font,fill=(245,247,249,255),stroke_width=1,stroke_fill=(15,31,50,190))
    d.text((px+w1,py),second,font=font,fill=(55,171,239,255),stroke_width=1,stroke_fill=(15,31,50,190))
    return image

def contact_sheet(brand,files):
    tw,th,ch=240,180,205
    sheet=Image.new("RGB",(tw*6,ch*10),"white")
    draw=ImageDraw.Draw(sheet);font=ImageFont.load_default()
    for i,path in enumerate(files):
        with Image.open(path) as opened:image=opened.convert("RGB")
        image.thumbnail((tw,th));x,y=(i%6)*tw,(i//6)*ch
        sheet.paste(image,(x,y));draw.text((x+4,y+184),path.stem,fill="black",font=font)
    sheet.save(OUTPUT.parent/f"{brand}_신규작업자_60장_검수시트.jpg","JPEG",quality=88)

def main():
    if len(list(WORKERS.glob("*.png")))!=36:raise RuntimeError("Expected 36 new worker images")
    OUTPUT.mkdir(parents=True,exist_ok=True)
    rows=[]
    for bi,brand in enumerate(BRANDS):
        brand_files=[]
        for group in GROUPS:
            keyword=KEYWORDS[group]
            for number in range(1,11):
                worker=number in WORKER_NUMBERS
                source=(WORKERS if worker else EQUIPMENT)/f"{group}_{number:02d}.png"
                with Image.open(source) as opened:image=opened.convert("RGB")
                box=detect_worker(image) if worker else None
                image,box=transform(image,box,bi)
                if worker:image=add_brand(image,box,brand)
                folder=OUTPUT/brand/group;folder.mkdir(parents=True,exist_ok=True)
                target=folder/f"{brand}_{keyword}_{number:02d}.webp"
                image.save(target,"WEBP",quality=88,method=6)
                brand_files.append(target)
                rows.append([brand,keyword,number,"신규 작업자" if worker else "현장·장비",AGES.get(number,"해당 없음"),str(target.relative_to(OUTPUT)),target.stat().st_size])
        contact_sheet(brand,brand_files)
        shutil.make_archive(str(OUTPUT.parent/f"{brand}_신규작업자_작업이미지_60장_WEBP"),"zip",OUTPUT,brand)
        print(f"completed={brand} count={len(brand_files)}")
    with (OUTPUT/"브랜드별_신규작업자_이미지_목록.csv").open("w",newline="",encoding="utf-8-sig") as handle:
        writer=csv.writer(handle);writer.writerow(["브랜드","키워드","번호","유형","연령대","파일","용량(bytes)"]);writer.writerows(rows)
    (OUTPUT/"README.txt").write_text(
        "작업자 등장 이미지 180장은 기존 사진을 수정하지 않고 새로 생성했습니다.\n"
        "업체명은 흰 명찰 없이 짙은 메시 작업복 등판에 직접 인쇄했습니다.\n"
        "사람이 없는 현장·장비 이미지 120장과 합쳐 총 300장입니다.\n"
        "모든 이미지는 AI 생성 홍보용 예시이며 실제 고객 현장 촬영본으로 표시하면 안 됩니다.\n",encoding="utf-8")
    shutil.make_archive(str(OUTPUT),"zip",OUTPUT.parent,OUTPUT.name)
    print(f"total={len(rows)}")

if __name__=="__main__":main()
