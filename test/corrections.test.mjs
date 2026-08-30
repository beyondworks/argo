// 크루 길들이기(F) — 프리필터·감지 적립·2회 제안·채택=스킬 적립·거절 침묵을 임시 ARGO_ROOT에서 잠근다.
// LLM 판정은 oneshotFn 주입(실 러너 불필요) — 프리필터 통과 여부는 호출 수로 관측한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-corrections-'));
const { CORRECTION_HINT_RE, detectAndTrack, listSuggestions, adoptCorrection, dismissCorrection, RULES_SKILL, SUGGEST_AT } = await import('../src/corrections.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');

const WS = 'tameco';
await createCompany(WS, '길들이기사', 'captain');

const oneshotOf = (jsonOut) => {
  const calls = [];
  const fn = async (prompt) => { calls.push(prompt); return JSON.stringify(jsonOut); };
  fn.calls = calls;
  return fn;
};

test('프리필터 — 교정 신호 어휘가 없으면 LLM 판정을 부르지 않는다(비용 관문)', async () => {
  const run = oneshotOf({ correction: false });
  assert.equal(await detectAndTrack(WS, { userMsg: '오늘 회의록 정리해줘', oneshotFn: run }), null);
  assert.equal(run.calls.length, 0, '신호 없는 일반 지시는 원샷 0회');
  assert.ok(CORRECTION_HINT_RE.test('표로 정리하지 마'), 'ko 신호');
  assert.ok(CORRECTION_HINT_RE.test("don't use tables"), 'en 신호');
});

test('감지 2회 → 제안에 등장, 1회는 아직 아니다 (에스컬레이션 표: 두 번 틀리면 규칙)', async () => {
  const first = oneshotOf({ correction: true, rule: '표 대신 불릿으로 정리한다', matches: null });
  const it = await detectAndTrack(WS, { userMsg: '표로 정리하지 마', oneshotFn: first });
  assert.ok(it?.id);
  assert.equal((await listSuggestions(WS)).length, 0, `1회째는 제안 없음(문턱 ${SUGGEST_AT})`);
  const second = oneshotOf({ correction: true, rule: '표 대신 불릿으로 정리한다', matches: it.id });
  await detectAndTrack(WS, { userMsg: '또 표네 — 다시 써', oneshotFn: second });
  assert.ok(second.calls[0].includes(it.id), '판정 프롬프트에 기존 후보 목록이 실린다(같은 계열 매칭용)');
  const sug = await listSuggestions(WS);
  assert.equal(sug.length, 1);
  assert.equal(sug[0].count, 2);
});

test('채택 → skills/사장-지침.md 적립(자동 주입 채널) + 제안 목록에서 소멸', async () => {
  const [sug] = await listSuggestions(WS);
  const r = await adoptCorrection(WS, sug.id);
  assert.equal(r.rule, '표 대신 불릿으로 정리한다');
  const skill = await readFile(join(paths(WS).skills, RULES_SKILL), 'utf8');
  assert.ok(skill.includes('- 표 대신 불릿으로 정리한다'), '규칙이 스킬 파일 불릿으로 남는다 = 매 턴 전 크루 주입');
  assert.equal((await listSuggestions(WS)).length, 0);
  // 채택 후 재채택은 거절(candidate가 아니다)
  await assert.rejects(() => adoptCorrection(WS, sug.id));
});

test('거절 → 다시 제안하지 않는다', async () => {
  const a = oneshotOf({ correction: true, rule: '결론을 먼저 쓴다', matches: null });
  const it = await detectAndTrack(WS, { userMsg: '왜 결론을 뒤에 썼어 — 앞으로는 결론 먼저', oneshotFn: a });
  const b = oneshotOf({ correction: true, rule: '결론을 먼저 쓴다', matches: it.id });
  await detectAndTrack(WS, { userMsg: '또 결론이 뒤네, 다시 써', oneshotFn: b });
  assert.equal((await listSuggestions(WS)).length, 1);
  await dismissCorrection(WS, it.id);
  assert.equal((await listSuggestions(WS)).length, 0);
  // 거절 뒤 같은 계열이 또 감지돼도 dismissed에는 붙지 않는다 — 새 후보로 1부터
  const c = oneshotOf({ correction: true, rule: '결론을 먼저 쓴다', matches: null });
  await detectAndTrack(WS, { userMsg: '결론 먼저라니까, 다시', oneshotFn: c });
  assert.equal((await listSuggestions(WS)).length, 0, '새 후보 1회째 — 제안 문턱 미달');
});

test('판정 실패·비JSON은 조용히 통과(턴 무영향 원칙)', async () => {
  const bad = { calls: [] };
  const fn = async (p) => { bad.calls.push(p); return '판정을 거부합니다'; };
  assert.equal(await detectAndTrack(WS, { userMsg: '그렇게 하지 마', oneshotFn: fn }), null);
});
