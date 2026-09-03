// 폰 셸 페이지 맞춤(2026-09-03 유건 제보: 크루·회의실·활동 탭 미최적화) — 데스크톱 무간섭 계약을 잠근다.
//  ① 폰 전용 JSX(레일 시트·시트 여는 버튼)는 usePhoneShell() 값 아래에서만 렌더 — Shell Provider가 /api/me mobile을 내린다.
//  ② 레일 JSX는 한 벌(rail 변수) — 데스크톱은 그 벌을 종전 자리에 그대로 렌더(시트 갈래는 phone ? … : rail).
//  ③ 활동 2열 산식은 인라인이 아니라 .activity-cols(globals) — 폰 블록이 1열로 뒤집을 수 있어야 한다.
//  ④ 폰 블록의 .chat-cols는 하단 탭 높이(58)를 뺀 산식 — 컴포저가 탭 아래 가려지던 결함의 게이트.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('Provider — Shell이 mobile 값을 PhoneShellCtx로 내리고, ui.jsx가 훅을 정의', async () => {
  const ui = await src('../app/ui.jsx');
  assert.match(ui, /export const PhoneShellCtx = createContext\(false\);/);
  assert.match(ui, /export const usePhoneShell = \(\) => useContext\(PhoneShellCtx\);/);
  const lay = await src('../app/c/[ws]/layout.jsx');
  assert.match(lay, /<PhoneShellCtx\.Provider value=\{mobile\}>\n\s*<div className="shell">/);
  assert.equal((lay.match(/PhoneShellCtx\.Provider/g) || []).length, 2, '여는·닫는 태그 각 1');
});

for (const [name, path, cond] of [
  ['크루 대화', '../app/c/[ws]/crew/[slug]/page.jsx', /\{!embedded && \(phone \? \(railOpen && \(<>\n\s*<div className="phone-sheet-backdrop"[^\n]*\n\s*<div className="phone-sheet rail-sheet"[^\n]*\{rail\}<\/div>\n\s*<\/>\)\) : rail\)\}/],
  ['회의실', '../app/c/[ws]/room/page.jsx', /\{phone \? \(railOpen && \(<>\n\s*<div className="phone-sheet-backdrop"[^\n]*\n\s*<div className="phone-sheet rail-sheet"[^\n]*\{rail\}<\/div>\n\s*<\/>\)\) : rail\}/],
]) {
  test(`${name} — 레일 한 벌(rail), 시트는 phone 갈래에만, 시트 버튼은 phone && 아래`, async () => {
    const s = await src(path);
    assert.match(s, /const phone = usePhoneShell\(\);/);
    assert.match(s, /const \[railOpen, setRailOpen\] = useState\(false\);/);
    assert.match(s, /const rail = (?:embedded \? null : )?\([^\n]*\n\s*<div className="side-rail"/, '레일 JSX는 rail 변수 한 벌(크루는 embedded면 null)');
    assert.equal((s.match(/className="side-rail"/g) || []).length, 1, 'side-rail 마크업 중복 없음(두 벌이면 한쪽만 고쳐진다)');
    assert.match(s, cond, '시트 갈래 형태 고정');
    assert.equal((s.match(/phone-sheet/g) || []).length, 2, 'phone-sheet 참조는 시트 갈래의 2건뿐');
    // 시트 여는 버튼 — phone && 로만
    const btn = s.match(/\{phone && <button[^\n]*setRailOpen\(true\)[^\n]*<\/button>\}/g) || [];
    assert.equal(btn.length, 1, '시트 버튼 1곳, phone && 게이트');
    assert.equal((s.match(/setRailOpen\(true\)/g) || []).length, 1);
  });
}

test('크루 대화 — 컴포저 autoFocus 속성 없음(SSR autofocus = 사파리 파싱 시점 포커스·확대), 마운트 효과로 대체', async () => {
  const s = await src('../app/c/[ws]/crew/[slug]/page.jsx');
  const form = s.slice(s.indexOf('<form onSubmit={send} className="input-bar"'), s.indexOf('</form>', s.indexOf('<form onSubmit={send} className="input-bar"')));
  assert.ok(!/autoFocus/.test(form), '컴포저 폼 안에 autoFocus 없음');
  assert.match(s, /useEffect\(\(\) => \{ if \(!viewing && !isPhoneShell\(\)\) inputRef\.current\?\.focus\(\); \}, \[viewing\]\);/);
  const ui = await src('../app/ui.jsx');
  assert.match(ui, /dataset\.shell === 'mobile' \|\| phoneHint\(\)/, 'isPhoneShell = 마커 또는 localStorage 힌트');
  const lay = await src('../app/c/[ws]/layout.jsx');
  const eff = lay.slice(lay.indexOf('useEffect(() => {\n    if (!mobile) return;'), lay.indexOf('}, [mobile]);'));
  assert.match(eff, /try \{ localStorage\.setItem\('argo-phone', '1'\); \}/, '힌트 쓰기는 mobile 게이트 effect 안(문 전체 앵커 — 주석은 fail-open)');
  assert.match(eff, /vp\.content \+= ', viewport-fit=cover';/);
  assert.ok(!/maximum-scale/.test(lay.replace(/\/\/[^\n]*/g, '')), 'maximum-scale 금지 — Android는 손가락 확대까지 막힌다(코드 기준, 주석 제외)');
  const css = await src('../app/globals.css');
  assert.match(css, /^\[data-shell="mobile"\] \.input-bar textarea, \[data-shell="mobile"\] \.input-bar input \{ font-size: 16px; \}$/m, 'iOS 포커스 확대 트리거(16px 미만) 제거는 폰 블록 16px');
});

test('활동 — 2열 산식은 .activity-cols(globals), 인라인 316px 없음', async () => {
  const s = await src('../app/c/[ws]/activity/page.jsx');
  assert.match(s, /<div className="activity-cols" style=\{\{ display: 'grid', gap: 14, alignItems: 'start' \}\}>/);
  assert.ok(!/gridTemplateColumns: 'minmax\(0, 1fr\) 316px'/.test(s), '인라인 2열이면 폰 블록이 못 이긴다');
  const css = await src('../app/globals.css');
  assert.match(css, /^\.activity-cols \{ grid-template-columns: minmax\(0, 1fr\) 316px; \}$/m, '데스크톱 값 동일 이관');
  assert.match(css, /^\[data-shell="mobile"\] \.activity-cols \{ grid-template-columns: minmax\(0, 1fr\); \}$/m);
});

test('폰 블록 .chat-cols — 하단 탭(59)+safe-area를 뺀 높이, 열·행 하나는 in-flow 레일 없는 그리드만, 레일 시트 상한, 밴드 마커 전환', async () => {
  const css = await src('../app/globals.css');
  const block = css.slice(css.indexOf('/* ── 휴대폰 셸 — data-shell="mobile"'));
  const m = block.match(/^\[data-shell="mobile"\] \.chat-cols \{ ([^}]*)\}$/m);
  assert.ok(m, '폰 블록 .chat-cols 규칙');
  assert.ok(!/grid-template/.test(m[1]), '.chat-cols 공용 규칙에 열·행 없음 — 경쟁(in-flow 레일)이 같이 탄다(검수 H-2)');
  assert.match(block, /^\[data-shell="mobile"\] \.chat-cols:not\(:has\(> \.side-rail\)\) \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: minmax\(0, 1fr\); \}$/m);
  assert.match(m[1], /height: calc\(100dvh \/ var\(--z, 1\) - 141px - env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(m[1], /margin-bottom: -28px;/);
  // 탭 높이 산식의 원천(.phone-tab min-height 48 + 패딩 4+6 + 위 테두리 1 = 59) — 탭이 커지면 141·시트 bottom 59도 같이 바꿔야 한다
  assert.match(block, /\.phone-tab \{[^}]*min-height: 48px;/);
  assert.match(block, /\.phone-tabs \{[^}]*border-top: 1px solid[^}]*padding: 4px 4px calc\(6px \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.match(block, /\.phone-sheet \{[^}]*bottom: calc\(59px \+ env\(safe-area-inset-bottom, 0px\)\);/);
  // .content 상단 16·좌우 14 = ≤900 블록과 동일(폰 셸 × 넓은 폭에서 산식 16이 서야 body 스크롤 0 — 검수 M-4)
  assert.match(block, /^\[data-shell="mobile"\] \.content \{ padding: 16px 14px calc\(96px \+ env\(safe-area-inset-bottom, 0px\)\); \}$/m);
  // 밴드 마커 전환(검수 H-1) — ≤900 블록의 두 규칙과 같은 내용
  assert.match(block, /^\[data-shell="mobile"\] #argo-topbar-slot \{ display: none; \}$/m);
  assert.match(block, /^\[data-shell="mobile"\] \.crew-phone-band \{ display: flex; flex-wrap: wrap; \}$/m);
  assert.match(block, /^\[data-shell="mobile"\] \.rail-sheet \{ max-height: calc\(70vh \/ var\(--z, 1\)\); overflow-y: auto; \}$/m);
});
