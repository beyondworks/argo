// 폰 셸 무간섭 게이트(유건 지시 2026-09-03) — 폰 셸은 미디어쿼리가 아니라 data-shell="mobile" 마커로만 켜진다.
//  ① globals.css: 마커 블록 이후의 **모든** 셀렉터가 [data-shell="mobile"]로 시작(역방향 스캔 — 수집기 fail-closed),
//     마커 블록 밖에 [data-shell 참조 없음(한 블록 원칙), 신규 @media 없음(블록 안에 미디어쿼리 금지).
//  ② Shell(app/c/[ws]/layout.jsx): PhoneTabs 렌더·dataset.shell 쓰기가 전부 `mobile`(=/api/me mobile) 게이트 아래.
//  ③ /api/me: mobile 필드는 mobileAccess kind==='mobile'일 때만 실린다(스프레드 조건부) — 실호출은 E2E(scripts/e2e-mobile-pair.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const MARK = '/* ── 휴대폰 셸 — data-shell="mobile"';

test('globals.css — 폰 셸 규칙은 파일 끝 한 블록, 전 셀렉터가 [data-shell="mobile"] 접두', async () => {
  const css = await src('../app/globals.css');
  const at = css.indexOf(MARK);
  assert.ok(at > 0, '마커 블록 존재');
  assert.equal(css.indexOf('[data-shell'), css.indexOf('[data-shell', at), '마커 블록 밖에 data-shell 참조 없음');
  const block = css.slice(css.indexOf('*/', at) + 2);
  assert.ok(!/@media|@container/.test(block), '블록 안에 미디어·컨테이너 쿼리 없음(마커 외 발화 조건 금지)');
  // 역방향 스캔: 주석 제거 후 `{`마다 그 앞 셀렉터 목록을 취해 콤마 분리 각 항목이 접두를 갖는지
  const body = block.replace(/\/\*[\s\S]*?\*\//g, '');
  let n = 0;
  for (const m of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const sel of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      n++;
      assert.ok(sel.startsWith('[data-shell="mobile"]'), `접두 누락: ${sel}`);
    }
  }
  assert.ok(n >= 15, `규칙 수 ${n} — 블록이 통째로 비면 게이트가 무의미`);
  // 사이드바 숨김·하단 탭·결재 최상단 — 폰 셸의 핵심 3규칙 실존
  assert.match(body, /\[data-shell="mobile"\] \.side \{ display: none; \}/);
  assert.match(body, /\[data-shell="mobile"\] \.phone-tabs \{ position: fixed;/);
  assert.match(body, /\[data-shell="mobile"\] \.deck-approvals \{ order: -1; \}/);
});

test('Shell — PhoneTabs 렌더·dataset.shell 쓰기는 mobile 플래그 아래에만', async () => {
  const s = await src('../app/c/[ws]/layout.jsx');
  assert.match(s, /const mobile = !!me\?\.mobile;/);
  assert.match(s, /\{mobile && <PhoneTabs /, 'PhoneTabs는 mobile && 로만 렌더');
  assert.equal((s.match(/<PhoneTabs /g) || []).length, 1, 'PhoneTabs 호출 1곳');
  const eff = s.slice(s.indexOf('useEffect(() => {\n    if (!mobile) return;'), s.indexOf('}, [mobile]);'));
  assert.ok(eff.includes("d.dataset.shell = 'mobile'") && eff.includes('viewport-fit=cover'), '마커·viewport-fit 쓰기는 mobile 게이트 effect 안');
  assert.equal((s.match(/dataset\.shell/g) || []).length, 2, 'dataset.shell 접근 2회(설정+해제)뿐');
  assert.ok(!/matchMedia\([^)]*max-width[^)]*\)[^;]*shell/.test(s), '미디어쿼리로 셸을 켜지 않는다');
});

test('/api/me — mobile 필드는 판정 참일 때만 스프레드', async () => {
  const s = await src('../app/api/me/route.js');
  assert.match(s, /\.\.\.\(mobile \? \{ mobile: true \} : \{\}\)/);
  assert.match(s, /mobileAccess\(\{ host: req\.headers\.get\('host'\), cookieHeader: req\.headers\.get\('cookie'\) \}\)\)\.kind === 'mobile'/);
});

// ── 검수(2026-09-03) 미탐 4종 봉합 — "폰 셸을 폭으로 켜는 다른 경로"를 잠근다 ──
test('사각 봉합 — CSS 파일은 globals.css 하나, 좁은 폭 브레이크포인트 집합 고정, data-shell 쓰기는 Shell 한 곳, 사이드바 태그 무인라인', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const APP = fileURLToPath(new URL('../app', import.meta.url));
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = walk(APP);
  assert.deepEqual(files.filter((f) => f.endsWith('.css')).map((f) => f.slice(APP.length + 1)), ['globals.css'], '새 CSS 파일 = 이 게이트 밖 — 추가하려면 여기서 의도 확인');
  const css = await src('../app/globals.css');
  const bps = [...css.matchAll(/@media \(max-width:\s*(\d+)px\)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  assert.deepEqual([...new Set(bps)], [560, 899, 900, 1100], '좁은 폭 브레이크포인트 집합 고정 — 폰 셸을 미디어쿼리로 켜는 새 규칙은 red');
  const { stripComments } = await import('./helpers/strip-comments.mjs'); // 주석 속 "data-shell" 언급은 쓰기가 아니다(문자열 보존 스트리퍼)
  const jsx = files.filter((f) => /\.(jsx|js|mjs)$/.test(f));
  let writers = [];
  for (const f of jsx) {
    const t = stripComments(await readFile(f, 'utf8'));
    if (/dataset\.shell\s*=(?!=)|setAttribute\(\s*['"]data-shell['"]|<[a-zA-Z][^>]*\sdata-shell=/.test(t)) writers.push(f.slice(APP.length + 1));
  }
  assert.deepEqual(writers, ['c/[ws]/layout.jsx'], 'data-shell 마커 쓰기(dataset·setAttribute·JSX 속성)는 Shell 한 곳');
  const layout = stripComments(await src('../app/c/[ws]/layout.jsx'));
  assert.ok(layout.includes('<aside className="side">'), '사이드바 여는 태그는 인라인 style 없이 그대로(폭 조건 인라인 숨김 차단)');
  // 같은 파일 안의 두 번째 쓰기도 잡는다(검수 M3 변이: 폭 조건 setAttribute) — 허용 형태 2개, 각 1회, setAttribute 0회
  assert.equal((layout.match(/dataset\.shell\s*=(?!=)/g) || []).length, 1, "dataset.shell 쓰기는 `d.dataset.shell = 'mobile'` 1회");
  assert.equal((layout.match(/delete d\.dataset\.shell/g) || []).length, 1, '해제 1회');
  assert.equal((layout.match(/setAttribute\(\s*['"]data-shell['"]/g) || []).length, 0, 'setAttribute 형태 금지');
  assert.ok(!/innerWidth\s*[<>]/.test(layout), 'layout.jsx 어디에도 폭 비교로 셸을 바꾸는 코드 없음(폭 판정은 split-alive.mjs 한 곳)');
});
