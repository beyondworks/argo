// 변이 주입기 — 핀이 '행동'을 잠그는지 실증한다(소스 문자열 단언은 게이트가 아니다, 레포 규칙).
//   node mutations.mjs list
//   node mutations.mjs apply M4 <App.jsx 경로>     → 브라우저 검사 재실행 → 해당 게이트가 red 여야 한다
//   node mutations.mjs revert   <App.jsx 경로>
//
// 앵커는 리비전마다 후보를 여러 개 둔다: f932c62(원안)와 23c67513(검수 반영본) 양쪽에서 돈다.
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';

const MUT = {
  M1: ['역방향 질의 뒤집기(lt→gt)', [[".eq('channel_id', chId).lt('id', first)", ".eq('channel_id', chId).gt('id', first)"]]],
  M2: ['위치 보정 제거', [
    // 23c67513: 앵커 노드 델타
    ['el.scrollTop += y - a.y; a.y = y;', 'a.y = y;'],
    // f932c62: 높이 스냅샷
    ['if (p && el) { el.scrollTop = el.scrollHeight - p.h + p.top; prepend.current = null; }', 'if (p && el) { prepend.current = null; }'],
  ]],
  M3: ['중복 제거 삭제(loadOlder dedup)', [['return [...list.filter((m) => !seen.has(m.id)), ...base];', 'return [...list, ...base];']]],
  M4: ['reverse 제거(이전 페이지 역순)', [['const list = rows.reverse();', 'const list = rows;']]],
  M5: ['prepend→append(옛 기록을 맨 아래)', [['return [...list.filter((m) => !seen.has(m.id)), ...base];', 'return [...base, ...list.filter((m) => !seen.has(m.id))];']]],
  M6: ['hasMore 항상 참(무한 버튼)', [['setHasMore(rows.length >= PAGE);\n      await hydrate', 'setHasMore(rows.length > 0);\n      await hydrate']]],
  M7: ['동시 로드 가드 무력화', [
    ['if (!first || olderRef.current || !hasMore) return;', 'if (!first || !hasMore) return;'],
    ['if (!first || older || !hasMore) return;', 'if (!first || !hasMore) return;'],
  ]],
  M8: ['모바일 재개를 전체 교체로 되돌림(HIGH-2 회귀)', [
    ['observeMobileResume(() => load(live.current.msgs?.at(-1)?.id ?? 0)', 'observeMobileResume(() => load(0)'],
  ]],
  // 23c67513 은 늦게 오는 높이 변화를 두 갈래로 되맞춘다 — 레이아웃 효과의 atts 의존과 척추 ResizeObserver.
  // 한 갈래만 끊으면 나머지가 덮으므로(M9 로 실증) HIGH-1 회귀를 보려면 둘 다 끊어야 한다(M10).
  M9: ['척추 ResizeObserver 되맞춤만 제거(단독으로는 HIGH-1 이 안 깨진다 — 이중화 확인용)', [
    ['new ResizeObserver(() => { keepAnchor(); toBottom(); })', 'new ResizeObserver(() => { toBottom(); })'],
  ]],
  M10: ['늦게 오는 높이 변화 되맞춤 전부 제거(HIGH-1 회귀)', [
    ['new ResizeObserver(() => { keepAnchor(); toBottom(); })', 'new ResizeObserver(() => { toBottom(); })'],
    ['useLayoutEffect(keepAnchor, [msgs, atts, keepAnchor]);', 'useLayoutEffect(keepAnchor, [msgs, keepAnchor]);'],
  ], { all: true }],
};

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'list') { for (const [k, [d]] of Object.entries(MUT)) console.log(k, d); process.exit(0); }
const file = cmd === 'revert' ? a : b;
if (!file) { console.error('사용: node mutations.mjs apply <M1..M9> <App.jsx> | revert <App.jsx> | list'); process.exit(2); }
const bak = `${file}.mutbak`;
if (cmd === 'revert') {
  if (!existsSync(bak)) { console.error('백업 없음 — 적용된 변이가 없다'); process.exit(2); }
  copyFileSync(bak, file); unlinkSync(bak); console.log('되돌림', file); process.exit(0);
}
if (cmd !== 'apply' || !MUT[a]) { console.error('알 수 없는 변이', a); process.exit(2); }
if (existsSync(bak)) { console.error('이미 변이 적용 중 — 먼저 revert'); process.exit(2); }
const [desc, pairs, opt = {}] = MUT[a];
const src = readFileSync(file, 'utf8');
const hits = opt.all ? pairs.filter(([from]) => src.includes(from)) : pairs.filter(([from]) => src.includes(from)).slice(0, 1);
if (!hits.length || (opt.all && hits.length !== pairs.length)) { console.error(`앵커를 못 찾음(${a}: ${desc}) — 대상 리비전을 확인하고 후보를 추가할 것`); process.exit(2); }
copyFileSync(file, bak);
writeFileSync(file, hits.reduce((acc, [from, to]) => acc.replace(from, to), src));
console.log(`적용 ${a}: ${desc}`);
