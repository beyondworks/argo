#!/bin/zsh
# 폰 아이콘 재생성(2026-09-22) — icons/ios·icons/android PNG를 모바일 전용 SVG에서 만든다(mobile-assets.mjs가 이 PNG를 gen/에 복사한다).
#  · iOS: source-icon-mobile.svg(꽉 찬 바탕, 심볼 ≈72%) → 모든 크기를 투명 채널 없는 RGB로(App Store 1024 요구, fd2f2019)
#  · 안드로이드 적응형: 전경 = source-icon-android-fg.svg(투명, 심볼은 보이는 66.7% 안에서 ≈72%), 배경 = values/ic_launcher_background
#  · 안드로이드 옛 런처(ic_launcher·ic_launcher_round): 같은 모바일 SVG를 둥근 사각형·원으로 잘라서
# 필요: rsvg-convert(brew librsvg), python3 PIL. 크기는 기존 파일 크기를 그대로 따른다.
set -e
I=${0:A:h}/../src-tauri/icons
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
rsvg-convert -w 1024 -h 1024 "$I/source-icon-mobile.svg" -o "$T/mobile.png"
rsvg-convert -w 1024 -h 1024 "$I/source-icon-android-fg.svg" -o "$T/fg.png"
python3 - "$I" "$T" <<'PY'
import sys, glob, os
from PIL import Image, ImageDraw
I, T = sys.argv[1], sys.argv[2]
mob = Image.open(f'{T}/mobile.png').convert('RGBA')
fg = Image.open(f'{T}/fg.png').convert('RGBA')
def size(p): return Image.open(p).size[0]
def masked(img, n, shape):
    big = img.resize((n * 4, n * 4), Image.LANCZOS)
    m = Image.new('L', big.size, 0); d = ImageDraw.Draw(m)
    if shape == 'circle': d.ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
    else: d.rounded_rectangle((0, 0, big.size[0] - 1, big.size[1] - 1), radius=int(big.size[0] * 0.18), fill=255)
    out = Image.new('RGBA', big.size, (0, 0, 0, 0)); out.paste(big, (0, 0), m)
    return out.resize((n, n), Image.LANCZOS)
for p in sorted(glob.glob(f'{I}/ios/*.png')):
    n = size(p); mob.resize((n, n), Image.LANCZOS).convert('RGB').save(p)
for p in sorted(glob.glob(f'{I}/android/mipmap-*/ic_launcher_foreground.png')):
    n = size(p); fg.resize((n, n), Image.LANCZOS).save(p)
for p in sorted(glob.glob(f'{I}/android/mipmap-*/ic_launcher.png')):
    n = size(p); masked(mob, n, 'rounded').save(p)
for p in sorted(glob.glob(f'{I}/android/mipmap-*/ic_launcher_round.png')):
    n = size(p); masked(mob, n, 'circle').save(p)
print('regenerated', len(glob.glob(f'{I}/ios/*.png')), 'ios +', len(glob.glob(f'{I}/android/mipmap-*/*.png')), 'android')
PY
