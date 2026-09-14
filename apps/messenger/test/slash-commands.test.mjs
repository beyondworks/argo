import test from 'node:test';
import assert from 'node:assert/strict';
import { slashCandidates, slashInsert } from '../src/slash-commands.mjs';

const pepper = { id: 'p', display_name: '페퍼', commands: [{ kind: 'alias', cmd: '보고', text: '오늘 업무 보고서를 써' }, { kind: 'skill', id: 'daily-report', title: '일일 보고' }] };
const alfred = { id: 'a', display_name: '알프레드', commands: pepper.commands }; // 같은 회사 → 같은 목록
const bot = { id: 'b', display_name: 'Wolff', commands: [{ kind: 'skill', id: 'vps-check', title: 'VPS 점검' }] };
const opt = { skillPrefix: (t) => `"${t}" 스킬을 사용해서 ` };

test('슬래시 토큰일 때만 후보 — 문장 속 /나 공백 뒤는 null', () => {
  assert.equal(slashCandidates('안녕 /보고', [pepper], opt), null);
  assert.equal(slashCandidates('/보고 내용', [pepper], opt), null);
  assert.equal(slashCandidates('', [pepper], opt), null);
  assert.equal(slashCandidates('/', [], opt).length, 0);
});

test('빈 질의는 전부, 접두는 대소문자 무시로 별칭 cmd·스킬 id·제목에 매칭 — 같은 명령은 크루를 묶는다', () => {
  const all = slashCandidates('/', [pepper, alfred, bot], opt);
  assert.deepEqual(all.map((r) => [r.kind, r.cmd, r.crews.map((c) => c.name)]), [
    ['alias', '보고', ['페퍼', '알프레드']], ['skill', 'daily-report', ['페퍼', '알프레드']], ['skill', 'vps-check', ['Wolff']],
  ]);
  assert.deepEqual(slashCandidates('/DAILY', [pepper, bot], opt).map((r) => r.cmd), ['daily-report']);
  assert.deepEqual(slashCandidates('/일일', [pepper], opt).map((r) => r.cmd), ['daily-report'], '제목으로도');
  assert.equal(slashCandidates('/', [pepper], opt)[1].insert, '"일일 보고" 스킬을 사용해서 ');
  assert.equal(slashCandidates('/', [pepper], opt)[0].insert, '오늘 업무 보고서를 써');
});

test('손상 데이터 관용 — commands 비배열·항목 누락은 건너뛴다', () => {
  const r = slashCandidates('/', [{ id: 'x', display_name: 'X', commands: 'nope' }, { id: 'y', display_name: 'Y', commands: [{ kind: 'alias', cmd: 'a' }, { kind: 'skill' }, null] }], opt);
  assert.deepEqual(r, []);
});

test('삽입 — 1:1은 지시문만, 단체 방은 크루가 하나면 @이름 + 멘션, 둘 이상이면 지시문만', () => {
  const [alias, , vps] = slashCandidates('/', [pepper, alfred, bot], opt);
  assert.deepEqual(slashInsert(alias, { isDm: true }), { text: '오늘 업무 보고서를 써', mention: null });
  assert.deepEqual(slashInsert(alias, { isDm: false }), { text: '오늘 업무 보고서를 써', mention: null });
  assert.deepEqual(slashInsert(vps, { isDm: false }), { text: '@Wolff "VPS 점검" 스킬을 사용해서 ', mention: { kind: 'crew', id: 'b', name: 'Wolff' } });
});

// 1:1 수신·참조 = 입력창 명령(유건 결정 2026-09-14). 서버가 역할 없는 @멘션을 to로 보므로 /to는 @ 삽입, /cc만 참조 칩.
import { rolePickCandidates, ROLE_PICK_RE } from '../src/slash-commands.mjs';
const cands = [{ id: 'p', display_name: '페퍼', role_text: '비서', delivery_ready: true }, { id: 'w', display_name: 'Wolff', role_text: 'VPS', delivery_ready: false }, { id: 'a', display_name: '알프레드', delivery_ready: true }];

test('내장 /to·/cc는 1:1에서만 넘기며 크루 명령보다 앞에, 접두 매칭·삽입은 "/to "', () => {
  const b = [{ cmd: 'to', desc: '수신' }, { cmd: 'cc', desc: '참조' }];
  assert.deepEqual(slashCandidates('/', [pepper], { ...opt, builtins: b }).map((r) => [r.kind, r.cmd]), [['builtin', 'to'], ['builtin', 'cc'], ['alias', '보고'], ['skill', 'daily-report']]);
  assert.deepEqual(slashCandidates('/c', [pepper], { ...opt, builtins: b }).map((r) => r.cmd), ['cc']);
  assert.deepEqual(slashInsert(slashCandidates('/t', [], { ...opt, builtins: b })[0], { isDm: true }), { text: '/to ', mention: null });
  assert.deepEqual(slashCandidates('/', [pepper], opt).map((r) => r.kind), ['alias', 'skill'], 'builtins 없으면(단체 방) 그대로');
});

test('/to·/cc 목록 — 명령이 아니면 null, 질의는 이름 부분 일치(대소문자 무시), 제외 집합은 빠지고 미지원 크루는 disabled', () => {
  assert.equal(rolePickCandidates('안녕', cands), null);
  assert.equal(rolePickCandidates('/todo', cands), null, '/to 뒤에 글자가 붙으면 다른 명령');
  assert.equal(rolePickCandidates('/cc 페 퍼', cands), null, '질의는 한 토큰');
  assert.match('/CC', ROLE_PICK_RE);
  const all = rolePickCandidates('/to', cands);
  assert.equal(all.role, 'to'); assert.deepEqual(all.list.map((c) => [c.name, c.disabled]), [['페퍼', false], ['Wolff', true], ['알프레드', false]]);
  assert.deepEqual(rolePickCandidates('/cc wol', cands).list.map((c) => c.id), ['w']);
  assert.deepEqual(rolePickCandidates('/cc ', cands, { exclude: new Set(['p', 'w']) }).list.map((c) => c.id), ['a']);
  assert.deepEqual(rolePickCandidates('/to', cands, { participants: new Set(['p']) }).list.map((c) => c.id), ['w', 'a'], '1:1 상대는 /to에서만 빠진다');
  assert.deepEqual(rolePickCandidates('/cc', cands, { participants: new Set(['p']) }).list.map((c) => c.id), ['p', 'w', 'a'], '/cc에는 상대가 남는다(참고만)');
  assert.deepEqual(rolePickCandidates('/cc', 'nope').list, [], '손상 데이터 관용');
});
