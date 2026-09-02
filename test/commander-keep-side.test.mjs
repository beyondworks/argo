// '/' 커맨더 이동 명령의 보조 패널 유지 — 분리 검수 2026-09-02(회의실 커맨더 PR) LOW-5: /memory·/deck(·크루의 /room)이
// 생 router.push라 ?side=(옆에 열기 패널 상태 — 레이아웃 선언 "내부 링크는 전부 withSide를 통과")를 떨어뜨려 패널이 닫혔다.
// 처방 = split.mjs의 keepSide(href, window.location.search): 현재 side를 그대로 싣는 순수 함수(행동 테스트) + 두 페이지의
// 이동 명령이 그것을 타는지 소스 구간 핀(생 push 부활은 red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { keepSide, parseSide, sideParam, withSide } from '../app/c/[ws]/split.mjs';

const stripComments = (src) => src
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
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
  await assertCommanderKeepsSide('../app/c/[ws]/crew/[slug]/page.jsx', /import \{ keepSide, sideParam, withSide \} from '\.\.\/\.\.\/split\.mjs';/,
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
