// '/' 커맨더 이동 명령의 보조 패널 유지 — 분리 검수 2026-09-02(회의실 커맨더 PR) LOW-5: /memory·/deck(·크루의 /room)이
// 생 router.push라 ?side=(옆에 열기 패널 상태 — 레이아웃 선언 "내부 링크는 전부 withSide를 통과")를 떨어뜨려 패널이 닫혔다.
// 처방 = split.mjs의 keepSide(href, window.location.search): 현재 side를 그대로 싣는 순수 함수(행동 테스트) + 두 페이지의
// 이동 명령이 그것을 타는지 소스 구간 핀(생 push 부활은 red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepSide, keepSideExcept, parseSide, sideParam, withSide } from '../app/c/[ws]/split.mjs';
import { stripComments } from './helpers/strip-comments.mjs'; // 문자열 상태 추적 하드닝판 — 문자열 속 /*가 실코드를 지우지 않는다

const load = async (rel) => stripComments(await readFile(new URL(rel, import.meta.url), 'utf8'));

test('keepSide: 현재 ?side=를 그대로 싣는다 — 앞의 ? 유무 무관, 현재 페이지의 다른 쿼리는 끌고 가지 않는다', () => {
  assert.equal(keepSide('/c/ws1/vault', '?side=crew%3Anova'), '/c/ws1/vault?side=crew%3Anova');
  assert.equal(keepSide('/c/ws1/vault', 'side=crew%3Anova'), '/c/ws1/vault?side=crew%3Anova', "앞 '?' 없어도 동일");
  assert.equal(keepSide('/c/ws1/room', '?q=1&side=doc%3Anotes%2Fx.md&zoom=2'), '/c/ws1/room?side=doc%3Anotes%2Fx.md', '다른 쿼리(q·zoom)는 목적지로 가지 않는다');
  assert.equal(keepSide('/c/ws1/vault?doc=a.md', '?side=crew%3Ax'), '/c/ws1/vault?doc=a.md&side=crew%3Ax', '목적지 href의 자기 쿼리는 보존');
});

test('keepSide: side가 없거나 잘못된 spec이면 href 그대로 — 빈 ?를 남기지 않는다', () => {
  for (const search of ['', '?', undefined, null, '?q=1', '?side=', '?side=room%3Ax', '?side=crew%3A']) {
    assert.equal(keepSide('/c/ws1', search), '/c/ws1', `search=${JSON.stringify(search)}`);
  }
  assert.equal(keepSide('/c/ws1?tab=a', '?side=nope'), '/c/ws1?tab=a', '잘못된 spec은 버리되 href 쿼리는 보존');
});

test('keepSide: 한글 slug 왕복 — 결과의 side를 parseSide하면 원래 크루로 돌아온다(레이아웃이 읽는 그대로)', () => {
  const cur = sideParam({ type: 'crew', key: '클로에-편집' });
  const search = `?${new URLSearchParams({ side: cur })}`; // 브라우저가 실제로 주는 형태(인코딩됨)
  const href = keepSide('/c/ws1/room', search);
  const got = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('side');
  assert.deepEqual(parseSide(got), { type: 'crew', key: '클로에-편집' });
});

// ── 두 페이지의 이동 명령이 keepSide를 탄다(소스 구간 핀 — 생 router.push 부활은 red) ──────────
async function assertCommanderKeepsSide(rel, importRe, expectCmds, label) {
  const src = await load(rel);
  assert.match(src, importRe, `${label}: keepSide 임포트`);
  const i = src.indexOf('const SLASH_CMDS = [');
  assert.ok(i > 0, `${label}: SLASH_CMDS`);
  const region = src.slice(i, src.indexOf('\n  ];', i));
  for (const [id, path] of expectCmds) {
    assert.match(region, new RegExp(`\\{ id: '${id}',[^\\n]*run: \\(\\) => router\\.push\\(keepSide\\(\`\\/c\\/\\$\\{ws\\}${path}\`, window\\.location\\.search\\)\\) \\}`),
      `${label}: /${id} 이동이 keepSide(현재 window.location.search)를 탄다`);
  }
  assert.doesNotMatch(region, /router\.push\(`/, `${label}: 커맨더 안의 생 router.push(템플릿 직접) 금지 — side가 떨어져 패널이 닫힌다`);
  assert.equal((region.match(/router\.push\(/g) ?? []).length, expectCmds.length, `${label}: 이동 명령 수 = keepSide 경유 수(우회 push 없음)`);
}

test('크루 채팅 커맨더: /memory·/room·/deck 이동이 keepSide를 탄다(임베드 패널에선 이동 명령 자체가 없다 — 기존)', async () => {
  await assertCommanderKeepsSide('../app/c/[ws]/crew/[slug]/page.jsx', /import \{ keepSide, keepSideExcept, sideParam, withSide \} from '\.\.\/\.\.\/split\.mjs';/,
    [['memory', '\\/vault'], ['room', '\\/room'], ['deck', '']], '크루');
  const src = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  const i = src.indexOf('const SLASH_CMDS = [');
  assert.match(src.slice(i, src.indexOf('\n  ];', i)), /\.\.\.\(embedded \? \[\] : \[/, '크루: 임베드 제외 조건 보존(패널이 주 화면 URL을 바꾸지 않는다)');
});

test('회의실 커맨더: /memory·/deck 이동이 keepSide를 탄다', async () => {
  await assertCommanderKeepsSide('../app/c/[ws]/room/page.jsx', /import \{ keepSide \} from '\.\.\/split\.mjs';/,
    [['memory', '\\/vault'], ['deck', '']], '회의실');
});

test('레이아웃 규약과 같은 계산(유효 spec에서) — keepSide(href, search)는 withSide(href, 현재 side)와 동일하다(L(href) 정합; 무효 spec은 keepSide만 버린다 — 레이아웃은 값을 남기되 패널을 안 그려 가시 동작 동일)', () => {
  for (const side of ['crew:nova', 'doc:notes/x.md', sideParam({ type: 'crew', key: '페퍼' })]) {
    const search = `?${new URLSearchParams({ side })}`;
    assert.equal(keepSide('/c/ws1/vault', search), withSide('/c/ws1/vault', side));
  }
});

// ── 커맨더 밖의 생 router.push(분리 검수 2 별건: 데크 4곳·크루 해고 복귀 1곳) ──────────────────────
test('keepSideExcept: 현재 side가 spec(해고한 크루)이면 떨구고, 다른 크루·문서 패널은 유지, spec null이면 keepSide와 동일', () => {
  const pepper = { type: 'crew', key: 'pepper' };
  assert.equal(keepSideExcept('/c/ws1', '?side=crew%3Apepper', pepper), '/c/ws1', '열린 패널 = 해고한 크루 → 떨군다');
  assert.equal(keepSideExcept('/c/ws1?tab=a', '?side=crew%3Apepper', pepper), '/c/ws1?tab=a', '떨궈도 href 쿼리는 보존');
  assert.equal(keepSideExcept('/c/ws1', '?side=crew%3Anova', pepper), '/c/ws1?side=crew%3Anova', '다른 크루 패널은 유지');
  assert.equal(keepSideExcept('/c/ws1', '?side=doc%3Anotes%2Fx.md', pepper), '/c/ws1?side=doc%3Anotes%2Fx.md', '문서 패널은 유지');
  const ko = { type: 'crew', key: '페퍼' };
  assert.equal(keepSideExcept('/c/ws1', `?${new URLSearchParams({ side: sideParam(ko) })}`, ko), '/c/ws1', '한글 slug — 브라우저 인코딩 형태와 비교');
  for (const search of ['?side=crew%3Anova', '?side=doc%3Aa.md', '', '?side=room%3Ax', undefined]) {
    assert.equal(keepSideExcept('/c/ws1/vault', search, null), keepSide('/c/ws1/vault', search), `spec null = keepSide (${JSON.stringify(search)})`);
  }
  assert.equal(keepSideExcept('/c/ws1', '?side=nope', pepper), '/c/ws1', '잘못된 spec은 어차피 버린다');
});

test('데크: 기억 문서 클릭·크게 보기·그래프 선택·설정 CTA 이동이 keepSide를 탄다', async () => {
  const src = await load('../app/c/[ws]/page.jsx');
  assert.match(src, /import \{ keepSide \} from '\.\/split\.mjs';/, '데크: keepSide 임포트');
  assert.match(src, /<tr key=\{m\.rel\} onClick=\{\(\) => router\.push\(keepSide\(`\/c\/\$\{ws\}\/vault\?doc=\$\{encodeURIComponent\(m\.rel\)\}`, window\.location\.search\)\)\}>/, '기억 문서 행 클릭');
  assert.match(src, /onClick=\{\(\) => router\.push\(keepSide\(`\/c\/\$\{ws\}\/vault`, window\.location\.search\)\)\} style=\{\{ cursor: 'pointer' \}\}>\{t\('deck\.viewLarge'\)\}<\/button>/, '크게 보기');
  assert.match(src, /onSelectDoc=\{\(rel\) => router\.push\(keepSide\(`\/c\/\$\{ws\}\/vault\?doc=\$\{encodeURIComponent\(rel\)\}`, window\.location\.search\)\)\}/, '그래프 문서 선택');
  assert.match(src, /onClick=\{\(\) => router\.push\(keepSide\(`\/c\/\$\{ws\}\/settings\?ai=1`, window\.location\.search\)\)\}>/, '설정 CTA(?ai=1 딥링크 보존)');
});

test('크루 해고 후 데크 복귀: 열린 패널이 해고한 그 크루면 떨구고 아니면 유지(keepSideExcept) — 임베드면 패널만 닫는다(기존)', async () => {
  const src = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  assert.match(src, /import \{ keepSide, keepSideExcept, sideParam, withSide \} from '\.\.\/\.\.\/split\.mjs';/, '임포트');
  assert.match(src, /onFired=\{\(\) => \{ window\.dispatchEvent\(new Event\('argo:refresh'\)\); if \(embedded\) onClose\?\.\(\); else router\.push\(keepSideExcept\(`\/c\/\$\{ws\}`, window\.location\.search, \{ type: 'crew', key: slug \}\)\); \}\}/,
    '해고 콜백 전체(표현식 앵커 — 무조건 keepSide(패널 유지)나 생 push(패널 소실)로 바뀌면 red)');
});

// 파일 전역 스위프(fail-closed): app/ 아래 모든 router.push( 호출은 keepSide·keepSideExcept·L(레이아웃) 경유이거나
// 허용 목록(회사 밖으로 나가는 경로 — 표현식 전체 앵커, 바뀌면 stale로 red)에 있어야 한다. 새 생 push가 어디에 생겨도 red.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(jsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
/** 괄호 균형으로 호출 표현식 전체를 잘라 낸다 — 정규식 한 줄로는 중첩 괄호(keepSide(`…`, window.location.search))를 못 닫는다 */
function callsOf(src, name) {
  const out = [];
  let i = src.indexOf(name);
  while (i >= 0) {
    let depth = 0, j = i + name.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    out.push({ expr: src.slice(i, j + 1), line: src.slice(0, i).split('\n').length });
    i = src.indexOf(name, j);
  }
  return out;
}
/** 허용 형태 — keepSide·keepSideExcept는 **현재 search를 넘겨야** 한다: `keepSide(href)`는 side 제거라 생 push와 동작이
    같은데 접두 검사만으로는 통과했다(분리 검수 F3 — 패턴을 베끼며 인자를 빠뜨리는 게 가장 흔한 실수). 레이아웃의 L(href)는
    그 파일에서만 허용(1글자 범용 이름이라 다른 파일의 우연한 L( 이 통과하지 않게 — 검수 LOW-1). */
const isAllowedForm = (expr, rel) =>
  (/^router\.push\((keepSide|keepSideExcept)\(/.test(expr) && expr.includes('window.location.search')) ||
  (rel === 'app/c/[ws]/layout.jsx' && /^router\.push\(L\(/.test(expr));
/** 수집 전 정규화 — 옵셔널 체이닝·공백·대괄호 호출은 같은 호출이다(검수 F1: 리터럴 'router.push(' 고정이면 통째로 빠져나간다) */
const normalizeCalls = (src) => src
  .replace(/\brouter\s*\?\.\s*push\s*\(/g, 'router.push(')
  .replace(/\brouter\.push\s+\(/g, 'router.push(')
  .replace(/\brouter\[(['"])push\1\]\s*\(/g, 'router.push(');
const ALLOW = { // 회사(/c/[ws]) 밖으로 나가는 경로 — side 문맥이 없다. 항목은 표현식 전체(바뀌면 재판정 강제)
  'app/page.jsx': ['router.push(firstCrew ? `/c/${company.id}/crew/${firstCrew}` : `/c/${company.id}`)'], // 회사 생성 직후 첫 진입 — 아직 패널 없음
  'app/c/[ws]/settings/page.jsx': ["router.push('/')"], // 회사 보관 후 루트로 — 회사 밖
};

/** 파일별 router.push( 개수 — 전역 합계 하한은 과제거 1건과 신규 1건이 상쇄돼 눈먼다(검수 LOW-2). 새 이동을 넣으면
    여기서 red가 나고, 그때 side 판정을 한 뒤 기대치를 갱신한다(재판정 강제). 줄어들면 수집기·스트리퍼부터 의심. */
const EXPECTED = {
  'app/page.jsx': 1, 'app/c/[ws]/layout.jsx': 1, 'app/c/[ws]/page.jsx': 4, 'app/c/[ws]/settings/page.jsx': 1,
  'app/c/[ws]/crew/[slug]/page.jsx': 4, 'app/c/[ws]/room/page.jsx': 2,
};

test('스위프: app/ 전역의 router.push 계열(옵셔널 체이닝·공백·대괄호 호출 정규화)은 search를 넘기는 keepSide·keepSideExcept, 레이아웃의 L 경유이거나 허용 목록(회사 밖 이동)뿐 — 파일별 개수 고정', async () => {
  const bad = []; const seenAllow = new Set(); const counts = {};
  for (const file of walk(join(ROOT, 'app'))) {
    const rel = relative(ROOT, file).split(sep).join('/'); // 윈도우 백슬래시 → 슬래시(EXPECTED 키·허용 목록과 같은 표기; CI windows-latest 실패 원인)
    const src = normalizeCalls(stripComments(await readFile(file, 'utf8')));
    for (const c of callsOf(src, 'router.push(')) {
      counts[rel] = (counts[rel] ?? 0) + 1;
      if (isAllowedForm(c.expr, rel)) continue;
      if ((ALLOW[rel] ?? []).includes(c.expr)) { seenAllow.add(`${rel}::${c.expr}`); continue; }
      bad.push(`${rel}:${c.line} ${c.expr.slice(0, 90)}`);
    }
    // 수집기 모양 방어 — useRouter()는 항상 `const router = useRouter()`로만(다른 이름이면 위 수집이 못 본다 → fail-open)
    for (const m of src.matchAll(/useRouter\(\)/g)) {
      if (src.slice(Math.max(0, m.index - 15), m.index) !== 'const router = ') bad.push(`${rel}: useRouter()가 router 외 이름/직접 호출 — 수집기 사각`);
    }
    if (/\buseRouter\s+as\s+/.test(src)) bad.push(`${rel}: useRouter 개명 임포트 — 수집기 사각(검수 F5)`);
  }
  assert.deepEqual(bad, [], `side를 떨어뜨리는 생 router.push(허용 목록 밖) 또는 수집기 사각:\n${bad.join('\n')}`);
  assert.deepEqual(counts, EXPECTED, '파일별 router.push 개수가 기대치와 다르다 — 새 이동이면 side 판정 후 EXPECTED 갱신, 줄었으면 수집기·스트리퍼 확인');
  const stale = Object.entries(ALLOW).flatMap(([f, es]) => es.filter((e) => !seenAllow.has(`${f}::${e}`)).map((e) => `${f} ${e}`));
  assert.deepEqual(stale, [], `허용 목록이 소스와 어긋남(표현식이 바뀌었으면 side 판정을 다시 하고 목록을 갱신):\n${stale.join('\n')}`);
});
