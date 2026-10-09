// H21 — 본체 폰 폭(390)에서 깨지던 세 화면의 CI 잠금. 10/6 실제 계정 점검에서 찾고 10/9 격리 dev 서버에서 다시 본 것:
//  쪽지함 표가 카드 안에서 가로 스크롤(시간·버튼이 카드 밖) / 회의실 입력 안내 둘째 줄 잘림·폴더 줄에서 폴더 이름 잘림 /
//  기억 그래프 라벨이 실제 글자 폭 없이 판정돼 겹치고 캔버스 밖으로 잘림(880·1280에서도 재현).
// 실제 레이아웃 측정(scrollWidth·라벨 상자 겹침)은 body-390.browser.mjs가 격리 서버에서 한다(실행법은 그 파일 머리).
// 여기서는 브라우저 없이 도는 것만 잠근다:
//  ① 라벨 배치 순수 함수(graph2d-labels.mjs) — 실제 폭으로 겹침 0·캔버스 밖 0, 옛 판정보다 라벨을 늘리지 않는다(데스크톱 불변)
//  ② 판정 함수(verify*) — 고치기 전 실측값은 실패, 고친 뒤 실측값은 통과로 가른다
//  ③ 폴더 줄(WorkFolderRow) — mini-react로 실제 렌더해 폴더 이름이 줄지 않는 칸으로 따로 그려지는지
//  ④ 쪽지함 — 표 칸에 인라인 width가 없다(인라인은 모듈 CSS를 이겨 좁은 폭 카드 행에서도 칸이 150px로 버틴다)
//  ⑤ 회의실 짧은 안내 — ko·en 둘 다, 긴 안내보다 짧다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { placeLabels, hubLabelCount, LABEL_X_MIN } from '../app/c/[ws]/graph2d-labels.mjs';
import { verifyMail, verifyRoom, verifyGraph } from './body-390.browser.mjs';

const file = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(file(p), 'utf8');
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const lab = (i, x, y, w, extra = {}) => ({ i, x, y, gap: 10, w, h: 18, em: false, ...extra });

/* ── ① 라벨 배치 ─────────────────────────────────────────────── */

test('겹침은 실제 글자 폭으로 본다 — 시작점이 170px 넘게 떨어져도 앞 라벨 글자가 덮으면 뒤 라벨을 건너뛴다', () => {
  // 앞 라벨 110~410px(제목 28자 ≈ 300px), 뒤 라벨 시작 310px — 옛 판정(시작점 거리 200 ≥ 170)은 둘 다 그렸다(1280 실측 겹침과 같은 모양)
  const got = placeLabels([lab(0, 100, 100, 300), lab(1, 300, 100, 100)], { W: 750, H: 700 });
  assert.deepEqual(got.map((b) => b.i), [0]);
});

test('캔버스 오른쪽 끝을 넘으면 노드 왼쪽에 오른쪽 정렬로 놓고, 양쪽 다 안 들어가면 건너뛴다', () => {
  const [b] = placeLabels([lab(0, 300, 100, 150)], { W: 390, H: 420 });
  assert.equal(b.side, 'left', '오른쪽 310~460px은 390 캔버스 밖');
  assert.equal(b.x + b.w, 290, '왼쪽 상자의 오른쪽 끝 = 노드 중심 − 간격');
  assert.deepEqual(placeLabels([lab(0, 200, 100, 380)], { W: 390, H: 420 }), [], '380px 라벨은 390 캔버스 어느 쪽에도 안 들어간다');
  assert.deepEqual(placeLabels([lab(0, 100, 4, 80)], { W: 390, H: 420 }), [], '위쪽 끝을 넘는 라벨도 잘리므로 건너뛴다');
});

test('오른쪽 자리가 막혔다는 이유로는 왼쪽으로 옮기지 않는다 — 옛 판정이 안 그리던 라벨을 새로 그리지 않게', () => {
  const got = placeLabels([lab(0, 100, 100, 120), lab(1, 150, 100, 60)], { W: 750, H: 700 });
  assert.deepEqual(got.map((b) => b.i), [0], '1번의 왼쪽(80~140px)은 비어 있어도 쓰지 않는다');
  // 옛 판정이 건너뛰던 라벨(시작점 170px 안)은 오른쪽이 캔버스 밖이어도 왼쪽으로 살리지 않는다
  const edge = placeLabels([lab(0, 500, 100, 100), lab(1, 640, 100, 120)], { W: 750, H: 700 });
  assert.deepEqual(edge.map((b) => b.i), [0]);
});

test('그래프 위 칩 줄·안내 줄 자리(avoid)에는 라벨을 두지 않는다', () => {
  const avoid = [{ x: 180, y: 10, w: 200, h: 22 }];
  assert.deepEqual(placeLabels([lab(0, 200, 20, 80)], { W: 390, H: 420, avoid }), []);
  assert.equal(placeLabels([lab(0, 200, 60, 80)], { W: 390, H: 420, avoid }).length, 1, '칩 줄 아래는 그대로');
});

test('호버·원점 라벨(em)은 막혀도 그리고, 먼저 자리를 잡아 다른 라벨이 그 위를 덮지 않는다', () => {
  const got = placeLabels([lab(0, 100, 100, 200), lab(1, 120, 104, 120, { em: true })], { W: 750, H: 700 });
  assert.deepEqual(got.map((b) => b.i), [1], '앞 번호 일반 라벨이 아니라 호버 라벨이 남는다');
  const forced = placeLabels([lab(0, 100, 100, 200, { em: true }), lab(1, 100, 100, 200, { em: true })], { W: 750, H: 700 });
  assert.equal(forced.length, 2, 'em끼리는 둘 다 그린다(사용자가 지금 보는 것)');
});

// 옛 판정(10/9 이전 graph2d.jsx) — 비교 기준. 세로가 겹치고 시작점이 170px 안이면 건너뛰고, 자리는 언제나 오른쪽.
function oldPlace(cands) {
  const placed = [];
  const out = [];
  for (const c of cands) {
    const x = c.x + c.gap;
    if (!c.em && placed.some((q) => Math.abs(q.y - c.y) < (c.h + q.h) / 2 && Math.abs(q.x - x) < LABEL_X_MIN)) continue;
    placed.push({ x, y: c.y, h: c.h });
    out.push(c.i);
  }
  return out;
}
function rand(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function randomCands(rnd, n, W, H, maxW) {
  return Array.from({ length: n }, (_, i) => {
    const two = rnd() < 0.4;
    return { i, x: rnd() * W, y: 10 + rnd() * (H - 20), gap: 6 + rnd() * 8, w: 30 + rnd() * maxW, h: two ? 34 : 18, em: false };
  });
}

test('어떤 배치에서도 그린 라벨끼리 겹치지 않고 캔버스 안에 있다(무작위 600판, 폰·데스크톱 크기)', () => {
  const rnd = rand(42);
  for (let k = 0; k < 600; k++) {
    const [W, H] = k % 2 ? [390, 420] : [750, 708];
    const got = placeLabels(randomCands(rnd, 4 + Math.floor(rnd() * 20), W, H, 300), { W, H });
    for (const b of got) assert.ok(b.x >= 4 && b.x + b.w <= W - 4 && b.y >= 0 && b.y + b.h <= H, `판 ${k}: 캔버스 밖 ${JSON.stringify(b)}`);
    for (let i = 0; i < got.length; i++) for (let j = i + 1; j < got.length; j++) assert.ok(!hit(got[i], got[j]), `판 ${k}: 겹침 ${got[i].i}·${got[j].i}`);
  }
});

test('데스크톱 불변 — 옛 판정 결과에 겹침·잘림이 없던 배치는 새 판정도 똑같이 그린다(무작위 600판)', () => {
  const rnd = rand(7);
  let same = 0;
  for (let k = 0; k < 600; k++) {
    const W = 750; const H = 708;
    const cands = randomCands(rnd, 3 + Math.floor(rnd() * 14), W, H, 260);
    const fresh = placeLabels(cands, { W, H });
    const old = new Set(oldPlace(cands));
    // 옛 판정 결과가 이미 겹침 0·캔버스 안이면 새 판정 결과와 같아야 한다(바뀌는 것은 겹치거나 잘리던 화면뿐)
    const oldBoxes = cands.filter((c) => old.has(c.i)).map((c) => ({ i: c.i, x: c.x + c.gap, y: c.y - c.h / 2, w: c.w, h: c.h }));
    const clean = oldBoxes.every((b) => b.x >= 4 && b.x + b.w <= W - 4 && b.y >= 0 && b.y + b.h <= H)
      && oldBoxes.every((a, i) => oldBoxes.every((b, j) => i === j || !hit(a, b)));
    if (clean) { same++; assert.deepEqual(fresh.map((b) => b.i).sort((a, b) => a - b), [...old].sort((a, b) => a - b), `판 ${k}`); }
  }
  assert.ok(same > 100, `비교가 성립한 판이 충분해야 한다(${same})`);
});

test('늘 켜 두는 허브 라벨 수 — 1280 캔버스(750×708)는 종전 그대로 14개, 폰(390×420)은 6개, 아주 작으면 4개', () => {
  assert.equal(hubLabelCount(750, 708), 14);
  assert.equal(hubLabelCount(872, 436), 14, '880 창');
  assert.equal(hubLabelCount(390, 420), 6);
  assert.equal(hubLabelCount(390, 195), 4);
});

test('graph2d.jsx 배선 — 라벨 자리는 placeLabels가 정하고, 허브 라벨 수는 hubLabelCount, 겹친 칩·안내 줄 자리를 넘긴다', () => {
  const src = read('../app/c/[ws]/graph2d.jsx');
  assert.match(src, /import \{ placeLabels, hubLabelCount \} from '\.\/graph2d-labels\.mjs';/);
  assert.match(src, /placeLabels\(\[\.\.\.cands\.values\(\)\], \{ W, H, avoid: compact \? \[\] : overlays\(\) \}\)/);
  assert.match(src, /const hubLabel = hubs\.has\(i\) && hubRank\.get\(i\) < nHub;/);
  assert.doesNotMatch(src, /Math\.abs\(q\.x - x\) < 170/, '옛 시작점 판정이 화면 코드에 남지 않는다(정본은 graph2d-labels.mjs)');
});

/* ── ② 판정 함수 — 10/9 격리 서버 실측값(고치기 전 = origin/main 6beb0b19, 고친 뒤 = 이 브랜치) ───── */

test('verifyMail — 고치기 전 390 실측(표 셋 모두 카드 안 가로 스크롤)은 실패, 고친 뒤는 통과', () => {
  const before = { viewport: 390, docOverflow: 0, cards: [
    { title: '대기 중', rows: 2, scroll: 550, cellsOutside: 6, controls: 2, controlsOutside: 2 },
    { title: '배달 기록', rows: 6, scroll: 156, cellsOutside: 12, controls: 6, controlsOutside: 6 },
    { title: '실패함', rows: 3, scroll: 419, cellsOutside: 6, controls: 5, controlsOutside: 5 },
  ] };
  const fails = verifyMail(before);
  assert.equal(fails.length, 9, fails.join('\n'));
  const after = { ...before, cards: before.cards.map((c) => ({ ...c, scroll: 0, cellsOutside: 0, controlsOutside: 0 })) };
  assert.deepEqual(verifyMail(after), []);
  assert.equal(verifyMail({ ...after, cards: after.cards.slice(0, 2) }).length, 1, '표 하나를 못 쟀으면 통과가 아니다');
  assert.equal(verifyMail({ ...after, docOverflow: 3 }).length, 1);
});

test('verifyRoom — 안내 446px/칸 286px·폴더 이름 잘림은 실패, 고친 뒤는 통과, 고정 폴더 없이 잰 것은 실패', () => {
  const before = { viewport: 390, docOverflow: 0,
    placeholder: { text: '@이름 을 붙여 안건을 던지세요 (여러 명 가능, 부른 에이전트 모두 발언) · / 명령·스킬', width: 446, avail: 286 },
    folder: { leaf: '브랜드-리뉴얼-캠페인-최종-보고서-검토용-v3', leafRight: 487, nameRight: 333, leafClipped: true, actInside: true } };
  assert.equal(verifyRoom(before).length, 2);
  const after = { ...before, placeholder: { text: '@이름 안건 · / 명령', width: 104, avail: 294 }, folder: { ...before.folder, leafRight: 333, leafClipped: false } };
  assert.deepEqual(verifyRoom(after), []);
  assert.equal(verifyRoom({ ...after, folder: null }).length, 1);
});

test('verifyGraph — 1280 실측(긴 라벨이 옆 라벨을 덮고 캔버스 밖으로 잘림)은 실패, 고친 뒤는 통과, 못 잰 것은 실패', () => {
  const before = { canvas: [750, 708], frames: 80, maxLabels: 22,
    overlaps: [['뉴스레터 오픈율 개선 실험 — 제목 길이와 발송 시…', '파트너십 제안서 초안 — 교육 기관 대상 단체 요금…']],
    outside: ['파트너십 제안서 초안 — 교육 기관 대상 단체 요금…'] };
  assert.equal(verifyGraph(before).length, 2);
  assert.deepEqual(verifyGraph({ ...before, maxLabels: 20, overlaps: [], outside: [] }), []);
  assert.equal(verifyGraph({ ...before, frames: 0, maxLabels: 0, overlaps: [], outside: [] }).length, 1, '그리기가 멈춘 탭(프레임 0)은 통과가 아니다');
});

/* ── ③ 폴더 줄 — mini-react로 실제 렌더 ───────────────────────── */

const { loadComponent } = await import('./helpers/load-component.mjs');
const { WorkFolderRow } = await loadComponent(file('../app/c/[ws]/work-folder.jsx'), {
  stubs: {
    '../../ui': "export const Icon = () => null; export const Spinner = () => null; export const api = async () => ({}); export const imeGuard = {}; export const isTauriApp = () => false; export const openFolderDialog = async () => null; export const isFolderDialogBroken = () => false; export const FOLDER_DIALOG_EVENT = 'x';",
    '../../i18n': 'export const useLang = () => ({ t: (k) => k });',
  },
  real: [file('../app/c/[ws]/zoom-math.mjs')],
});
const kids = (el) => [el?.props?.children].flat(Infinity).filter((c) => c && typeof c === 'object');
const textOf = (el) => [el?.props?.children].flat(Infinity).map((c) => (c && typeof c === 'object' ? textOf(c) : c ?? '')).join('');

test('폴더 줄 — 폴더 이름(마지막 칸)은 줄지 않는 칸, 상위 칸만 말줄임으로 준다(폰 폭에서 폴더 이름이 잘리던 것)', () => {
  const row = WorkFolderRow({ wf: { pinned: '/Users/me/고객사-프로젝트-2026-하반기-리뉴얼/브랜드-리뉴얼-캠페인-최종-보고서-검토용-v3', pin() {} } });
  const name = kids(row).find((k) => k.props?.className === 'name');
  assert.equal(name.props.style?.display, 'flex', '두 칸을 따로 줄이는 flex 줄');
  const [parent, leaf] = kids(name).flatMap((k) => (k.props?.children && typeof k.type === 'symbol' ? kids(k) : [k]));
  assert.equal(textOf(parent), '…/고객사-프로젝트-2026-하반기-리뉴얼');
  assert.equal(textOf(leaf), '/브랜드-리뉴얼-캠페인-최종-보고서-검토용-v3');
  assert.equal(parent.props.style.flex, '0 1 auto', '상위 칸은 준다');
  assert.equal(parent.props.style.textOverflow, 'ellipsis');
  assert.equal(leaf.props.style.flex, 'none', '폴더 이름은 비율로 같이 줄지 않는다(가중 축소면 0.2px만 줄어도 끝이 말줄임된다)');
  assert.equal(leaf.props.style.maxWidth, '100%', '폴더 이름이 줄보다 길 때만 그 칸에서 말줄임');
  assert.equal(leaf.props.style.textOverflow, 'ellipsis');
  assert.equal(row.props.title, '/Users/me/고객사-프로젝트-2026-하반기-리뉴얼/브랜드-리뉴얼-캠페인-최종-보고서-검토용-v3', '전체 경로는 title');
  const single = WorkFolderRow({ wf: { pinned: '/work', pin() {} } });
  assert.equal(textOf(kids(single).find((k) => k.props?.className === 'name')), '…/work', '한 칸짜리 경로는 종전 표기 그대로');
  const win = WorkFolderRow({ wf: { pinned: 'C:\\Users\\me\\보고서', pin() {} } });
  assert.equal(textOf(kids(win).find((k) => k.props?.className === 'name')), '…/me/보고서', '윈도우 경로도 끝 두 칸(종전 표기와 같은 글자)');
});

/* ── ④ 쪽지함 — 좁은 폭 카드 행이 인라인 폭에 막히지 않는다 ─────────── */

test('쪽지함 표 칸·머리에 인라인 width가 없다 — 폭은 모듈 클래스(표 모드)로, 좁은 폭은 카드 행(width auto)이 이긴다', () => {
  const src = read('../app/c/[ws]/mail/page.jsx');
  const tables = [...src.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  assert.equal(tables.length, 3, '대기 중·배달 기록·실패함');
  for (const tb of tables) {
    assert.match(tb, /<table className=\{`table \$\{s\.table\}`\}>/, '전역 .table + 모듈 표지');
    for (const cell of tb.matchAll(/<t[dh]\b[^>]*style=\{\{([^}]*)\}\}/g)) assert.doesNotMatch(cell[1], /(^|[\s,])width:/, `인라인 width가 남았다: ${cell[0].slice(0, 80)}`);
  }
  assert.match(src, /<div className=\{s\.page\} style=\{\{ display: 'grid'/, '폭 기준(container)은 페이지 뿌리');
  const css = read('../app/c/[ws]/mail/mail.module.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.page \{ container: mail \/ inline-size; \}/);
  const narrow = css.slice(css.indexOf('@container mail (max-width: 60rem)'));
  assert.ok(narrow.length > 40, '좁은 폭 블록');
  assert.match(narrow, /\.page \.table tbody tr \{[^}]*display: flex;[^}]*flex-wrap: wrap;/, '행 = 줄바꿈되는 flex 카드');
  assert.match(narrow, /\.page \.table td \{[^}]*width: auto;/, '표 모드 열 폭을 푼다');
  assert.match(narrow, /\.page \.table thead \{[^}]*clip-path: inset\(50%\);/, '머리는 화면에서만 숨긴다(읽기 프로그램에는 남김)');
  for (const [k, v] of [['wTo', 150], ['wFrom', 130], ['wWhen', 150], ['wAct', 90], ['wDot', 24], ['wTime', 120], ['wOpen', 110], ['wDeadAct', 170]]) {
    assert.match(css, new RegExp(`\\.${k} \\{ width: ${v}px; \\}`), `표 모드 열 폭 ${k}=${v}px(종전 인라인 값 그대로)`);
  }
});

/* ── ⑤ 회의실 짧은 안내 ───────────────────────────────────────── */

test('회의실 짧은 안내 — ko·en 둘 다 있고 긴 안내보다 짧다, 화면은 잰 결과로 고른다', () => {
  const i18n = read('../app/i18n.jsx');
  const pair = (key) => {
    const m = i18n.match(new RegExp(`^\\s*'${key.replace('.', '\\.')}': \\['([^']*)', '([^']*)'\\]`, 'm'));
    assert.ok(m, `${key} 사전 줄`);
    return [m[1], m[2]];
  };
  const [koLong, enLong] = pair('room.placeholder');
  const [ko, en] = pair('room.placeholderShort');
  assert.ok(ko && en, 'ko·en 둘 다');
  assert.ok(ko.length * 2 < koLong.length && en.length * 2 < enLong.length, '긴 안내의 절반보다 짧다');
  assert.match(ko, /@이름/); assert.match(en, /@name/);
  assert.doesNotMatch(ko, /크루|사장/);
  const room = read('../app/c/[ws]/room/page.jsx');
  assert.match(room, /placeholder=\{phShort \? t\('room\.placeholderShort'\) : phLong\}/);
  assert.match(room, /setPhShort\(room > 0 && ctx\.measureText\(phLong\)\.width > room\);/, '긴 안내가 입력창 한 줄 폭을 넘을 때만 짧은 안내');
  assert.match(room, /const ro = new ResizeObserver\(measure\);/, '폭이 바뀌면 다시 잰다');
});
