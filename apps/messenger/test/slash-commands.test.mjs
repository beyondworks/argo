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
