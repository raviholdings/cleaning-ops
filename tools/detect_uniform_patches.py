from collections import deque
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SOURCE = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드작업_기본이미지_PNG")
PREVIEW = Path(r"C:\Users\LD\Desktop\ravi\cleaning-ops\output\브랜드명찰_위치검수.jpg")

def patch_mode(path):
    number = int(path.stem.rsplit("_", 1)[1])
    if number in (1, 4, 7, 9):
        return "none"
    if number in (3, 6, 8):
        return "back"
    return "front"

def detect_patch(image, mode):
    small = image.convert("RGB").resize((362, 272))
    pixels = list(small.getdata())
    means = [[0.0] * 362 for _ in range(272)]
    mask = [bytearray(362) for _ in range(272)]
    for y in range(272):
        for x in range(362):
            r, g, b = pixels[y * 362 + x]
            value = (r + g + b) / 3
            means[y][x] = value
            if 18 <= y < 210 and value > 135 and max(r,g,b)-min(r,g,b) < 85:
                mask[y][x] = 1
    seen = [bytearray(362) for _ in range(272)]
    candidates = []
    h, w = 272, 362
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or seen[y][x]:
                continue
            q = deque([(x, y)])
            seen[y][x] = 1
            pts = []
            while q:
                px, py = q.popleft()
                pts.append((px, py))
                for nx, ny in ((px-1,py),(px+1,py),(px,py-1),(px,py+1)):
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = 1
                        q.append((nx,ny))
            if len(pts) < 30:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
            bw, bh = x2-x1+1, y2-y1+1
            aspect = bw / max(bh, 1)
            fill = len(pts) / (bw * bh)
            if not (16 <= bw <= 180 and 6 <= bh <= 80 and 1.4 <= aspect <= 7.5 and fill > .30):
                continue
            pad = 7
            rx1, ry1 = max(0,x1-pad), max(0,y1-pad)
            rx2, ry2 = min(w,x2+pad+1), min(h,y2+pad+1)
            ring_values = [means[yy][xx] for yy in range(ry1,ry2) for xx in range(rx1,rx2)
                           if not (x1 <= xx <= x2 and y1 <= yy <= y2)]
            inner_values = [means[yy][xx] for yy in range(y1,y2+1) for xx in range(x1,x2+1)]
            contrast = sum(inner_values)/len(inner_values) - sum(ring_values)/len(ring_values)
            dark_fraction = sum(1 for value in ring_values if value < 125) / len(ring_values)
            if dark_fraction < .32:
                continue
            cx, cy = (x1+x2)/2, (y1+y2)/2
            target_x = 181 if mode == "back" else 220
            pos_penalty = abs(cx-target_x)*0.12 + abs(cy-90)*0.08
            score = contrast + fill*55 + dark_fraction*90 + min(bw,100)*.1 - pos_penalty
            candidates.append((score,(x1,y1,x2+1,y2+1)))
    if not candidates:
        return None
    _, box = max(candidates, key=lambda item: item[0])
    sx, sy = image.width/362, image.height/272
    return tuple(int(v*s) for v,s in zip(box,(sx,sy,sx,sy)))

def main():
    files = sorted(SOURCE.glob("*.png"))
    tw, th, ch = 240, 180, 205
    sheet = Image.new("RGB", (tw*6,ch*10), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    misses = []
    for idx,path in enumerate(files):
        image = Image.open(path).convert("RGB")
        mode = patch_mode(path)
        box = None if mode == "none" else detect_patch(image, mode)
        if mode != "none" and box is None:
            misses.append(path.name)
        if box:
            d = ImageDraw.Draw(image)
            d.rectangle(box, outline="red", width=10)
        image.thumbnail((tw,th))
        x,y=(idx%6)*tw,(idx//6)*ch
        sheet.paste(image,(x,y))
        draw.text((x+4,y+184),f"{path.stem} {mode} {'OK' if box else ''}",fill="black",font=font)
    sheet.save(PREVIEW,"JPEG",quality=90)
    print(f"misses={len(misses)}")
    print("\n".join(misses))
    print(PREVIEW)

if __name__ == "__main__":
    main()
