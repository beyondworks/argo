// 루틴 완료 조건(verify) — "다 됐어요"를 산출물로 증명해야 완료(리서치 접목 A: Stop Hook의 제품화).
// 정규화·경로 게이트·재시도 배선·정직 실패를 임시 ARGO_ROOT에서 잠근다. chat은 chatFn 주입.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-verify-'));
const { normalizeVerify, checkVerify, verifyRetryPrompt, addRoutine, runRoutine, loadRoutines, updateRoutine } = await import('../src/routines.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');

const WS = 'verico';
await createCompany(WS, '검증사', 'captain');
await mkdir(join(process.env.ARGO_ROOT, WS, 'agents', 'alpha'), { recursive: true });
const VAULT = paths(WS).vault;

const byId = async (id) => (await loadRoutines(WS)).find((r) => r.id === id);
/** replies: 각 턴의 { reply, make?: [상대경로, 내용] } — make가 있으면 그 턴에서 산출물을 만든다(크루가 일한 것). */
const fakeChat = (replies) => {
  const calls = [];
  const fn = async (_ws, _slug, userMsg) => {
    calls.push(userMsg);
    const r = replies.shift() ?? { reply: 'ok' };
    if (r.make) await writeFile(join(VAULT, r.make[0]), r.make[1] ?? 'x', 'utf8');
    return { reply: r.reply ?? 'ok', handover: null, sessionId: null, costUsd: null };
  };
  fn.calls = calls;
  return fn;
};
const mkDaily = (verify) => addRoutine(WS, { agentSlug: 'alpha', title: '주간 보고', prompt: '보고서를 작성하라', schedule: { type: 'daily', times: ['09:00'] }, verify });

test('normalizeVerify: 파싱·중복 제거·클램프·빈 입력 null', () => {
  const v = normalizeVerify({ files: [' notes/a.md ', 'notes/a.md', './b.md'], contains: '  ## 결론  ', retries: 99 });
  assert.deepEqual(v, { files: ['notes/a.md', 'b.md'], contains: '## 결론', retries: 3 });
  assert.equal(normalizeVerify(null), null);
  assert.equal(normalizeVerify({ files: [] }), null);
  assert.equal(normalizeVerify({ contains: '문구만' }), null, '파일 없이 문구만으로는 조건이 성립하지 않는다');
  assert.equal(normalizeVerify({ files: ['a.md'] }).retries, 2, '재시도 기본 2');
});

test('normalizeVerify: 절대경로·상위 탈출·과다 개수 거부', () => {
  assert.throws(() => normalizeVerify({ files: ['/etc/passwd'] }));
  assert.throws(() => normalizeVerify({ files: ['C:/win.ini'] }));
  assert.throws(() => normalizeVerify({ files: ['../밖의파일.md'] }));
  assert.throws(() => normalizeVerify({ files: ['a/../../b.md'] }));
  assert.throws(() => normalizeVerify({ files: ['1.md', '2.md', '3.md', '4.md', '5.md', '6.md'] }));
});

test('checkVerify: 필수 문구는 모든 파일에 적용된다 (검수 M3 핀)', async () => {
  await writeFile(join(VAULT, 'm3-a.md'), '문구 있음: NEEDLE', 'utf8');
  await writeFile(join(VAULT, 'm3-b.md'), '문구 없음', 'utf8');
  const r = await checkVerify(WS, { files: ['m3-a.md', 'm3-b.md'], contains: 'NEEDLE' });
  assert.equal(r.ok, false, '두 번째 파일에 문구가 없으면 실패해야 한다 — 첫 파일 한정이면 touch만으로 충족되는 구멍');
  assert.ok(r.failures.some((f) => f.includes('m3-b.md')));
});

test('checkVerify: vault 안 심볼릭 링크가 밖을 가리키면 따라가지 않는다 (검수 M2 핀)', async () => {
  const { symlink } = await import('node:fs/promises');
  const outside = join(tmpdir(), `argo-verify-outside-${Date.now()}.txt`);
  await writeFile(outside, 'SECRET-NEEDLE', 'utf8');
  await symlink(outside, join(VAULT, 'link-out.md'));
  const r = await checkVerify(WS, { files: ['link-out.md'], contains: 'SECRET-NEEDLE' });
  assert.equal(r.ok, false, '심링크로 게이트를 우회해 조건을 충족시키면 안 된다');
  assert.ok(r.failures.some((f) => f.includes('검사 불가') || f.includes('not checked')));
});

test('runRoutine: 영어 회사는 재시도 지시·실패 사유가 영어로 나간다 (검수 M1 핀)', async () => {
  const { writeFile: wf, readFile: rf } = await import('node:fs/promises');
  const compFile = join(process.env.ARGO_ROOT, WS, 'company.json');
  const comp = JSON.parse(await rf(compFile, 'utf8'));
  await wf(compFile, JSON.stringify({ ...comp, lang: 'en' }), 'utf8');
  try {
    const r = await mkDaily({ files: ['en-only-missing.md'], retries: 1 });
    const chatFn = fakeChat([{ reply: 'done' }, { reply: 'still just words' }]);
    await assert.rejects(() => runRoutine(WS, r.id, { chatFn }), /Completion check failed after 2 attempt/);
    assert.ok(/Completion check failed \(attempt 2\)/.test(chatFn.calls[1]), '재시도 지시가 영어여야 크루가 영어로 일한다');
    assert.ok(!/완료 조건/.test(chatFn.calls[1]), '영어 회사에 한국어 지시가 섞이면 안 된다');
  } finally {
    await wf(compFile, JSON.stringify(comp), 'utf8');
  }
});

test('checkVerify: 존재·문구·부재 사유, 오염된 저장값의 탈출 경로는 읽지 않는다', async () => {
  await writeFile(join(VAULT, '존재.md'), '# 제목\n## 결론\n내용', 'utf8');
  assert.equal((await checkVerify(WS, { files: ['존재.md'], contains: '## 결론' })).ok, true);
  const miss = await checkVerify(WS, { files: ['존재.md', '없는파일.md'], contains: '없는 문구' });
  assert.equal(miss.ok, false);
  assert.ok(miss.failures.some((f) => f.includes('없는파일.md')), '부재 파일이 사유에 명시된다');
  assert.ok(miss.failures.some((f) => f.includes('없는 문구')), '문구 미포함이 사유에 명시된다');
  // normalize를 우회한 오염 저장값 — resolve 후 루트 재검사가 마지막 방어선
  const esc = await checkVerify(WS, { files: ['../../밖.md'] });
  assert.equal(esc.ok, false);
  assert.ok(esc.failures.some((f) => f.includes('검사 불가') || f.includes('not checked')), 'vault 밖은 읽지 않고 검사 불가로 실패 처리');
});

test('runRoutine: 미충족 → 실패 목록을 들려 재시도 → 산출물 생기면 성공', async () => {
  const r = await mkDaily({ files: ['산출/보고.md'], retries: 2 });
  await mkdir(join(VAULT, '산출'), { recursive: true });
  const chatFn = fakeChat([
    { reply: '다 했습니다' },                                  // 1차 — 실제로는 아무것도 안 만듦
    { reply: '이제 진짜 만들었습니다', make: ['산출/보고.md', '# 보고'] }, // 재시도 1차에 산출물 생성
  ]);
  const out = await runRoutine(WS, r.id, { chatFn });
  assert.equal(out.ok, true);
  assert.equal(chatFn.calls.length, 2, '최초 1 + 재시도 1');
  assert.ok(chatFn.calls[1].includes('산출/보고.md'), '재시도 프롬프트에 실패 파일이 명시된다');
  assert.ok(/완료 조건 미충족|Completion check/.test(chatFn.calls[1]), '재시도 프롬프트가 조건 미충족을 알린다');
  assert.equal((await byId(r.id)).lastOk, true);
});

test('runRoutine: 끝내 미충족 → 정직한 실패(lastOk=false, 시도 횟수·사유)', async () => {
  const r = await mkDaily({ files: ['산출/영영없는.md'], retries: 1 });
  const chatFn = fakeChat([{ reply: '다 했습니다' }, { reply: '또 다 했다고만 말함' }]);
  await assert.rejects(() => runRoutine(WS, r.id, { chatFn }), /완료 조건 미충족\(2회 시도\)/);
  const saved = await byId(r.id);
  assert.equal(saved.lastOk, false);
  assert.ok(saved.lastResult.includes('영영없는.md'), '실패 사유에 어떤 산출물이 비었는지 남는다');
  assert.equal(chatFn.calls.length, 2, '최초 1 + retries 1 — 그 이상 태우지 않는다');
});

test('runRoutine: 오염된 저장 조건은 LLM 비용을 쓰기 전에 루틴 제목과 함께 실패한다 (검수 LOW-2 핀)', async () => {
  const r = await mkDaily({ files: ['정상.md'] });
  // 저장 후 파일을 직접 오염 — API 정규화를 지나쳐 들어온 값(구버전 동기화·손상)을 재현
  const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
  const routinesFile = join(process.env.ARGO_ROOT, WS, 'routines.json');
  const all = JSON.parse(await rf(routinesFile, 'utf8'));
  all.find((x) => x.id === r.id).verify = { files: ['../밖.md'], retries: 2 };
  await wf(routinesFile, JSON.stringify(all), 'utf8');
  const chatFn = fakeChat([{ reply: '호출되면 안 됨' }]);
  await assert.rejects(() => runRoutine(WS, r.id, { chatFn }), /주간 보고.*완료 조건 설정 오류/);
  assert.equal(chatFn.calls.length, 0, '설정 오류는 chat 전에 실패 — LLM 비용 0');
});

test('runRoutine: 조건 없는 루틴은 종전과 동일(추가 턴 0)', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '무조건', prompt: '그냥 하라', schedule: { type: 'daily', times: ['09:00'] } });
  const chatFn = fakeChat([{ reply: '했음' }]);
  const out = await runRoutine(WS, r.id, { chatFn });
  assert.equal(out.ok, true);
  assert.equal(chatFn.calls.length, 1);
});

test('interval(자율 루프)에는 verify가 붙지 않는다 — add·update 모두', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '루프', prompt: '반복', schedule: { type: 'interval', everyMinutes: 30 }, verify: { files: ['a.md'] } });
  assert.equal((await byId(r.id)).verify, undefined, 'add: interval이면 verify를 버린다');
  const d = await mkDaily({ files: ['b.md'] });
  assert.ok((await byId(d.id)).verify, '전제: daily엔 저장됨');
  await updateRoutine(WS, d.id, { schedule: { type: 'interval', everyMinutes: 30 } });
  assert.equal((await byId(d.id)).verify ?? null, null, 'update: interval로 바꾸면 기존 조건도 비운다');
});

test('verifyRetryPrompt: 실패 목록·원 지시가 실리고 조건 완화 금지를 명시한다', () => {
  const msg = verifyRetryPrompt({ title: 'T', prompt: 'P' }, ['x.md: 파일 없음'], 2, 'ko');
  assert.ok(msg.includes('x.md: 파일 없음'));
  assert.ok(msg.includes('P'));
  assert.ok(msg.includes('완화하거나 재해석하지 말고'));
});
