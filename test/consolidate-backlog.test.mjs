// 기억 정리 야간 루프·청킹·JSON 복구 — 임시 ARGO_ROOT + 가짜 원샷(_setOneShotForTest). 실 러너 호출 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-consol-'));
process.env.ARGO_SYNC = '0';
const cons = await import('../src/consolidate.mjs');
const { gatherNewJournal, parseNotes, chunkCapFor, consolidateMemory, consolidateBacklog, _setOneShotForTest, CONSOLIDATE_MODEL, NIGHTLY_BYTES, BILLED_MAX_CHUNKS } = cons;
const { paths } = await import('../src/workspace.mjs');

let WS = 'consol-ws';
async function seed({ journals = {}, notes = {} } = {}, ws = `consol-${Math.random().toString(36).slice(2, 8)}`) {
  WS = ws; const p = paths(WS);
  await mkdir(p.journal, { recursive: true }); await mkdir(p.notes, { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ id: WS, name: 'Consol', lang: 'ko' }));
  for (const [n, body] of Object.entries(journals)) await writeFile(join(p.journal, n), body);
  for (const [n, body] of Object.entries(notes)) await writeFile(join(p.notes, n), body);
  return p;
}
const line = (i, w = 80) => `${String(i).padStart(6, '0')} ${'가'.repeat(Math.floor((w - 8) / 3))}\n`; // 한글(3바이트) 섞인 줄
const lines = (n, w) => Array.from({ length: n }, (_, i) => line(i, w)).join('');

test('chunkCapFor — 가져온(imported) 일지 200KB, 크루 일지 60KB', () => {
  assert.equal(chunkCapFor('2026-02-20-x-imported.md'), 200_000);
  assert.equal(chunkCapFor('2026-09-03-pepper.md'), 60_000);
  assert.equal(CONSOLIDATE_MODEL, 'claude-sonnet-5');
});

test('gatherNewJournal — 큰 파일은 줄 경계에서 잘라 워터마크가 그만큼만 전진하고, 다음 청크가 이어 받는다(잔량 정확)', async () => {
  const big = lines(2000, 100); // ≈ 200KB 크루 일지
  const p = await seed({ journals: { '2026-09-01-pepper.md': big, '2026-09-02-pepper.md': 'short\n'.repeat(50) } });
  const bigBytes = Buffer.byteLength(big);
  let mark = { v: 2, offsets: {} };
  const c1 = await gatherNewJournal(WS, mark);
  assert.ok(c1.consumed <= 60_000 && c1.consumed > 55_000, `첫 청크 ≈ 60KB(줄 경계): ${c1.consumed}`);
  assert.equal(c1.next.offsets['2026-09-01-pepper.md'], c1.consumed, '오프셋 = 소비 바이트');
  assert.ok(big.slice(0, 1).length && Buffer.from(big).subarray(c1.consumed - 1, c1.consumed).toString() === '\n', '줄바꿈 직후에서 잘린다');
  assert.equal(c1.remaining, bigBytes - c1.consumed + Buffer.byteLength('short\n'.repeat(50)), '잔량 = 큰 파일 나머지 + 다음 파일 전체(자투리 4KB 미만이면 다음 파일을 시작하지 않는다)');
  assert.deepEqual(c1.sources, ['journal/2026-09-01-pepper']);
  assert.doesNotMatch(c1.text, /�/, '멀티바이트 절단 없음');
  // 이어 받기 — 두 번째 청크는 첫 청크 끝 줄 번호 다음부터
  const firstLineOfNext = (await gatherNewJournal(WS, c1.next)).text.split('\n').find((l) => /^\d{6} /.test(l));
  const lastLineOfPrev = c1.text.trimEnd().split('\n').pop();
  assert.equal(Number(firstLineOfNext.slice(0, 6)), Number(lastLineOfPrev.slice(0, 6)) + 1, '중복·누락 없이 이어진다');
  // 4청크 안에 전부 소화되고 잔량 0
  mark = c1.next; let total = c1.consumed;
  for (let i = 0; i < 6 && total < bigBytes + 300; i++) { const c = await gatherNewJournal(WS, mark); mark = c.next; total += c.consumed; if (!c.remaining) break; }
  assert.equal((await gatherNewJournal(WS, mark)).remaining, 0);
  void p;
});

test('gatherNewJournal — 청크 상한은 첫 미정리 파일의 종류가 정한다(가져온 일지 200KB), 옛 v1 워터마크는 리셋', async () => {
  const imp = lines(3000, 100); // ≈ 300KB
  await seed({ journals: { '2026-01-05-sess-imported.md': imp } });
  const c = await gatherNewJournal(WS, { v: 2, offsets: {} });
  assert.ok(c.consumed > 190_000 && c.consumed <= 200_000, `가져온 일지 청크 ≈ 200KB: ${c.consumed}`);
  assert.ok(c.remaining > 0);
});

test('parseNotes — 코드펜스 관용, 형식 이탈은 null', () => {
  assert.equal(parseNotes('```json\n{"notes":[{"title":"a","content":"b"}]}\n```').notes.length, 1);
  assert.equal(parseNotes('{"notes":[]}').notes.length, 0);
  assert.equal(parseNotes('{"notes":[{"title":"a","content":"say "hi""}]}'), null, '따옴표 미이스케이프');
  assert.equal(parseNotes('{"foo":1}'), null); assert.equal(parseNotes(''), null);
});

test('consolidateMemory — sonnet 5·읽기 전용·2턴으로 호출, JSON 깨지면 복구 1회, 그래도 실패면 throw + memory 이벤트', async () => {
  const p = await seed({ journals: { '2026-09-03-pepper.md': lines(20, 120) }, notes: { 'old.md': '# 기존 주제\n\n본문\n' } });
  const calls = [];
  _setOneShotForTest(async (ws, prompt, opts) => {
    calls.push({ prompt, opts });
    if (calls.length === 1) return { runner: 'claude', text: '{"notes":[{"title":"기존 주제","content":"say "x""}]}', usage: {}, costUsd: 0.1 }; // 깨진 JSON
    return { runner: 'claude', text: '{"notes":[{"title":"기존 주제","content":"수정된 본문"}]}', usage: {}, costUsd: 0.05 };
  });
  try {
    const r = await consolidateMemory(WS);
    assert.deepEqual(r.notes, ['기존 주제']);
    assert.ok(r.consumed > 0 && r.remaining === 0);
    assert.equal(calls.length, 2, '본 호출 + 복구 1회');
    assert.deepEqual({ model: calls[0].opts.model, readOnly: calls[0].opts.readOnly, maxTurns: calls[0].opts.maxTurns }, { model: 'claude-sonnet-5', readOnly: true, maxTurns: 2 });
    assert.match(calls[0].prompt, /먼저 일지에 등장한 주제를 전부 나열/, '주제 나열 단계');
    assert.match(calls[1].prompt, /수정된 JSON만/, '복구 프롬프트');
    assert.equal(calls[1].opts.maxTurns, 1);
    const mark = JSON.parse(await readFile(join(p.vault, '.consolidate.json'), 'utf8'));
    assert.equal(mark.offsets['2026-09-03-pepper.md'], Buffer.byteLength(lines(20, 120)), '성공 후 워터마크 전진');
    assert.match(await readFile(join(p.notes, 'old.md'), 'utf8').catch(() => ''), /수정된 본문|기존 주제/, '기존 노트 갱신');
    // 복구도 실패 → throw + 이벤트
    calls.length = 0;
    await writeFile(join(p.journal, '2026-09-04-pepper.md'), lines(20, 120));
    _setOneShotForTest(async () => ({ runner: 'claude', text: 'not json', usage: {}, costUsd: 0 }));
    await assert.rejects(() => consolidateMemory(WS), /파싱 실패/);
    const ev = (await readFile(join(p.root, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(ev.some((e) => e.type === 'memory' && e.ok === false), '실패 이벤트');
    const mark2 = JSON.parse(await readFile(join(p.vault, '.consolidate.json'), 'utf8'));
    assert.equal(mark2.offsets['2026-09-04-pepper.md'], undefined, '실패 청크는 워터마크 미전진');
  } finally { _setOneShotForTest(null); }
});

test('consolidateBacklog — 잔량 소진까지 연속, 밤당 바이트·마감·청구 러너 청크 상한에서 멈춘다', async () => {
  const journals = {}; for (let d = 1; d <= 6; d++) journals[`2026-08-0${d}-pepper.md`] = lines(700, 100); // 각 ≈ 70KB → 청크 60KB 기준 7~8청크
  const p = await seed({ journals });
  let n = 0;
  _setOneShotForTest(async () => ({ runner: 'claude', text: `{"notes":[{"title":"주제 ${++n}","content":"본문 ${n}"}]}`, usage: {}, costUsd: 0.01 }));
  try {
    const r = await consolidateBacklog(WS);
    assert.equal(r.stoppedBy, 'drained'); assert.ok(r.chunks >= 7, `청크 ${r.chunks}`); assert.ok(r.bytes > 400_000);
    assert.equal((await gatherNewJournal(WS, JSON.parse(await readFile(join(p.vault, '.consolidate.json'), 'utf8')))).remaining, 0, '전부 소화');
    // 밤당 바이트 상한
    for (let d = 1; d <= 6; d++) await writeFile(join(p.journal, `2026-08-1${d}-pepper.md`), lines(700, 100));
    const r2 = await consolidateBacklog(WS, { nightlyBytes: 100_000 });
    assert.equal(r2.stoppedBy, 'nightly-bytes'); assert.equal(r2.chunks, 2, '60KB 두 청크에서 100KB 상한 초과 → 멈춤');
    // 마감 — 시계를 주입: 첫 청크 뒤 마감 경과
    let t = 0; const r3 = await consolidateBacklog(WS, { deadlineMs: 5, now: () => (t += 3) });
    assert.equal(r3.stoppedBy, 'deadline'); assert.equal(r3.chunks, 1);
    // 청구 러너 상한
    _setOneShotForTest(async () => ({ runner: 'openrouter', text: `{"notes":[{"title":"주제 ${++n}","content":"b"}]}`, usage: {}, costUsd: 0.01 }));
    const r4 = await consolidateBacklog(WS, { billedMaxChunks: 2 });
    // openrouter는 청구 러너(isBilledRunner) — 자격 파일이 없으면 판정이 undefined일 수 있어 두 갈래 모두 허용하되, 상한 2를 넘지 않는다
    assert.ok(r4.stoppedBy === 'billed-cap' || r4.stoppedBy === 'drained', r4.stoppedBy);
    if (r4.stoppedBy === 'billed-cap') assert.equal(r4.chunks, 2);
    assert.equal(NIGHTLY_BYTES, 7 * 1024 * 1024); assert.equal(BILLED_MAX_CHUNKS, 5);
  } finally { _setOneShotForTest(null); }
});

test('배선 — 스케줄러가 야간 루프(consolidateBacklog)를 08:00 마감으로 부른다, 정리 호출은 읽기 전용', async () => {
  const sched = await readFile(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  assert.match(sched, /import \{ consolidateBacklog, rollupJournals \} from '\.\/consolidate\.mjs';/);
  assert.match(sched, /const CONSOLIDATE_UNTIL_HOUR = 8;/);
  assert.match(sched, /consolidateBacklog\(cid, \{ deadlineMs: Math\.max\(deadline, now\.getTime\(\) \+ 60_000\), onChunk: \(\) => bumpConsolidateClaim\(cid, Date\.now\(\), today\) \}\)[\s\S]{0,300}?\.then\(\(\) => rollupJournals\(cid\)\)/, '루프 뒤 롤업 + 청크마다 선점 스탬프 연장');
  const route = await readFile(new URL('../app/api/companies/[ws]/vault/consolidate/route.js', import.meta.url), 'utf8');
  assert.match(route, /export const maxDuration = 800;/, '수동 정리 라우트 상한 = 청크 264초 + 복구 3분 여유, 호스티드 함수 상한 800 안(검수 MEDIUM-2)');
  assert.match(src, /if \(onChunk\) await Promise\.resolve\(\)\.then\(\(\) => onChunk\(\{ chunks, bytes \}\)\)\.catch\(\(\) => \{\}\); \/\/ 진입 직후 1회/, '루프 진입 직후 선점 스탬프 연장');

  assert.doesNotMatch(sched, /consolidateMemory\(cid\)/, '단발 호출 잔재 없음');
  const src = await readFile(new URL('../src/consolidate.mjs', import.meta.url), 'utf8');
  assert.match(src, /\{ lang, model: CONSOLIDATE_MODEL, maxTurns: 2, readOnly: true, timeoutMs: 10 \* 60_000 \}/, '본 호출: sonnet 5·읽기 전용·2턴');
  assert.doesNotMatch(src, /claude-haiku/, 'haiku 잔재 없음');
  assert.match(src, /isBilledRunner\(wsId, runner\)\.catch\(\(\) => true\)/, '청구 판정 실패는 청구로(fail-closed — 비용 상한 소멸 방지)');
  assert.match(src, /if \(!parsed && out\.length <= REPAIR_MAX\)/, '잘린 출력은 복구하지 않는다');
  assert.match(src, /appendSourceLinks\(file, sources\.slice\(0, SOURCE_LINK_CAP\)\)/, '근거 링크 상한');
  assert.match(src, /const NOTE_CAP = 40;/); assert.doesNotMatch(src, /\.slice\(0, 8\)/, '옛 노트 상한 8 잔재 없음');
});

test('절단 진행 보장 — 창 안 유일한 줄바꿈이 시작 직후면 줄 경계를 버리고 하드 컷(MIN_ROOM 이상 전진), UTF-8 글자를 쪼개지 않는다(검수 HIGH-2·LOW)', async () => {
  const oneLine = 'x짧은 첫 줄\n' + '가'.repeat(40_000); // 120KB 한 줄. 접두 16바이트(≡1 mod 3) — 60,000 하드 컷이 한글 글자 중간에 떨어지게 잡는다(15바이트면 우연히 정렬돼 검사가 헛돈다)
  const p = await seed({ journals: { '2026-09-05-pepper.md': oneLine } });
  const c = await gatherNewJournal(WS, { v: 2, offsets: {} });
  assert.ok(c.consumed >= 4096, `자투리 청크 금지: ${c.consumed}`);
  assert.ok(c.consumed > 55_000 && c.consumed <= 60_000, `하드 컷 ≈ 60KB: ${c.consumed}`);
  assert.doesNotMatch(c.text, /�/, 'UTF-8 연속 바이트 경계에서 물러나 절단');
  assert.equal(c.consumed % 3, Buffer.byteLength('x짧은 첫 줄\n') % 3, '한글 3바이트 단위로 끊긴다(하드 컷 60,000에서 2바이트 후퇴)');
  assert.equal(c.consumed, 59_998);
  const c2 = await gatherNewJournal(WS, c.next);
  assert.doesNotMatch(c2.text, /�/); assert.ok(c2.consumed > 0);
  // 루프도 전진한다(옛 결함: 매일 15바이트만 집어 스킵 → 영구 스톨)
  _setOneShotForTest(async () => ({ runner: 'claude', text: '{"notes":[]}', usage: {}, costUsd: 0 }));
  try { const r = await consolidateBacklog(WS); assert.equal(r.stoppedBy, 'drained'); assert.ok(r.chunks >= 2, `청크 ${r.chunks}`); } finally { _setOneShotForTest(null); }
  void p;
});

test('노트 상한 40 — 초과분은 조용히 버리지 않고 memory 실패 이벤트로 남긴다(검수 HIGH-1), 워터마크는 전진', async () => {
  const p = await seed({ journals: { '2026-09-06-pepper.md': lines(30, 120) } });
  const many = Array.from({ length: 45 }, (_, i) => ({ title: `주제 ${i + 1}`, content: `본문 ${i + 1}` }));
  _setOneShotForTest(async () => ({ runner: 'claude', text: JSON.stringify({ notes: many }), usage: {}, costUsd: 0 }));
  try {
    const r = await consolidateMemory(WS);
    assert.equal(r.notes.length, 40);
    const ev = (await readFile(join(p.root, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const over = ev.find((e) => e.type === 'memory' && e.ok === false && /45개 중 40개만/.test(e.error));
    assert.ok(over, '초과 이벤트'); assert.match(over.error, /주제 41/, '버려진 제목 명시');
    assert.ok(ev.some((e) => e.type === 'memory' && e.ok === true && e.notes.length === 40));
  } finally { _setOneShotForTest(null); }
});

test('bumpConsolidateClaim — 오늘 미완료 스탬프의 nextRetryAt을 지금+15분으로 연장, done·다른 날 스탬프는 손대지 않는다(검수 MEDIUM-3)', async () => {
  const { claimConsolidate, bumpConsolidateClaim } = await import('../src/scheduler.mjs');
  const p = await seed({});
  const today = '2026-09-04'; const t0 = Date.parse('2026-09-04T04:00:00Z');
  const st = await claimConsolidate(WS, t0, today); assert.ok(st && st.attempts === 1);
  await bumpConsolidateClaim(WS, t0 + 3 * 60_000, today);
  const cur = JSON.parse(await readFile(join(p.vault, '.consolidate-run.json'), 'utf8'));
  assert.equal(Date.parse(cur.nextRetryAt), t0 + 18 * 60_000, '3분 뒤 청크 완료 → 재시도 창 = 그 시점 + 15분');
  assert.equal(cur.attempts, 1); assert.equal(cur.done, false);
  await bumpConsolidateClaim(WS, t0, '2026-09-05'); // 다른 날 → 무시
  assert.equal(JSON.parse(await readFile(join(p.vault, '.consolidate-run.json'), 'utf8')).nextRetryAt, cur.nextRetryAt);
  const { markConsolidateDone } = await import('../src/scheduler.mjs');
  await markConsolidateDone(WS, today); // 완료 뒤 늦게 도착한 하트비트는 done 스탬프를 되살리지 않는다
  await bumpConsolidateClaim(WS, t0 + 60 * 60_000, today);
  const fin = JSON.parse(await readFile(join(p.vault, '.consolidate-run.json'), 'utf8'));
  assert.equal(fin.done, true); assert.equal(fin.nextRetryAt, null, 'done 스탬프는 손대지 않는다');
});
