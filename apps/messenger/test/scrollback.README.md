# 채널 기록 스크롤백 — 격리 행동 검사 픽스처 (PR #531 검수 산출물)

레포 관례(`apps/messenger/test/dm-lifecycle.supabase.mjs`)를 그대로 따르되 **네 가지가 다르다**.
① 가짜 supabase 가 `order`/`limit` 을 실제로 구현한다(원본은 둘 다 no-op 이라 페이지 질의를 흉내 낼 수 없어 스크롤백 검증 자체가 불가능했다).
② 규모·첨부·지연·실패를 URL 파라미터로 흔든다(`?n= &atts= &replies= &lag= &mlag=`).
③ 모든 질의를 `window.__sbCalls` 에 남겨 "몇 번 나갔나"를 셀 수 있다(동시 로드 가드 검증).
④ `msgr_messages` 질의에 기본 60ms 지연을 둔다 — 지연 0이면 응답이 scroll 이벤트 처리 도중(마이크로태스크)에 끝나 바닥 고정 해제보다 prepend 커밋이 앞서, 실사용에 없는 '바닥으로 끌림'이 픽스처에서만 재현된다.
자격증명·운영 클라이언트는 여전히 import 하지 않고, 외부 요청도 없다.

## 파일

| 파일 | 두는 곳 | 역할 |
|---|---|---|
| `scrollback.supabase.mjs` | `apps/messenger/test/` | 가짜 백엔드(260건 기본 시드·첨부·지연·실패 주입·질의 로그) |
| `scrollback.fixture.html` | `apps/messenger/test/` | 진입 페이지(`?lang=ko|en`) |
| `scrollback.config.mjs` | `apps/messenger/test/` | 격리 Vite 설정(`./supabase.js` 치환 + `FAKE_PLATFORM` 으로 모바일 경로 개방) |
| `scrollback.browser.mjs` | `apps/messenger/test/` | ego-browser 행동 검사 6종(게이트 4 + 결함재현 2) |
| `scrollback.mutations.mjs` | `apps/messenger/test/` | 변이 주입기 M1~M10(핀이 행동을 잠그는지 실증) — **임시 워크트리에서만 실행**(App.jsx를 고쳤다 되돌린다, 백업 `.mutbak`은 gitignore) |
| `scrollback.local.json` | `apps/messenger/test/`(선택, gitignore) | `{ "port", "iosPort", "strict" }` — 환경 변수는 `ego-browser nodejs`에 전달되지 않는다(실측). ego의 작업 디렉터리가 `/`라 `<cwd>/apps/messenger/test/` → 이 클론의 절대경로 순으로 찾는다(다른 워크트리에서는 파일을 못 읽고 기본값으로 돈다) |

## 실행

```bash
# 1) 서버 두 개 — 데스크톱 경로와 모바일(iOS) 경로
cd apps/messenger
SB_TEST_PORT=5371 node node_modules/vite/bin/vite.js --config test/scrollback.config.mjs
SB_TEST_PORT=5372 FAKE_PLATFORM=ios node node_modules/vite/bin/vite.js --config test/scrollback.config.mjs

# 2) 검사 (ego-browser)
ego-browser nodejs < test/scrollback.browser.mjs   # 게이트·결함재현 실패 시 종료코드 1(strict 기본). 포트·strict는 test/scrollback.local.json

# 3) 변이로 잠금 실증
node test/scrollback.mutations.mjs apply M4 src/App.jsx   # → 게이트 1 이 red 여야 한다(임시 워크트리에서)
ego-browser nodejs < test/scrollback.browser.mjs
node test/scrollback.mutations.mjs revert src/App.jsx
```

`node_modules` 가 없는 워크트리에서 돌릴 때는 레포 루트와 `apps/messenger` 양쪽에 심링크를 건다(공유 모듈 `app/ui.jsx` 가 루트의 `marked` 를 import 한다).

## 검사 6종과 변이 대응

아래 '실증' 열은 23c67513·665f646d 에서 직접 돌려 본 결과다(추정 아님).

| 검사 | 무엇을 잠그나 | 실증된 red 변이 |
|---|---|---|
| 게이트 1 · 이전 페이지는 오름차순으로 맨 앞에 | 순서·붙는 방향 | **M4**(reverse 제거) ✅ · **M5**(prepend→append) ✅ |
| 게이트 2 · 본문만: prepend 뒤 앵커 이동 0px | 위치 보존 | **M2**(보정 제거) ✅ 1,047px 밀림 · **M10** ✅ 1,889px |
| 게이트 3 · 끝에 닿으면 '대화의 시작' + 역방향 페이지 질의 정확히 2회 | 더 있음 판정 | **M6**(hasMore 항상 참) ✅ — 컨트롤 문구·메시지 수는 같고 질의 3회로만 잡힌다 |
| 게이트 4 · HIGH-2 검사 전제: 재개 훅이 증분 질의(gt·asc·cap100)를 냈다 | 재개가 실제로 돈다(뒷탭이면 visibilityState를 보이는 상태로 고정) | **M8** ✅(전제·본 검사 둘 다 red) |
| 결함재현 1(HIGH-1) · 첨부 hydrate 착지 뒤에도 0px | 늦게 오는 높이 변화까지 되맞춤 | **M10**(되맞춤 두 갈래 모두 제거) ✅ · **M2** ✅ |
| 결함재현 2(HIGH-2) · 모바일 재개 뒤 기록 유지 | 재개가 목록을 갈아엎지 않음 | **M8**(전체 교체로 되돌림) ✅ 260→100건 |

주의할 두 가지(실측):
- **M3**(중복 제거 삭제)는 이 검사들로 안 잡힌다. 중복은 같은 페이지를 두 번 부를 때만 생기는데, 수정본의 ref 가드가 그 경로를 막았다. 중복 방어를 잠그려면 `window.__sbCalls` 로 질의 수를 세는 검사를 따로 넣어야 한다.
- **M9**(척추 ResizeObserver 되맞춤만 제거)는 red 가 아니다. 수정본이 늦은 높이 변화를 *두 갈래*(레이아웃 효과의 `atts` 의존 + ResizeObserver)로 되맞추기 때문이다 — 이중화가 실제로 동작한다는 증거다. 그래서 HIGH-1 회귀 probe 는 둘 다 끊는 **M10** 이다.

`M1`(lt→gt)·`M7`(동시 로드 가드)은 이 스크립트가 아니라 기존 소스 핀(`test/msgr-history-scrollback.test.mjs`)이 잡는다.

## 이 하네스를 고칠 때 반드시 지킬 것 (전부 실측으로 데인 자리)

1. **`.msgr-row` 만 기다리면 스켈레톤(`.ghost`)에 걸린다.** 높이 574px 상태에서 측정이 시작돼 모든 수치가 틀어진다. 실제 메시지 6건 이상 + 스레드 높이가 뷰포트의 2배를 넘을 때까지 기다린다.
2. **바닥에서 떨어뜨릴 땐 프로그램 `scrollTop`만 쓴다.** L-4(loadOlder가 `stick=false`) 뒤로는 제스처 표시가 필요 없다(합성 휠·실제 휠·제스처 없음 세 경우 모두 자리 유지 실측). CDP 휠(`page.mouse.wheel`)은 6회 중 2회 타임아웃으로 이동 0·부분 이동이 나 게이트가 비결정적이 된다. 로드는 버튼 클릭으로 한다.
3. **한 페이지만 불러와야 측정이 섞이지 않는다.** 휠로 맨 위까지 올리면 보정 뒤에도 상단에 남아 페이지가 연달아 실린다.
4. **밀림은 `|post.y − pre.y|` 다.** 사이에 사용자 스크롤이 없으니 `scrollTop` 변화는 보정의 *결과*지 오차가 아니다. 빼면 이중 계산이 돼 정상 동작이 "10,935px 밀림"으로 보인다.
5. **표본은 Node 쪽에서 뽑는다.** 페이지 안 `requestAnimationFrame` 로거는 탭이 뒤로 가면 스로틀돼 표본이 통째로 빈다.
6. **`page.evaluate` 는 DOM 노드를 돌려주면 직렬화가 터진다**("Object reference chain is too long"). 항상 원시값이나 JSON 문자열로 끝낸다.
7. **정규식의 `\d` 는 여러 겹을 지나며 깨진다** — `[0-9]` 로 쓴다.
8. Vite 설정 파일을 실행 중에 건드리면 서버가 재시작에 실패하고 **프로세스는 살아 있는데 포트는 닫힌 상태**가 된다. 파일을 고쳤으면 서버를 다시 띄운다.

## 마지막 실행 결과 (2026-09-14, `665f646d` 이후 = 앵커 델타 보정 + L-4·L-6)

```
PASS  [게이트] 이전 페이지는 오름차순으로 맨 앞에 붙는다
        클릭=1 오름차순=true 증가=true(100→200) 머리=true(MSG-0301→MSG-0201) 꼬리유지=true(MSG-0400)
PASS  [게이트] 본문만: prepend 뒤 앵커 이동 0px
        앵커 밀림 0px (직전 y=-7257/top=7471/h=11045 → 가라앉은 뒤 y=-7257/top=18406/h=21980, 높이 +10935)
PASS  [결함재현] HIGH-1 첨부 hydrate 착지 뒤에도 앵커 이동 0px
        앵커 밀림 0px (직전 y=-7257/top=7471/h=11045 → 가라앉은 뒤 y=-7257/top=22166/h=25739, 높이 +14694)
PASS  [게이트] 끝에 닿으면 대화의 시작
        컨트롤="대화의 시작입니다" 메시지=150 역방향 페이지 질의=2(기대 2: 100·50 — 50<PAGE면 더 묻지 않는다, M6)
PASS  [게이트] HIGH-2 검사 전제: 재개 훅이 증분 질의를 냈다
        디스패치 뒤 채널 질의 모양: ["asc/cap100/n0"]
PASS  [결함재현] HIGH-2 모바일 재개 뒤에도 불러온 기록 유지
        재개 전 260건 → 재개 후 260건 (기대: 유지)
게이트 4/4 통과 · 결함재현 0건 미해소
```

변이 실증(각각 별도 실행):
- **M4** → 게이트 1 red
- **M5** → 게이트 1 red (`오름차순=false 머리=false 꼬리유지=false`)
- **M2** → 게이트 2 red (1,047px) · HIGH-1 red (1,111px)
- **M10** → 게이트 2 red (1,889px) · HIGH-1 red (1,889px)
- **M9** 단독 → 전부 green (되맞춤 이중화 확인)

수정 전 커밋(`f932c62`)에서는 같은 픽스처로 HIGH-1 이 3,759px 밀림(프레임 단위: 높이 21,970→25,729 인데 `scrollTop` 은 10,752 고정), HIGH-2 가 260건 → 100건으로 관측됐다.

## 남은 한계 (이 하네스가 증명하지 못하는 것)

- 실 Supabase·RLS·실제 지연, 실기기 iOS WKWebView / Android WebView. `FAKE_PLATFORM=ios` 는 `isMobilePlatform` 만 켠 데스크톱 Chromium 이다.
- 이미지 첨부의 지연 레이아웃(가짜 스토리지에 `createSignedUrl` 이 없어 파일 칩만 렌더된다). 이미지가 붙은 기록은 별도 확인이 필요하다.
- WebKit 엔진, 다크 테마, 배율 축, 폰 폭 레이아웃(폰 폭에서는 채널을 따로 열어야 해 이 스크립트는 1280×800 으로 고정한다).
- 새 메시지 도착(append)과 prepend 가 같은 React 커밋에 배칭되는 좁은 경합.
- **M6** → 게이트 3 red (역방향 페이지 질의 3회)
- **M8** → 게이트 4·HIGH-2 red (260→100건)

알려진 한계(후속): HIGH-2 전제 게이트의 `asc/cap100` 모양은 10초 폴(`load(lastId)`)도 내므로 8초 창 안에 폴이 걸리면 재개 없이도 초록이 될 수 있다(본 검사 260→260은 여전히 재개 회귀를 잡는다). **M3**(중복 제거)는 ref 가드가 경로를 막아 못 잡는다.
