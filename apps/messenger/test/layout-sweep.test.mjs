// 레이아웃 점검 24건(LA-xx, 2026-10-01 유건 "버튼 위치 어긋나거나 레이아웃 깨진 부분") 회귀 방지.
// 행동 테스트: placeLabels(그래프 이름 겹침), scrollLeftToCenter(설정 탭 줄), 테마 토큰 대비(회사 에이전트 배지 글자).
// 나머지는 CSS 소스 단언이다 — 규칙이 지워지거나 순서가 바뀌는 것만 막고 실제 모양은 브라우저로 쟀다(PR 본문의 전후 px 표). 소스 문자열 단언은 변이에 초록일 수 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { placeLabels, graphLabelVisible } from '../src/graph-labels.mjs';
import { scrollLeftToCenter } from '../src/nav-scroll.mjs';
import { toastPlace, toastMaxWidth } from '../src/toast-place.mjs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const globals = readFileSync(new URL('../../../app/globals.css', import.meta.url), 'utf8');
// CSS를 {sel, body, at} 규칙 목록으로(중괄호 깊이) — 뒤 규칙이 앞 규칙을 다시 쓰는 회귀를 잡는 데 쓴다
function cssRules(text) {
  const out = []; const ctx = []; let depth = 0; let buf = '';
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      const head = buf.trim().replace(/\s+/g, ' '); buf = '';
      if (head.startsWith('@')) { ctx.push({ head, depth }); depth++; continue; }
      let d = 1; let j = i + 1; while (d > 0 && j < src.length) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; }
      out.push({ sel: head, body: src.slice(i + 1, j - 1), at: ctx.map((x) => x.head) }); i = j - 1;
    } else if (c === '}') { depth--; while (ctx.length && ctx.at(-1).depth >= depth) ctx.pop(); buf = ''; }
    else buf += c;
  }
  return out;
}
const rules = cssRules(css);
const declOf = (r, prop) => [...r.body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1].trim());
const at = (re) => { const m = css.match(re); assert.ok(m, `찾지 못함: ${re}`); return m.index; };

// ── 행동 ──────────────────────────────────────────────────────────────
test('LA-24 그래프: 이름 상자가 겹치면 우선순위 낮은 쪽만 거른다 — 호버·집중은 항상 그린다', () => {
  const box = (i, x, extra = {}) => ({ i, x, y: 100, w: 60, h: 16, pri: 1, z: 0, ...extra });
  assert.deepEqual([...placeLabels([box(0, 0), box(1, 100)])].sort(), [0, 1], '안 겹치면 전부');
  assert.deepEqual([...placeLabels([box(0, 0, { pri: 1 }), box(1, 30, { pri: 5 })])], [1], '겹치면 허브(연결 많은 쪽)가 남는다');
  assert.deepEqual([...placeLabels([box(0, 0, { z: 9 }), box(1, 30, { z: 2 })])], [1], '우선순위가 같으면 카메라에 가까운 쪽');
  assert.deepEqual([...placeLabels([box(0, 0, { pri: 9 }), box(1, 30, { pri: 0, force: true })])], [1], '호버·집중(force)이 먼저 자리를 잡고 나머지가 비킨다');
  assert.deepEqual([...placeLabels([box(0, 0, { force: true }), box(1, 30, { force: true })])].sort(), [0, 1], 'force끼리는 겹쳐도 둘 다 그린다');
  assert.deepEqual([...placeLabels([box(0, 0), box(1, 61)], 2)], [0], '간격(pad) 안으로 붙으면 겹친 것으로 본다');
  assert.equal(placeLabels([]).size, 0);
});

test('LA-24 그래프: 점 11개 중 이름은 전부 후보지만(graphLabelVisible), 같은 자리의 둘은 하나만 남는다', () => {
  const vis = graphLabelVisible({ i: 3, hover: -1, focus: -1, hoverNeighbor: false, near: null, deg: 1, n: 11 });
  assert.equal(vis, true);
  const both = placeLabels([{ i: 0, x: 968, y: 460, w: 70, h: 16, pri: 2, z: 1 }, { i: 1, x: 968, y: 460, w: 70, h: 16, pri: 1, z: 1 }]);
  assert.deepEqual([...both], [0]);
});

test('LA-11 설정 탭 줄: 활성 탭을 줄 가운데로, 0..끝으로 자른다 · 안 넘치면 그대로', () => {
  // 영어 360px 실측: 줄 20→330(310), 전체 472, 활성 '내 계정' 397→491 → 가운데로 오면 줄 끝(162)까지
  assert.equal(scrollLeftToCenter({ navLeft: 20, navWidth: 310, btnLeft: 397, btnWidth: 94, scrollLeft: 0, scrollWidth: 472 }), 162);
  assert.equal(scrollLeftToCenter({ navLeft: 20, navWidth: 310, btnLeft: 30, btnWidth: 60, scrollLeft: 100, scrollWidth: 472 }), 0, '왼쪽 끝 아래로는 안 간다');
  assert.equal(scrollLeftToCenter({ navLeft: 20, navWidth: 340, btnLeft: 294, btnWidth: 65, scrollLeft: 0, scrollWidth: 340 }), 0, '한국어 390 — 안 넘치면 그대로');
  assert.equal(scrollLeftToCenter({ navLeft: 20, navWidth: 310, btnLeft: 150, btnWidth: 80, scrollLeft: 40, scrollWidth: 472 }), 40 + (190 - 175), '이미 가운데 근처면 조금만');
});

test('LA-03 회사 에이전트 배지: 글자는 배경(--primary)과 짝인 --primary-fg — 모든 테마에서 짝의 대비 3:1 이상(9px 그림 기호 = 비텍스트 기준)', () => {
  assert.match(css, /\.msgr-av\.crew\.company \.star \{[^}]*background: var\(--primary\);[^}]*color: var\(--primary-fg\);/);
  assert.doesNotMatch(css, /\.msgr-av\.crew\.company \.star \{[^}]*[;{\s]color: var\(--mark\)/, 'graphite에서 --mark = --primary라 글자가 배경과 같은 색이 된다');
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (h) => { const n = parseInt(h.slice(1).length === 3 ? h.slice(1).replace(/./g, '$&$&') : h.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const blocks = [...globals.matchAll(/\{[^{}]*--primary:\s*(#[0-9a-fA-F]{3,6})\s*;[^{}]*--primary-fg:\s*(#[0-9a-fA-F]{3,6})\s*;[^{}]*\}/g)];
  assert.ok(blocks.length >= 6, `--primary/--primary-fg 짝이 있는 테마 블록: ${blocks.length}`);
  const weak = blocks.filter((m) => ratio(m[1], m[2]) < 3).map((m) => `${m[1]}/${m[2]}=${ratio(m[1], m[2]).toFixed(2)}`);
  assert.deepEqual(weak, [], '짝의 대비가 모자란 테마');
});

// ── CSS 소스 단언 ──────────────────────────────────────────────────────
test('LA-05 설정 본문 그리드는 열을 명시한다(minmax(0,1fr)) — 암시적 auto 트랙이면 카드가 버튼 줄 폭으로 고정돼 오른쪽 밖으로 잘린다', () => {
  assert.match(css, /\.msgr-setbody \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
});

test('LA-05 .msgr-setbody의 열 정의를 뒤 규칙이 다시 쓰지 않는다 — 쓰면 카드가 버튼 줄 폭으로 고정돼 오른쪽 밖으로 잘린다(HIGH)', () => {
  const hit = rules.filter((r) => r.sel.split(',').some((x) => /(^|\s)\.msgr-setbody$/.test(x.trim())));
  assert.ok(hit.length >= 2, '기본 규칙과 폰 규칙');
  for (const r of hit) for (const v of declOf(r, 'grid-template-columns')) assert.match(v, /^(minmax\(0, 1fr\)|1fr)$/, `${r.sel} 열 정의 ${v}`);
  assert.ok(hit.some((r) => !r.at.length && declOf(r, 'grid-template-columns').length), '미디어 밖 기본 규칙이 열을 정한다');
  const last = [...hit].reverse().find((r) => !r.at.length);
  assert.ok(declOf(last, 'grid-template-columns').length, '미디어 밖 마지막 규칙이 열을 안 정하면 그 규칙이 이긴다 해도 위 단언이 못 본다');
});

test('LA-05 데스크톱 721~900px: 설정 탭이 위 가로 줄로 올라간다 — 데스크톱 열 정의(200px) 뒤에 있어야 이긴다', () => {
  const base = at(/\.msgr-thread\.page \.msgr-settings\.tabs \{ max-width: 1240px; margin: 0; grid-template-columns: 200px minmax\(0, 1fr\)/);
  const narrow = at(/@media \(min-width: 721px\) and \(max-width: 900px\) \{\s*\n\s*\.msgr-thread\.page \.msgr-settings\.tabs \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.ok(narrow > base, '같은 명시도라 소스 순서가 승패를 가른다');
});

test('LA-06·23 입력창 받침과 안내 띠는 같은 열 변수(--col-l/--col-r)를 쓰고, 패널 옆으로 비키는 건 본문 732px 이상일 때만이다', () => {
  assert.match(css, /\.msgr-main \{ --col-l: calc\(max\(24px, \(100% - 720px\) \/ 2\) \+ var\(--sbw, 0px\)\); --col-r: var\(--col-l\); \}/);
  assert.match(css, /\.msgr-dock \{ padding: 14px var\(--col-r\) 16px var\(--col-l\);/);
  assert.match(css, /\.msgr-shell:not\(\.msgr-phone\) \.msgr-main > \.msgr-joinbar \{ width: auto; margin: 0 var\(--col-r\) var\(--msg-gap-sys\) var\(--col-l\);/); // 아래 여백은 간격 표(--msg-gap-sys, 2026-10-02)
  // 컨테이너 쿼리는 컨테이너 자신(.msgr-main)이 아니라 자손만 고친다 — 변수를 .msgr-main에 걸면 조용히 안 먹는다(실측)
  const at732 = css.match(/@container msgr-main \(min-width: 732px\) \{\s*\n\s*(\.msgr-shell:not\(\.msgr-phone\) \.msgr-main:has\([^{]*\)) > :is\(\.msgr-dock, \.msgr-joinbar\) \{ --col-l:/);
  assert.ok(at732, '732px 이상에서만 받침·띠의 열을 패널 왼쪽으로');
  assert.doesNotMatch(css, /^\.msgr-shell:not\(\.msgr-phone\) \.msgr-main:has\(> \.msgr-sheetwrap > \.msgr-crewsheet:not\(\.msgr-dmpeek\)\) > \.msgr-dock \{ padding-left/m, '732px 미만에서도 입력창을 패널 밑 280px로 줄이던 최상위 규칙이 되살아나면 안 된다');
});

test('LA-04 토스트 폭: left/right 0 + margin auto + max-content — left:50% + translateX(-50%)는 폭이 화면의 절반으로 접힌다. 뒤 규칙이 되살려도 잡는다', () => {
  const toast = rules.filter((r) => r.sel.split(',').some((x) => /(^|\s)\.msgr-toast(\.err)?$/.test(x.trim())));
  assert.ok(toast.length >= 2);
  const base = toast.find((r) => /position: fixed/.test(r.body));
  assert.match(base.body, /left: 0; right: 0; margin-inline: auto; width: max-content;/);
  for (const r of toast) {
    assert.deepEqual(declOf(r, 'left').filter((v) => /%/.test(v)), [], `${r.sel}의 left가 %면 shrink-to-fit 폭이 절반으로 접힌다`);
    assert.deepEqual(declOf(r, 'transform').filter((v) => /-50%/.test(v)), [], `${r.sel}의 translateX(-50%)`);
    assert.deepEqual(declOf(r, 'width').filter((v) => v !== 'max-content'), [], `${r.sel}의 width가 max-content가 아니다`);
  }
  assert.doesNotMatch(css.match(/@keyframes msgrToastIn \{[^\n]*\}/)?.[0] ?? '', /-50%/);
  const err = rules.find((r) => /\.msgr-toast\.err$/.test(r.sel)); // 오류 토스트: 붉은 기 바탕(다크에서 --card 바탕이 말풍선에 묻혔다) + 글자는 --fg 쪽으로 섞어 대비 유지
  assert.match(declOf(err, 'background')[0] ?? '', /color-mix\(in srgb, var\(--danger[^)]*\) \d+%, var\(--card\)\)/);
  assert.match(declOf(err, 'color')[0] ?? '', /color-mix\(in srgb, var\(--danger[^)]*\) \d+%, var\(--fg\)\)/);
  assert.match(app, /<button type="button" ref=\{toastRef\} className=\{`msgr-toast/, '셸 토스트는 자리를 직접 준다(toast-place.mjs)');
});

test('LA-04 토스트 자리 적용: 계산 결과를 style에 쓰는 줄·기준 요소·다시 재기·해제가 전부 App.jsx에 있다 — 한 줄만 지워도 실패', () => {
  const i = app.indexOf('const toastRef = useRef(null);'); assert.ok(i > 0);
  const block = app.slice(i, app.indexOf('}, [err, note]);', i));
  // 결과를 쓰는 자리: left·bottom이 계산값(p.left·p.bottom)이고 top은 auto
  assert.match(block, /Object\.assign\(el\.style, \{ left: `\$\{p\.left\}px`, right: 'auto', marginInline: '0', top: 'auto', bottom: `\$\{p\.bottom\}px` \}\)/);
  assert.match(block, /const p = toastPlace\(\{[^}]*boxW: el\.offsetWidth[^}]*anchorTop:[^}]*colLeft, colRight \}\)/);
  assert.match(block, /el\.style\.maxWidth = `\$\{toastMaxWidth\(\{ viewW, colLeft, colRight \}\)\}px`/);
  // 기준 요소: 탭 바·새 대화 단추·입력창 받침·맨 아래로·열린 팝업(멘션·슬래시·역할 = .msgr-pop, 이모지)
  const anchors = block.match(/boxes\('([^']*\.msgr-tabbar[^']*)'\)/)?.[1] ?? '';
  for (const sel of ['.msgr-tabbar', '.msgr-fab', '.msgr-dock', '.msgr-tobottom .btn', '.msgr-pop', '.msgr-emojipop']) assert.ok(anchors.split(',').map((x) => x.trim()).includes(sel), `기준 요소 ${sel}`);
  // 떠 있는 동안 다시 재기 + 닫히면 해제(누수 없게)
  assert.match(block, /place\(\);\s*\n/);
  for (const re of [/new ResizeObserver\(again\)/, /new MutationObserver\(again\)/, /addEventListener\('resize', again\)/, /vv\?\.addEventListener\('resize', again\)/, /ro\?\.disconnect\(\)/, /mo\?\.disconnect\(\)/, /removeEventListener\('resize', again\)/, /vv\?\.removeEventListener\('resize', again\)/, /cancelAnimationFrame\(raf\)/]) assert.match(block, re);
});

test('LA-04 토스트 자리: 아래쪽 받침(탭 바·새 대화 단추·입력창) 바로 위, 입력창 열 가운데 — 머리·제목·시트를 가리지 않는다', () => {
  // 폰 390x844: 새 대화 단추(FAB) 윗선 698, 화면 전체 열, 상자 358
  assert.deepEqual(toastPlace({ viewW: 390, viewH: 844, boxW: 358, anchorTop: 698, colLeft: 0, colRight: 390 }), { left: 16, bottom: 158 });
  // 폰 방: 입력창 받침 윗선 784 → 상자는 그 위 12px
  assert.equal(toastPlace({ viewW: 390, viewH: 844, boxW: 200, anchorTop: 784, colLeft: 0, colRight: 390 }).bottom, 72);
  // 데스크톱 1440: 입력창 열 502~1206 가운데, 받침 윗선 737
  assert.deepEqual(toastPlace({ viewW: 1440, viewH: 900, boxW: 407, anchorTop: 737, colLeft: 502, colRight: 1206 }), { left: 651, bottom: 175 });
  // 시트가 열려 입력창이 300~1004로 비키면 토스트도 같이 — 시트 쪽으로 가지 않는다
  assert.equal(toastPlace({ viewW: 1440, viewH: 900, boxW: 407, anchorTop: 737, colLeft: 300, colRight: 1004 }).left, 449);
  // 받침이 없는 화면(설정·알림함)은 바닥에서 12(최소 16) · 가장자리에서 16 안쪽
  assert.deepEqual(toastPlace({ viewW: 1440, viewH: 900, boxW: 300, anchorTop: 900, colLeft: 268, colRight: 1440 }), { left: 704, bottom: 16 });
  assert.equal(toastPlace({ viewW: 390, viewH: 844, boxW: 600, anchorTop: 844, colLeft: 0, colRight: 390 }).left, 16, '상자가 화면보다 커도 왼쪽 16에서 시작(max-width가 따로 줄인다)');
  assert.equal(toastPlace({ viewW: 390, viewH: 844, boxW: 200, anchorTop: 844, colLeft: 300, colRight: 400 }).left, 174, '열이 화면 밖으로 나가도 오른쪽 가장자리 16 안쪽에 둔다');
  // 상자 최대 폭: 시트가 열려 입력창 열이 300~588(288)로 좁아지면 그 안에서 줄바꿈(시트 620~ 쪽으로 안 나감) · 열이 넓으면 기존 상한 560
  assert.equal(toastMaxWidth({ viewW: 1024, colLeft: 300, colRight: 588 }), 288);
  assert.equal(toastMaxWidth({ viewW: 1440, colLeft: 502, colRight: 1206 }), 560);
  assert.equal(toastMaxWidth({ viewW: 390, colLeft: 0, colRight: 390 }), 358, '폰: 화면 − 32');
  assert.equal(toastMaxWidth({ viewW: 800, colLeft: 300, colRight: 400 }), 240, '하한 240');
});

test('LA-09 조직 메뉴 항목 규칙은 .btn에 걸지 않는다 — 안의 폼 버튼 배경·테두리가 지워진다', () => {
  assert.match(css, /\.msgr-menu-pop button:not\(\.btn\) \{ display: flex;/);
  assert.match(css, /\.msgr-phone\.phone-home \.msgr-side \.msgr-menu-pop button:not\(\.btn\) \{/);
});

test('LA-08·12 전역 .row 패딩 누수: 메신저 전체에서 되돌린다(.argo-messenger .row) — 부모별 규칙보다 앞에 있어 부모 규칙이 이긴다', () => {
  const reset = at(/\.argo-messenger \.row \{ padding: 0; border-top: 0; width: auto; text-align: inherit; \}/);
  assert.ok(reset < at(/\.msgr-setcard \.row \{ display: flex;/));
  assert.ok(reset < at(/\.msgr-rows \.row \{ display: flex;/));
  assert.match(css, /\.msgr-server-body \{ display: grid; gap: 10px;/, 'details 슬롯 안은 grid·gap이 안 닿는다 — 간격은 내용 상자가 준다');
  assert.match(app, /<div className="msgr-server-body">/);
});

test('LA-01 폰 홈 목록 아래 여백은 탭 바 + FAB를 넘는다 · FAB는 탭 바(70)보다 위·스크림(72)보다 아래', () => {
  assert.match(css, /\.msgr-phone\.phone-home \.msgr-railbody \{[^}]*padding: 12px 0 calc\(var\(--ph-tab\) \+ 14px \+ 56px \+ 16px /);
  // 같은 선택자(마지막 클래스가 .msgr-tabbar / .msgr-fab)의 모든 규칙을 본다 — 뒤 규칙이 z를 바꿔도 잡힌다
  const zs = (cls) => rules.filter((r) => r.sel.split(',').some((x) => new RegExp(`(^|\\s)\\.${cls}$`).test(x.trim()))).flatMap((r) => declOf(r, 'z-index').map(Number));
  const scrimZs = rules.filter((r) => /\.msgr-scrim\.clear$/.test(r.sel.split(',')[0].trim()) && /phone-home/.test(r.sel)).flatMap((r) => declOf(r, 'z-index').map(Number));
  const fab = zs('msgr-fab'); const tabbar = zs('msgr-tabbar');
  assert.ok(fab.length >= 1 && tabbar.length >= 1 && scrimZs.length >= 1);
  assert.ok(Math.min(...fab) > Math.max(...tabbar) && Math.max(...fab) < Math.min(...scrimZs), `FAB ${fab} 탭 바 ${tabbar} 스크림 ${scrimZs} — FAB가 DOM에서 탭 바보다 앞이라 동률(70)이면 탭 바 ::before 그라데이션이 + 아래 반을 덮는다`);
});

test('LA-02 폰 하위 페이지 머리: 오른쪽 단추 칸이 단추 폭만큼 늘고, 제목은 단추와 같은 중심선', () => {
  assert.match(css, /\.msgr-phone \.msgr-top:has\(\.msgr-backchat\) \{ grid-template-columns: minmax\(max-content, 1fr\) minmax\(0, auto\) minmax\(max-content, 1fr\);/);
  assert.match(css, /\.msgr-phone \.msgr-main \.msgr-top:has\(\.msgr-backchat\) \.title \{ align-self: center; padding-top: 0; \}/);
});

test('LA-13 폰 봇 행: 상태가 이름 아래 줄로 전부 보이고 단추는 이름 열에서 시작', () => {
  assert.match(css, /\.msgr-phone \.msgr-botrow \.row \.main \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\);/);
  assert.match(css, /\.msgr-phone \.msgr-botrow \.row \.main \.sub \{ grid-column: 2; white-space: normal;/);
  assert.match(css, /\.msgr-phone \.msgr-botrow \.row \.main \+ \.btn \{ margin-left: 20px; \}/);
});

test('LA-17 폰 입력창 위 카드·띠는 알약과 같은 좌우 여백', () => {
  assert.match(css, /\.msgr-phone \.msgr-main \.msgr-dock :is\(\.msgr-delivery, \.msgr-dm-delivery-warning, \.msgr-replychip, \.msgr-outsidechip\) \{ margin-inline: var\(--ph-pad\); \}/);
  assert.match(css, /\.msgr-phone \.msgr-main > \.msgr-joinbar \{ width: auto; margin: 0 var\(--ph-pad\) var\(--msg-gap-sys\); \}/); // 좌우는 알약과 같은 --ph-pad, 아래는 간격 표
});

test('LA-18·19 레일: 찾아보기 행(높이 36·말줄임·오른쪽 정렬)과 파견 해제 행의 "대기"는 오른쪽 열', () => {
  assert.match(css, /\.msgr-shell:not\(\.msgr-phone\) \.msgr-browse \.row \{ display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 10px;/);
  assert.match(css, /\.msgr-shell:not\(\.msgr-phone\) \.msgr-browse \.row \.name \{[^}]*white-space: nowrap;/);
  assert.match(css, /\.msgr-railrow\.dim \.item \.msgr-klabel \{ position: absolute; right: 0;/);
});

test('LA-21·07 데스크톱 머리: 모든 화면이 높이 63 이상 · 제목 줄은 탭 줄(36)과 같은 높이', () => {
  assert.match(css, /\.msgr-shell:not\(\.msgr-phone\) \.msgr-main > \.msgr-top \{ box-sizing: border-box; min-height: 63px; \}/);
  assert.match(css, /\.msgr-shell:not\(\.msgr-phone\) \.msgr-main > \.msgr-top \.title \{ min-height: 36px; \}/);
});

test('#801 재검수: 전역 .row 되돌림의 의도 밖 변화 — 활동 기록 \'더 보기\'는 윗간격 8px', () => {
  assert.match(css, /\.argo-messenger \.row\.act-more \{ margin-top: 8px; \}/);
  assert.match(app, /className="row act-more"><button type="button" className="btn sm" onClick=\{\(\) => setLimits/);
});

test('LA-22 개인 공간 레일 푸터는 기억 자리를 비워 둔다(아이콘이 공간마다 움직이지 않게)', () => {
  assert.match(app, /org && isPersonal && !orgBlocked && !isPhone && <span className="btn ghost msgr-foot-slot" aria-hidden="true" \/>/);
  assert.match(css, /\.msgr-foot \.msgr-foot-slot \{ visibility: hidden;/);
});

test('LA-25·26 서버 연결 줄: 원격 추가 줄은 줄 전체 폭, 코드 줄은 한 줄(복사·다시 만들기·취소·만료)·세로 가운데', () => {
  assert.match(css, /\.msgr-remote-add \{ display: flex; flex: 1 1 100%;/);
  assert.match(css, /\.msgr-node-cmd \.acts \{ display: flex; gap: 6px; align-items: center; flex-wrap: wrap; \}/);
  assert.doesNotMatch(app, /\{nodeInvite && <div className="acts"><button type="button" className="btn sm ghost" disabled=\{busy\} onClick=\{makeNodeInvite\}>/, '둘째 줄 acts를 되살리면 자리가 남아도 아래로 내려간다');
});

test('LA-27 폰 하단 시트: 좌우만 다른 시트와 같은 선(--ph-pad), 바닥은 0 — 아래 안전 영역은 시트 안쪽 패딩 한 곳에서만 더한다', () => {
  assert.match(css, /\.msgr-dmpeek \{ top: auto; bottom: 0; left: var\(--ph-pad\); right: var\(--ph-pad\); width: auto;[^}]*border-radius: 20px 20px 0 0;/);
  assert.match(css, /\.msgr-dmpeek \.peek \{ overflow-y: auto; padding: 8px 16px calc\(env\(safe-area-inset-bottom\) \+ 12px\);/);
  assert.match(css, /\.msgr-dmgroup \.foot \{ padding: 10px 16px calc\(env\(safe-area-inset-bottom\) \+ 12px\);/);
  // 바닥을 안전 영역만큼 띄우면(bottom: …safe-area…) 안쪽 패딩과 두 번 더해진다 — 노치 기기에서 버튼이 63 → 97px 떴다
  const peek = rules.filter((r) => /(^|,\s*)(\.msgr-phone \.msgr-sheetwrap \.msgr-crewsheet)?\.msgr-dmpeek\b/.test(r.sel) && !/\.(peek|head|pk|foot)\b/.test(r.sel));
  for (const r of peek) for (const b of declOf(r, 'bottom')) assert.doesNotMatch(b, /safe-area/, `${r.sel.slice(0, 50)} bottom: ${b}`);
});

test('LA-29 멈춘 봇 행: 글자 대비는 지키고(--fg-2 그대로) 기울임·흐린 아바타·빈 점·테두리 라벨로 구분', () => {
  assert.match(css, /\.msgr-railrow\.paused \.name \{ font-style: italic; \}/);
  assert.doesNotMatch(css, /\.msgr-railrow\.paused \.name \{ color: var\(--fg-3\)/, '--fg-3 글자는 graphite 라이트 레일에서 4.16:1(기준 미달)');
  assert.match(css, /\.msgr-railrow\.paused \.msgr-av \{ opacity: \.42; filter: grayscale\(1\); \}/);
  assert.match(css, /\.msgr-railrow\.paused \.msgr-relink \{ color: var\(--fg\);[^}]*border: 1px solid var\(--border\);/);
});
