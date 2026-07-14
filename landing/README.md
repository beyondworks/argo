# Argo Landing

스크롤 스크러빙 신화 스토리텔링 랜딩 페이지. 독립 Next.js 앱 (제품 앱과 별도 배포).

```bash
npm install
npm run dev   # http://localhost:3020
```

- 스택: Next.js 15 (App Router, JS) + GSAP ScrollTrigger + Lenis
- i18n: `lib/i18n.jsx` — `key → [ko, en]`, cmd+/ (ctrl+/) 전환, 기본 ko
- 데이터: `lib/chapters.js` — 5챕터 × 12기능 (모든 문구는 i18n 키)

## 히어로 소스 파이프라인

> 2026-07-13 에디토리얼 리디자인: 히어로 아트 = 크림+잉크 라인아트 (`public/assets/art/ship.webp`,
> 별자리 인터루드 = `art/constellation.webp`). 이전 프레스코 소스는 `assets/hero/`에 보존(대안).

### 1) 정지 아트 (완료 — 유건님 제공 라인아트)

- 히어로: `public/assets/art/ship.png` (1920×1080 원본, webp 사용)
- 인터루드: `public/assets/art/constellation.png`

### 2) Kling 영상 핸드오프 — 콜라주 에디션 (2026-07-13, 우선)

> 히어로가 "표지 → 레이어 콜라주 조립 → 창조의 순간" 스크럽으로 바뀌었다.
> 아래 세트를 Kling 웹에서 변환해 mp4를 주면, ffmpeg로 프레임 시퀀스/웹엠 변환 후
> 스크럽에 연결한다. 공통: **16:9 · 5s · Kling 1.6 Pro 이상**, 이미지의 순수 블랙 배경 유지가 최우선.

> 참고: '두 손'(layer-hands) 레이어는 쇼피파이 도상과 겹쳐 히어로에서 제외했다(2026-07-13 유건 판정).
> 창조의 순간은 CSS/SVG '프롬프트 라인 점화'로 대체 — 영상 불필요. 에셋은 보관.

**세트 1 — 아르고호 항해 (홀드 구간 앰비언트, 최우선)**
- 입력: `public/assets/art/layer-ship.png`
- 프롬프트:

```
The fresco-painted galley ship rocks very gently on the painted waves, the sail
ripples faintly, the crew figures sway subtly with the ship. Keep the aged
fresco style, colors, and every figure's identity completely unchanged. The
background stays PURE SOLID BLACK. No added text, no letters, no warping,
no identity drift, no flicker, no new objects, slow gentle motion only.
```

받은 mp4 처리(제가 실행):

```bash
# 프레임 시퀀스 (홀드 구간 스크럽용, 12fps ≈ 60프레임)
ffmpeg -i ship.mp4 -vf "fps=12,scale=1536:-2" -quality 75 public/assets/art/seq-ship/frame_%04d.webp
# 또는 앰비언트 루프 (webm)
ffmpeg -i ship.mp4 -an -c:v libvpx-vp9 -b:v 900k public/assets/art/ship-loop.webm
```

### (구) 단일 이미지 Kling 변환 — 참고용

- 입력 이미지 (Start Frame): `public/assets/art/ship.png`
- 모델: Kling 1.6 Pro (Elements) 이상 · 길이 **5s** · 비율 **16:9**
- 풀 프롬프트 (라인아트 보존이 핵심):

```
Gentle continuous drift: the ship rocks subtly on calm ink-drawn waves,
the oars row slowly in rhythm, the sail ripples faintly, constellation lines
shimmer very softly. Keep the minimal black ink line-art style on the plain
cream background completely unchanged — same line weights, same figures.
No color change, no shading added, no added text, no letters, no warping,
no identity drift, no flicker, no new objects.
```

### 3) mp4 수령 후 (ffmpeg 변환 → drop-in)

```bash
# a) 배경 루프 webm
ffmpeg -i kling.mp4 -an -c:v libvpx-vp9 -b:v 1M -vf scale=1600:-2 \
  public/assets/hero/loop.webm

# b) 스크롤 스크러빙용 webp 프레임 시퀀스 (12fps ≈ 60프레임/5s)
mkdir -p public/assets/hero/seq
ffmpeg -i kling.mp4 -vf "fps=12,scale=1600:-2" -quality 70 \
  public/assets/hero/seq/frame_%04d.webp

# 모바일용 (선택)
mkdir -p public/assets/hero/seq-m
ffmpeg -i kling.mp4 -vf "fps=12,scale=960:-2" -quality 65 \
  public/assets/hero/seq-m/frame_%04d.webp
```

연결: `components/Hero.jsx`의 `<ScrollSequence manifest={null} …>`를

```jsx
<ScrollSequence
  manifest={{ basePath: '/assets/hero/seq', count: 60, ext: 'webp', pad: 4 }}
  progressRef={progressRef}
  className="hero-canvas"
/>
```

로 바꾸면 히어로 스크롤 스크러빙이 켜진다 (컴포넌트 수정 불필요 — drop-in 계약).

## 데모 영상 교체

각 기능 데모가 준비되면 `components/FeatureBlock.jsx`의 `DemoPlaceholder`에
`video="/assets/demos/featN.webm"`을 넘기면 placeholder가 영상으로 스왑된다.

## Phase 2 남은 일

- Kling 프레임 시퀀스 연결 (위)
- 실제 기능 데모 12편 제작·투입 (`demo-video/` Remotion 파이프라인 활용 가능)
- SplitText 타이포 리빌, 챕터 스냅 튜닝, OG/SEO 메타, Vercel 배포(root=landing/)
- GSAP 라이선스 30초 재확인 (2025-04 이후 상업 포함 무료 — 출시 전 확인)
