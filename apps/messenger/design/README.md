# linen — 아르고 메신저 디자인 시안·시스템

> 메신저 앱(`apps/messenger`)의 룩 정본. 토큰은 `tokens.css` 한 파일, v2 컴포넌트 계약은 `system-v2.css`. 정적 시안은 `0*-v2.html` 5장. 스크린샷(`shots/`)은 로컬 실측 산출물이라 커밋하지 않는다.
> Argo 앱의 `app/globals.css` linen 테마 가족은 **이 폴더의 tokens.css에서 생성**한다(손으로 옮겨 적지 않는다 — 두 곳이 갈리면 `test/theme-linen-sync`가 잡는다).

## 보는 법

```
cd apps/messenger && npx vite --port 5183
open http://localhost:5183/design/01-channel-v2.html            # 라이트
open http://localhost:5183/design/01-channel-v2.html?theme=linen-dark
```

| 파일 | 화면 |
|---|---|
| `01-channel-v2.html` | 채널 대화(소유자 시점) — 사람 메시지(캔버스 위 텍스트)·크루 시트·내 글 차콜 버블·날짜 노드·파일 칩·타이핑·2단 독 |
| `02-approval-v2.html` | 결재 슬립 — 만료·거절·승인·승인 실행 중·요청(시간순) |
| `03-empty-v2.html` | 빈 상태 — 척추 위 3단계 노드 |
| `04-auth-v2.html` | 로그인 — 머리띠 카드 |
| `05-states-v2.html` | 상태 모음(멤버 시점) — 로딩·결재 대기(비소유자)·전송 중·실패·삭제됨·부재중 |

## 무드와 모티프

웜 그레이지 캔버스 위 순백 카드, 왼쪽은 **라이트에서도 차콜인 레일**, 형광 옐로는 점·노드·결재 요청 머리띠·전송 버튼에만(면 채움은 머리띠와 전송 둘뿐). 그림자 대신 명도·재질 3단으로 위계.

| 모티프 | 규칙 |
|---|---|
| 타임라인 척추 | 스레드 왼쪽 2px 선(`--border`) 위에 아바타·날짜 노드가 앉는다. 아바타는 4px 캔버스 링으로 선을 끊는다. 크루 시트는 좌상 반경 6px, 내 글은 우상 6px |
| 사람 원 / 크루 타일 | 사람 = 28px 원, 크루 = 28px 둥근 사각(r 9) + 옐로 별 배지. 레일에서 크루는 40px 타일 카드, 채널은 칩 랩(6개 초과 `+N`), 멤버는 겹친 아바타 스택 |
| 2단 다크 독 | 입력 줄 + 도구 줄(첨부·멘션 │ 상태) + 옐로 원형 전송. `.msgr-composer`는 linen 차콜 스코프(globals.css) |
| 결재 슬립 | 머리띠(요청=옐로 / 확정=차콜 / 만료=회색 / 비소유자=연회색+옐로 밑줄) + 본문 + 도장 실(체크=승인, 엑스=거절, 시계=만료) |

아이콘: 16 그리드 · 1.5px 스트로크 · 둥근 끝의 자체 스프라이트(`src/icons.jsx`). 한글 마이크로라벨은 Pretendard 11px(`.msgr-klabel`), 모노는 id·시각·카운트에만.

## 토큰 (tokens.css 정본)

| 토큰 | 라이트 | 다크 | 비고 |
|---|---|---|---|
| `--bg` | `#e9e6df` | `#1f1e1b` | 캔버스 |
| `--card` · `--card-2` · `--secondary` | `#fbfaf7` · `#f1efe9` · `#e0dcd3` | `#2a2926` · `#33322e` · `#3c3a35` | 표면 3단 |
| `--fg` · `--fg-2` · `--fg-3` | `#26241f` · `#5a564d` · `#6b655e` | `#e6e2d8` · `#b3ada2` · `#979185` | 본문 12.4+ · 보조 5.9+ · 최약 4.6+ |
| `--primary` / `--primary-fg` | `#1f1e1b` / `#f4f2ec` | `#ececea` / `#1f1e1b` | 반전 버튼·내 글 |
| `--accent` | `= --primary` | `= --primary` | 계기판은 차콜(옐로 아님) |
| `--mark` / `--mark-fg` | `#e8e400` / `#1f1e1b` | `#f1ee3a` / `#1f1e1b` | 표시 색 — 점·노드·머리띠·전송 |
| 레일 스코프(`.side`·`.msgr-composer`) | 배경 `#1f1e1b`, 글자 `#e6e2d8 / #a8a297 / #8d877c`, 상태색은 다크 갈래 | 배경 `#171614` | 스코프 안 `--bg` = 레일 배경 |
| `--shadow-card` / `--shadow-float` | none / `0 8px 24px rgba(31,30,27,.14)` | none / none | 플로팅 독·팝업만 |

## 실측 방법

- 데스크톱: Aside로 1440×900 라이트/다크 스크린샷, `scrollWidth == innerWidth`, `right > innerWidth` 요소 0, console/pageerror 0.
- 폰 폭: 같은 오리진 페이지에 390×844 iframe을 심어 `matchMedia('(max-width:720px)')`가 실제로 참인 상태에서 클립 스크린샷(`html.style.zoom`은 미디어쿼리를 움직이지 않는다).
- 대비: WCAG 상대 휘도로 토큰 쌍 재계산(본문 ≥ 10, 보조 ≥ 6, 최약 ≥ 4.5).

## Argo 앱 접점

`app/globals.css`의 `linen` / `@media dark` / `linen-light` / `linen-dark` 4블록, `app/theme.jsx THEMES`, `app/i18n.jsx settings.family.linen·settings.theme.linen*`, 설정 `FAMILIES`·`THEME_SWATCHES`. 메신저는 `ThemeProvider defaultTheme="linen"`(`src/main.jsx`)과 `index.html` 부트 폴백이 같은 값이어야 한다(`test/theme-boot-default`).
시안에만 있고 앱에 없는 것: 도구 줄의 명령·폴더·회의 버튼, "승인 · 실행 중" 상태, 전송 중/실패 낙관 상태.
