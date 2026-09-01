from collections import deque
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SOURCE=Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_신규작업자_PNG")
PREVIEW=Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\신규작업자_등판인쇄위치_검수.jpg")

def detect_worker(image):
    sw,sh=181,136
    small=image.convert("RGB").resize((sw,sh))
    pixels=list(small.getdata())
    mask=[bytearray(sw) for _ in range(sh)]
    for y in range(8,122):
        for x in range(sw):
            r,g,b=pixels[y*sw+x]
            value=(r+g+b)/3
            if 16<value<145 and b>=r*.78 and b>=g*.72 and max(r,g,b)-min(r,g,b)>6:
                mask[y][x]=1
    seen=[bytearray(sw) for _ in range(sh)]
    comps=[]
    for y in range(sh):
        for x in range(sw):
            if not mask[y][x] or seen[y][x]:
                continue
            q=deque([(x,y)]);seen[y][x]=1;pts=[]
            while q:
                px,py=q.popleft();pts.append((px,py))
                for nx,ny in ((px-1,py),(px+1,py),(px,py-1),(px,py+1)):
                    if 0<=nx<sw and 0<=ny<sh and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx]=1;q.append((nx,ny))
            if len(pts)>120:
                xs=[p[0] for p in pts];ys=[p[1] for p in pts]
                box=(min(xs),min(ys),max(xs)+1,max(ys)+1)
                cx=(box[0]+box[2])/2
                score=len(pts)-abs(cx-sw/2)*3
                comps.append((score,box))
    if not comps:
        return (int(image.width*.34),int(image.height*.23),int(image.width*.66),int(image.height*.36))
    _,(x1,y1,x2,y2)=max(comps,key=lambda v:v[0])
    sx,sy=image.width/sw,image.height/sh
    x1,y1,x2,y2=x1*sx,y1*sy,x2*sx,y2*sy
    w,h=x2-x1,y2-y1
    cx=(x1+x2)/2
    bw=min(image.width*.38,w*.62)
    top=y1+h*.27
    bh=max(70,min(150,h*.14))
    return (int(cx-bw/2),int(top),int(cx+bw/2),int(top+bh))

def main():
    files=sorted(SOURCE.glob("*.png"))
    tw,th,ch=300,225,250
    sheet=Image.new("RGB",(tw*6,ch*6),"white")
    draw=ImageDraw.Draw(sheet);font=ImageFont.load_default()
    for idx,path in enumerate(files):
        with Image.open(path) as opened:
            image=opened.convert("RGB")
        box=detect_worker(image)
        ImageDraw.Draw(image).rectangle(box,outline="red",width=10)
        image.thumbnail((tw,th))
        x,y=(idx%6)*tw,(idx//6)*ch
        sheet.paste(image,(x,y));draw.text((x+6,y+230),path.stem,fill="black",font=font)
    sheet.save(PREVIEW,"JPEG",quality=90)
    print(PREVIEW)

if __name__=="__main__":
    main()
