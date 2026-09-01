from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

source=Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_신규작업자_PNG")
target=Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\신규작업자_36장_검수시트.jpg")
files=sorted(source.glob("*.png"))
if len(files)!=36:
    raise RuntimeError(f"Expected 36, got {len(files)}")
tw,th,ch=300,225,250
sheet=Image.new("RGB",(tw*6,ch*6),"white")
draw=ImageDraw.Draw(sheet)
font=ImageFont.load_default()
for idx,path in enumerate(files):
    with Image.open(path) as opened:
        image=opened.convert("RGB")
        image.thumbnail((tw,th))
    x,y=(idx%6)*tw,(idx//6)*ch
    sheet.paste(image,(x,y))
    draw.text((x+6,y+230),path.stem,fill="black",font=font)
sheet.save(target,"JPEG",quality=90)
print(target)
