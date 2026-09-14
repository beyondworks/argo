// PR #531 스크롤백 행동 검사 — ego-browser 로 실제 앱을 돌려 관측한다(소스 문자열 단언이 아니다).
//   ego-browser nodejs < scrollback.browser.mjs
// 실행 변수: SB_TEST_PORT(기본 5371) · SB_IOS_PORT(기본 5372, FAKE_PLATFORM=ios 로 띄운 서버) · SB_STRICT=1
//
// 검사는 두 종류다.
//   [게이트]  현재 코드에서 초록이어야 한다. M2·M3·M4·M5·M6 변이에서 빨강이 나오는지로 잠금을 실증한다.
//   [결함재현] 검수 시점(f932c62)에서 빨강이던 항목(HIGH-1·HIGH-2). 수정이 들어오면 초록이 된다.
// 종료코드: 게이트가 하나라도 실패하면 1. 결함재현 실패도 기본(strict)에서 1 — local.json에 strict:false면 0.
//
// 설계 메모(실측으로 얻은 것 — 고치기 전에 읽을 것)
//  · 한 페이지만 불러오려면 버튼 클릭을 쓴다. 휠로 맨 위까지 올리면 보정 뒤에도 상단에 남아 여러 페이지가 연달아 실려 측정이 섞인다.
//  · 버튼을 누르기 전에 바닥 고정(stick)을 먼저 푼다. 바닥에 붙은 채로는 위치 보정과 바닥 추종이 같은 값을 만들어 구분할 수 없다.
//    합성 wheel 이벤트로 '사용자 제스처' 표시를 세우고(앱은 isTrusted 를 보지 않는다) scrollTop 대입으로 진짜 scroll 이벤트를 낸다.
//  · CDP 입력(page.mouse.wheel)은 스레드가 무거우면 타임아웃으로 죽는다 — 측정 경로에서 뺐다.
//  · 페이지 안 requestAnimationFrame 로거는 탭이 뒤로 가면 스로틀돼 표본이 통째로 빈다 — 표본은 Node 쪽에서 뽑는다.

// 설정은 파일로 — ego-browser nodejs는 호출자의 환경 변수를 상속하지 않는다(실측: SB_STRICT·SB_TEST_PORT 전부 null, 검수 #531 3R LOW-2).
// 기본값을 바꾸려면 옆에 scrollback.local.json({ "port": 5371, "iosPort": 5372, "strict": true })을 둔다(gitignore).
const fs = await import('node:fs');
const CFG = { port: 5371, iosPort: 5372, strict: true, ...(() => { try { return JSON.parse(fs.readFileSync('/Users/yoogeon/lean-projects/saas/argo/apps/messenger/test/scrollback.local.json', 'utf8')); } catch { return {}; } })() };
const PORT = String(CFG.port), IOS_PORT = String(CFG.iosPort), STRICT = CFG.strict !== false;
const PAGE = 100;
const url = (port, qs) => `http://127.0.0.1:${port}/test/scrollback.fixture.html?${qs}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (kind, name, ok, detail) => {
  results.push({ kind, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${kind}] ${name}\n        ${detail}`);
};

const task = await taskSpace('argo msgr 스크롤백 행동 검사');
const page = task.page('p1');
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); // 기하 고정(폰 폭이면 채널이 안 열린다)
console.log(`taskSpace=${task.spaceId}  검사 서버 ${PORT} / iOS ${IOS_PORT}\n`);

// evaluate 가 DOM 노드를 돌려주면 직렬화가 터진다 — 항상 원시값·JSON 문자열로 끝낸다.
const ready = async (u) => {
  await page.goto(u);
  // .msgr-row 만 기다리면 스켈레톤(.ghost)에 걸린다 — 실제 메시지가 들어차고 높이가 잡힌 뒤여야 측정이 성립한다(실측: 높이 574px에서 시작해 전부 틀어짐).
  await page.waitForFunction('document.querySelectorAll(".msgr-thread .msgr-row:not(.ghost)").length > 5', undefined, { timeout: 25000 });
  await page.waitForFunction('(() => { const f = document.querySelector(".msgr-thread"); return f && f.scrollHeight > f.clientHeight * 2; })()', undefined, { timeout: 25000 });
  await sleep(700);
};
// 정규식은 여러 겹을 지나며 \d 가 깨진다 — [0-9] 로 쓴다.
const ids = async () => JSON.parse(await page.evaluate('JSON.stringify(((document.querySelector(".msgr-thread") || { innerText: "" }).innerText.match(/MSG-[0-9][0-9][0-9][0-9]/g) || []))'));
const ctrl = () => page.evaluate('String((document.querySelector(".msgr-older") || {}).innerText || "")');
const clickOlder = () => page.evaluate('(() => { const b = document.querySelector(".msgr-older button"); if (!b || b.disabled) return 0; b.click(); return 1; })()');

// 바닥 고정(stick) 해제 — 실제 휠 입력이어야 한다.
// 합성 WheelEvent 는 앱의 제스처 표시에 닿지 않는다(실증: 합성 휠 + scrollTop 대입 뒤 내용을 키우면 그대로 바닥으로 끌려갔다).
// 휠은 첫 페이지(가벼운 상태)에서만 쓰고, 실제 로드는 버튼으로 한다 — 무거워진 뒤 CDP 입력은 타임아웃으로 죽는다.
// 바닥에서 떨어뜨리는 건 프로그램 scrollTop으로 — L-4(loadOlder가 stick=false) 뒤로는 제스처 표시가 필요 없다.
// CDP 휠(page.mouse.wheel)은 6회 중 2회 타임아웃으로 이동 0·부분 이동이 나 게이트 2가 5회 중 2회 빨갰다(검수 #531 3R MEDIUM-1).
// 뒷탭에선 ResizeObserver 알림이 렌더 기회까지 밀려 있다가 배치 직후 한꺼번에 와, 아직 참인 초기 바닥 고정(제스처 없음)이 바닥으로 되돌린다(7회 중 1회 실측, 실사용의 휠 제스처엔 없는 경로).
// → 위치가 두 번 연속 유지될 때까지 다시 놓는다(최대 8회).
const placeAbove = async (gap = 1200) => {
  const readGap = () => page.evaluate('(() => { const f = document.querySelector(".msgr-thread"); return Math.round(f.scrollHeight - f.scrollTop - f.clientHeight); })()');
  let g = -1;
  for (let i = 0; i < 8; i++) {
    await page.evaluate(`(() => { const f = document.querySelector(".msgr-thread"); f.scrollTop = Math.max(0, f.scrollHeight - f.clientHeight - ${gap}); return 1; })()`);
    await sleep(350); const a = Number(await readGap()); await sleep(350); const b = Number(await readGap());
    g = b; if (Math.abs(a - gap) <= 5 && Math.abs(b - gap) <= 5) break;
  }
  return g;
};

// 한 메시지를 앵커로 삼아 화면상의 위치를 잰다.
const snap = async (anchorText) => JSON.parse(await page.evaluate(`
  (() => {
    const f = document.querySelector(".msgr-thread");
    if (!f) return JSON.stringify({ found: false, gone: true, y: null, top: 0, h: 0, rows: 0, gap: 0 });
    const a = [...f.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent === ${JSON.stringify(anchorText)})[0];
    return JSON.stringify({ found: !!a, gone: false, y: a ? Math.round(a.getBoundingClientRect().top) : null,
      top: Math.round(f.scrollTop), h: Math.round(f.scrollHeight), rows: f.querySelectorAll(".msgr-row").length,
      gap: Math.round(f.scrollHeight - f.scrollTop - f.clientHeight) });
  })()`));

// 높이·행수가 멈출 때까지 기다린다(첨부 hydrate 착지까지). 붙는 순간이 아니라 '가라앉은 뒤'를 재야 한다.
const settle = async (anchorText, { quietMs = 900, maxMs = 12000 } = {}) => {
  let last = null, quietFrom = Date.now(), t0 = Date.now();
  for (;;) {
    const s = await snap(anchorText);
    if (!last || last.h !== s.h || last.rows !== s.rows) { quietFrom = Date.now(); last = s; }
    if (Date.now() - quietFrom >= quietMs || Date.now() - t0 > maxMs) return s;
    await sleep(150);
  }
};

// ── 게이트 1: 이전 페이지는 오름차순으로 '앞에' 붙는다 (M3 중복·M4 역순·M5 아래붙임을 잡는다)
await ready(url(PORT, 'lang=ko&n=400&atts=0'));
{
  const before = await ids();
  const clicked = await clickOlder();
  await settle(before[0]);
  const after = await ids();
  const num = (s) => Number(s.slice(4));
  const asc = after.every((v, i) => i === 0 || num(after[i - 1]) < num(v));
  const grew = after.length === before.length + PAGE;
  const head = num(after[0]) === num(before[0]) - PAGE;
  const tail = after[after.length - 1] === before[before.length - 1];
  record('게이트', '이전 페이지는 오름차순으로 맨 앞에 붙는다', clicked === 1 && asc && grew && head && tail,
    `클릭=${clicked} 오름차순=${asc} 증가=${grew}(${before.length}→${after.length}) 머리=${head}(${before[0]}→${after[0]}) 꼬리유지=${tail}(${after[after.length - 1]})`);
}

// ── 게이트 2: 본문만 있는 기록은 붙인 뒤에도 화면 위치가 그대로다 (M2 보정 제거를 잡는다)
// ── 결함재현 1(HIGH-1): 첨부가 뒤늦게(hydrate) 도착해도 위치가 그대로여야 한다
for (const [kind, name, qs, lag] of [
  ['게이트', '본문만: prepend 뒤 앵커 이동 0px', 'lang=ko&n=400&atts=0', 0],
  ['결함재현', 'HIGH-1 첨부 hydrate 착지 뒤에도 앵커 이동 0px', 'lang=ko&n=260&atts=160&lag=150', 150], // 첨부는 옛 160건에만 — 첫 페이지는 가볍고, 붙는 페이지가 무겁다
]) {
  await ready(url(PORT, qs));
  if (lag) await page.evaluate(`Object.assign(window.__sbLag, { msgr_attachments: ${lag}, msgr_reactions: ${lag} }), 1`); // 메시지 질의 지연은 보존
  const anchor = (await ids())[0]; // 첫 페이지의 가장 오래된 메시지 — 붙는 지점 바로 아래
  const gapAfterRelease = await placeAbove(1200);
  await sleep(400);
  const pre = await snap(anchor);
  const clicked = await clickOlder();
  const post = await settle(anchor);
  // 사이에 사용자 스크롤이 없으므로(버튼 클릭뿐) 판정은 단순하다: 앵커의 화면상 위치가 그대로여야 한다.
  // scrollTop 변화는 보정의 결과이지 오차가 아니다 — 여기서 빼면 이중 계산이 된다(초기 산식의 실수).
  const drift = Math.abs(post.y - pre.y);
  const ok = pre.found && clicked === 1 && post.rows > pre.rows && post.gap > 40;
  record(kind, name, ok && drift <= 2,
    ok ? `앵커 밀림 ${drift}px (직전 y=${pre.y}/top=${pre.top}/h=${pre.h} → 가라앉은 뒤 y=${post.y}/top=${post.top}/h=${post.h}, 높이 +${post.h - pre.h})`
      : `측정 불가(앵커=${pre.found} 클릭=${clicked} 행 ${pre.rows}→${post.rows} 해제후gap=${gapAfterRelease} 최종gap=${post.gap})`);
}

// ── 게이트 3: 끝에 닿으면 '대화의 시작' (M6 hasMore 항상 참을 잡는다)
await ready(url(PORT, 'lang=ko&n=150&atts=0'));
{
  for (let i = 0; i < 4; i++) { if (!(await clickOlder())) break; await settle('MSG-0001', { quietMs: 500, maxMs: 5000 }); }
  const text = await ctrl();
  const n = (await ids()).length;
  const pages = Number(await page.evaluate('String(window.__sbCalls.filter((c) => c.table === "msgr_messages" && c.cap === 100 && c.sort && c.sort.asc === false).length)')); // 역방향 페이지 질의(첫 로드 포함)
  record('게이트', '끝에 닿으면 대화의 시작', text.includes('대화의 시작') && n === 150 && pages === 2, `컨트롤="${text}" 메시지=${n} 역방향 페이지 질의=${pages}(기대 2: 100·50 — 50<PAGE면 더 묻지 않는다, M6)`);
}

// ── 결함재현 2(HIGH-2): 모바일 재개가 불러온 기록을 지우지 않는다
try {
  await ready(url(IOS_PORT, 'lang=ko&n=260&atts=0'));
  for (let i = 0; i < 2; i++) { await clickOlder(); await settle('MSG-0001', { quietMs: 500, maxMs: 5000 }); }
  const before = (await ids()).length;
  // 뒷탭이면 visibilityState='hidden' → observeMobileResume.available()이 거짓이라 재개가 아예 안 돈다(M8 변이가 초록으로 새던 원인, 2026-09-14 실측). 보이는 상태로 고정한다.
  await page.evaluate('Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }), 1');
  const mark = Number(await page.evaluate('String(window.__sbCalls.length)'));
  await page.evaluate('window.dispatchEvent(new Event("online")), 1'); // observeMobileResume: 포그라운드 복귀·망 재연결과 같은 경로
  // 재개 로드의 고유 모양 = 증분(gt·오름차순·cap100). 레일 미리보기(cap40)·검색(cap200) 같은 다른 소비자의 질의는 세지 않는다(실측: 합계 13회 중 채널 몫은 3회).
  // 재개 debounce 150ms와 픽스처 지연은 뒷탭 스로틀에서 1초 단위로 늦춰진다 → 고정 대기 대신 찍힐 때까지(최대 8초) 기다린다.
  const shapes = () => page.evaluate(`JSON.stringify(window.__sbCalls.slice(${mark}).filter((c) => c.table === "msgr_messages").map((c) => (c.sort ? (c.sort.asc ? "asc" : "desc") : "-") + "/cap" + c.cap + "/n" + c.n))`);
  let resumed = 0; for (let t0 = Date.now(); Date.now() - t0 < 8000 && !resumed; ) { resumed = JSON.parse(await shapes()).filter((k) => k.startsWith('asc/cap100')).length; if (!resumed) await sleep(150); }
  record('게이트', 'HIGH-2 검사 전제: 재개 훅이 증분 질의를 냈다', resumed >= 1, `디스패치 뒤 채널 질의 모양: ${await shapes()}`);
  await sleep(2000);
  const after = (await ids()).length;
  record('결함재현', 'HIGH-2 모바일 재개 뒤에도 불러온 기록 유지', before === after && before > PAGE,
    `재개 전 ${before}건 → 재개 후 ${after}건 (기대: 유지)`);
} catch (e) {
  record('결함재현', 'HIGH-2 모바일 재개 뒤에도 불러온 기록 유지', false,
    `iOS 서버(${IOS_PORT}) 미실행 — FAKE_PLATFORM=ios 로 띄우세요: ${e.message}`);
}

try { await page.cdp('Emulation.clearDeviceMetricsOverride', {}); } catch { /* 무시 */ }
try { await task.finish({ keep: false }); } catch { /* 세션 정리 실패는 결과에 영향 없음 */ }

const gates = results.filter((r) => r.kind === '게이트');
const gateFail = gates.filter((r) => !r.ok);
const defectFail = results.filter((r) => r.kind === '결함재현' && !r.ok);
console.log(`\n게이트 ${gates.length - gateFail.length}/${gates.length} 통과 · 결함재현 ${defectFail.length}건 미해소`);
if (defectFail.length && !STRICT) console.log('(strict:false — 결함재현 실패가 종료코드에 빠짐)');
process.exit(gateFail.length || (STRICT && defectFail.length) ? 1 : 0);
