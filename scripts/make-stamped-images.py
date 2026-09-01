#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
싹쓰리배관 글에 붙일 이미지를 만든다. 사진 한 장에 {지역명}{키워드}{전화번호}를 박는다.

    python scripts/make-stamped-images.py --site ssak

왜 지역마다 따로 만드나
  검색엔진은 지각 해시로 같은 사진을 잡는다. 한 장을 3,072편에 돌려 쓰면 그건
  같은 이미지다. 글자가 다르면 해시가 달라진다 — 그래서 (시군구 × 키워드)마다
  한 장씩 만든다.

같은 구·같은 키워드의 원인정보/비용정보 두 편은 한 장을 같이 쓴다.
글자가 같으니 나눠 만들 이유가 없다.
"""
import argparse
import hashlib
import io
import json
import os
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "output", "최종_납품_이미지_모음", "이미지")
OUT_W, OUT_H = 800, 600          # 원본 1448×1086 은 글 안에 넣기엔 크다
QUALITY = 82

FONTS = [
    "C:/Windows/Fonts/malgunbd.ttf",
    "C:/Windows/Fonts/malgun.ttf",
    "C:/Windows/Fonts/NanumGothicBold.ttf",
]


def seed_of(*parts):
    """결정적 선택. 다시 돌려도 같은 지역에 같은 사진이 붙는다."""
    h = hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()
    return int(h[:8], 16)


def load_font(size):
    for p in FONTS:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    raise SystemExit("한글 글꼴을 못 찾았습니다: " + " / ".join(FONTS))


def fit(img, w, h):
    """비율을 지키며 가운데를 잘라 w×h 로 맞춘다."""
    r_src = img.width / img.height
    r_dst = w / h
    if r_src > r_dst:
        nh, nw = h, int(h * r_src)
    else:
        nw, nh = w, int(w / r_src)
    img = img.resize((nw, nh), Image.LANCZOS)
    return img.crop(((nw - w) // 2, (nh - h) // 2, (nw - w) // 2 + w, (nh - h) // 2 + h))


def stamp(img, region, keyword, phone):
    """가운데에 어두운 판을 깔고 세 줄을 얹는다. 사진 위 글자는 이렇게 해야 읽힌다."""
    w, h = img.size
    f_big = load_font(int(w / 11))
    f_kw = load_font(int(w / 9))
    f_tel = load_font(int(w / 13))

    lines = [
        (region, f_big, "#FFFFFF"),
        (keyword, f_kw, "#FFD43B"),
        (phone, f_tel, "#4DABF7"),
    ]

    d = ImageDraw.Draw(img)
    sizes = []
    for text, font, _ in lines:
        b = d.textbbox((0, 0), text, font=font)
        sizes.append((b[2] - b[0], b[3] - b[1]))

    gap = int(w / 40)
    total_h = sum(s[1] for s in sizes) + gap * (len(lines) - 1)
    pad_x, pad_y = int(w / 16), int(w / 26)
    box_w = max(s[0] for s in sizes) + pad_x * 2
    box_h = total_h + pad_y * 2
    bx, by = (w - box_w) // 2, (h - box_h) // 2

    veil = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(veil).rectangle([bx, by, bx + box_w, by + box_h], fill=(0, 0, 0, 165))
    img = Image.alpha_composite(img.convert("RGBA"), veil).convert("RGB")
    d = ImageDraw.Draw(img)

    y = by + pad_y
    for (text, font, color), (tw, th) in zip(lines, sizes):
        x = (w - tw) // 2
        d.text((x + 3, y + 3), text, font=font, fill=(0, 0, 0))
        d.text((x, y), text, font=font, fill=color)
        y += th + gap
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="ssak")
    ap.add_argument("--limit", type=int, default=0, help="시험 삼아 몇 장만")
    args = ap.parse_args()

    site = json.load(io.open(os.path.join(ROOT, "data/brands/%s.json" % args.site), encoding="utf-8"))
    blog = json.load(io.open(os.path.join(ROOT, "data/brands/%s-blog.json" % args.site), encoding="utf-8"))
    regions = json.load(io.open(os.path.join(ROOT, "data/hub/regions.json"), encoding="utf-8"))

    srcs = sorted(
        os.path.join(SRC_DIR, f) for f in os.listdir(SRC_DIR)
        if f.lower().endswith((".webp", ".png", ".jpg", ".jpeg"))
    )
    if len(srcs) < 4:
        raise SystemExit("원본이 모자랍니다: %s" % SRC_DIR)

    # 시군구 이름이 여러 시도에 겹친다 (중구가 다섯 곳). 겹치면 시도를 앞에 붙인다.
    names = []
    for sd in regions["sido"]:
        for g in sd["sigungu"]:
            names.append((g["code"][:5], sd["shortName"], g["shortName"]))
    dup = {n for _, _, n in names if [x[2] for x in names].count(n) > 1}

    out_dir = os.path.join(ROOT, "apps/brand-static/%s-template/assets/img/kw" % args.site)
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        os.remove(os.path.join(out_dir, f))

    phone = site["phone"]
    made = []
    total = len(names) * len(blog["keywords"])
    n = 0
    for code, sido, gu in names:
        label = ("%s %s" % (sido, gu)) if gu in dup else gu
        slug_label = label.replace(" ", "")
        for kw in blog["keywords"]:
            n += 1
            if args.limit and n > args.limit:
                break
            s = seed_of(args.site, code, kw["slug"])
            src = srcs[s % len(srcs)]
            img = fit(Image.open(src).convert("RGB"), OUT_W, OUT_H)
            # 같은 원본이 여러 번 쓰이므로 밝기·대비를 조금씩 흔든다
            img = ImageEnhance.Brightness(img).enhance(0.95 + (s % 12) / 100.0)
            img = ImageEnhance.Contrast(img).enhance(0.96 + (s % 9) / 100.0)
            img = stamp(img, label, kw["label"], phone)
            name = "kw/%s-%s.webp" % (slug_label, kw["slug"])
            img.save(os.path.join(ROOT, "apps/brand-static/%s-template/assets/img" % args.site, name),
                     "WEBP", quality=QUALITY, method=4)
            made.append({"code": code, "kw": kw["slug"], "file": name,
                         "label": "%s %s" % (label, kw["label"]),
                         "width": OUT_W, "height": OUT_H})
            if n % 200 == 0:
                sys.stdout.write("  %d/%d\n" % (n, total))
                sys.stdout.flush()

    idx = os.path.join(ROOT, "data/brands/%s-stamped.json" % args.site)
    io.open(idx, "w", encoding="utf-8").write(
        json.dumps({"_note": "make-stamped-images.py 가 만든다. 직접 고치지 말 것.",
                    "images": made}, ensure_ascii=False, indent=1) + "\n")
    size = sum(os.path.getsize(os.path.join(ROOT, "apps/brand-static/%s-template/assets/img" % args.site, m["file"]))
               for m in made)
    sys.stdout.write("  %d장 · %.1fMB · %s\n" % (len(made), size / 1048576.0, idx))


if __name__ == "__main__":
    main()
