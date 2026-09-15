// 턴 산출물 귀속(제보 2026-09-15 "보고에 다른 크루가 만든 파일명이 보인다") — diff는 vault 전체라 겹쳐 도는 다른 크루의 파일이
// 이 턴 칩에 붙었다(compete만 예외). ① 순수 귀속 ② 장부 겹침 판정 ③ 실제 임시 vault에서 두 턴을 겹쳐 돌린 행동 ④ chat.mjs 배선 핀.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotArtifacts, diffArtifacts, servableArtifact, openTurnLedger, closeTurnLedger, overlappingTurns, attributeArtifacts } from '../src/artifacts.mjs';

const entry = (observed = [], startedAt = 0, endedAt = null) => ({ slug: 'x', startedAt, endedAt, observed: new Set(observed) });

test('순수 귀속: 겹침 없음 → 전체 diff 그대로(종전 동작 유지)', () => {
  assert.deepEqual(attributeArtifacts(['projects/a.md', 'files/b.xlsx'], { entry: entry(), others: [], reply: '' }), ['projects/a.md', 'files/b.xlsx']);
});
test('순수 귀속: 겹침 있음 → 내 도구 관측 ∪ 답변에 경로 언급만 남고, 다른 턴 관측·주인 모를 파일은 빠진다', () => {
  const me = entry(['projects/mine.md']); const other = entry(['projects/theirs.md']);
  const changed = ['projects/mine.md', 'projects/theirs.md', 'projects/cli-made.md', 'files/orphan.pdf'];
  assert.deepEqual(attributeArtifacts(changed, { entry: me, others: [other], reply: '보고서는 vault/projects/cli-made.md 에 두었습니다' }), ['projects/mine.md', 'projects/cli-made.md']);
  // 다른 턴이 관측한 파일은 내 답변이 언급해도(읽고 인용한 경우) 내 것이 아니다 — 제보의 바로 그 자리
  assert.deepEqual(attributeArtifacts(changed, { entry: me, others: [other], reply: '참고: projects/theirs.md' }), ['projects/mine.md']);
  // 파일명만 언급은 귀속 근거가 아니다(다른 크루 파일을 인용한 문장과 구분 불가) — 상대 경로 문자열만
  assert.deepEqual(attributeArtifacts(['projects/x/report.md'], { entry: entry(), others: [other], reply: 'report.md 참고' }), []);
});
test('장부: 겹침 판정은 시간 구간 교집합 — 먼저 끝난 턴도 뒤 턴이 볼 수 있게 남고, 30분 지나면 청소', () => {
  const book = new Map(); let t = 0; const now = () => t;
  const A = openTurnLedger('ws', 'a', { now, book }); t = 5; const B = openTurnLedger('ws', 'b', { now, book });
  t = 10; closeTurnLedger(A, { now });
  assert.deepEqual(overlappingTurns('ws', A, { now, book }).map((e) => e.slug), ['b'], 'A(0~10)는 B(5~)와 겹친다');
  t = 12; closeTurnLedger(B, { now });
  assert.deepEqual(overlappingTurns('ws', B, { now, book }).map((e) => e.slug), ['a'], '뒤에 끝난 B도 먼저 끝난 A를 본다');
  t = 20; const C = openTurnLedger('ws', 'c', { now, book });
  assert.deepEqual(overlappingTurns('ws', C, { now, book }), [], 'C(20~)는 끝난 A·B와 안 겹친다');
  assert.deepEqual(overlappingTurns('ws-other', C, { now, book }), [], '회사가 다르면 무관');
  t = 20 + 31 * 60_000; openTurnLedger('ws', 'd', { now, book });
  assert.deepEqual([...book.get('ws')].map((e) => e.slug).sort(), ['c', 'd'], '30분 지난 끝난 턴은 청소, 진행 중(C)은 유지');
  closeTurnLedger(C, { now }); closeTurnLedger(C, { now }); assert.equal(C.endedAt, t, 'close는 멱등(첫 시각 유지)');
});
test('장부: 같은 논리 턴의 프레임(재시도 — 같은 control 객체)은 겹침이 아니지만, 같은 크루의 동시 턴(다른 control)은 겹침이다(검수 HIGH-1·재검수 MED-1)', () => {
  const book = new Map(); let t = 0; const now = () => t; const control = {};
  const outer = openTurnLedger('ws', 'a', { now, book, frame: control }); outer.observed.add('projects/x.md');
  t = 1; const inner = openTurnLedger('ws', 'a', { now, book, frame: control });
  assert.deepEqual(overlappingTurns('ws', inner, { now, book }), [], '같은 control = 재시도 프레임 → 겹침 아님, 바깥 관측이 foreign이 되지 않는다');
  const routine = openTurnLedger('ws', 'a', { now, book }); // 같은 크루의 루틴·쪽지·DM 동시 턴 — 새 control
  assert.deepEqual(overlappingTurns('ws', inner, { now, book }), [routine], '같은 크루라도 다른 프레임은 겹침');
  const other = openTurnLedger('ws', 'b', { now, book });
  assert.deepEqual(overlappingTurns('ws', inner, { now, book }).map((e) => e.slug).sort(), ['a', 'b']);
  assert.deepEqual(overlappingTurns('ws', null, { now, book }), [], 'entry 없음 = 겹침 없음(턴을 죽이지 않는다 — 재검수 L-2)');
  void other;
});
test('장부: 6시간 넘게 열린 항목은 죽은 턴 — 열 때 청소되고, 청소 없이 남아 있어도 겹침에서 제외된다(검수 HIGH-2·재검수 L-1)', () => {
  const book = new Map(); let t = 0; const now = () => t;
  openTurnLedger('ws', 'stale', { now, book });
  t = 7 * 3_600_000;
  const probe = { slug: 'p', startedAt: t, endedAt: null, observed: new Set() }; probe.frame = probe; book.get('ws').add(probe); // 청소를 거치지 않은 직접 주입
  assert.deepEqual(overlappingTurns('ws', probe, { now, book }), [], '필터 단독으로 죽은 항목 제외');
  const late = openTurnLedger('ws', 'c', { now, book });
  assert.deepEqual([...book.get('ws')].map((e) => e.slug).sort(), ['c', 'p'], '열 때 죽은 항목 청소, 살아 있는 항목 유지');
  assert.deepEqual(overlappingTurns('ws', late, { now, book }).map((e) => e.slug), ['p']);
});
test('행동: 임시 vault에서 두 턴이 겹쳐 돌면 각자 파일만 — SDK 턴(도구 관측)과 CLI 턴(답변 경로 언급) 둘 다', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'argo-attrib-'));
  await mkdir(join(vault, 'projects', '20260915_x'), { recursive: true });
  const book = new Map(); let t = 1_000; const now = () => t;
  const beforeA = await snapshotArtifacts(vault); const A = openTurnLedger('ws', 'a', { now, book });
  t += 1; const beforeB = await snapshotArtifacts(vault); const B = openTurnLedger('ws', 'b', { now, book });
  await writeFile(join(vault, 'projects', '20260915_x', 'a-report.md'), 'A'); A.observed.add('projects/20260915_x/a-report.md'); // SDK 턴: Write 관측
  await writeFile(join(vault, 'projects', '20260915_x', 'b-plan.md'), 'B'); // CLI 턴: 관측 없음, 답변에 경로만
  await writeFile(join(vault, 'projects', '20260915_x', 'nobody.md'), '?'); // 주인 모름(둘 다 관측·언급 없음)
  t += 1; closeTurnLedger(A, { now });
  const changedA = diffArtifacts(beforeA, await snapshotArtifacts(vault)).filter(servableArtifact);
  assert.deepEqual(attributeArtifacts(changedA, { entry: A, others: overlappingTurns('ws', A, { now, book }), reply: '끝났습니다.' }), ['projects/20260915_x/a-report.md']);
  t += 1; closeTurnLedger(B, { now });
  const changedB = diffArtifacts(beforeB, await snapshotArtifacts(vault)).filter(servableArtifact);
  assert.deepEqual(attributeArtifacts(changedB, { entry: B, others: overlappingTurns('ws', B, { now, book }), reply: '계획은 vault/projects/20260915_x/b-plan.md 에 있습니다' }), ['projects/20260915_x/b-plan.md']);
  // 겹침이 없는 뒤 턴은 종전처럼 전체 diff(회귀 없음)
  t += 100; const beforeC = await snapshotArtifacts(vault); const C = openTurnLedger('ws', 'c', { now, book });
  await writeFile(join(vault, 'projects', '20260915_x', 'c-solo.md'), 'C'); t += 1; closeTurnLedger(C, { now });
  const changedC = diffArtifacts(beforeC, await snapshotArtifacts(vault)).filter(servableArtifact);
  assert.deepEqual(attributeArtifacts(changedC, { entry: C, others: overlappingTurns('ws', C, { now, book }), reply: '' }), ['projects/20260915_x/c-solo.md']);
});
test('배선 핀: chat.mjs — 장부는 스냅샷과 함께 열리고, artDiff는 두 반환부에서 답변을 받으며, 두 finally가 장부를 닫고, SDK Write 관측이 장부에 실린다 + 프롬프트 규칙 ko/en', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /let ledgerEntry = null; const ledgerStartedAt = Date\.now\(\);/, '항목 변수는 함수 스코프, 시작 시각은 스냅샷 시각');
  assert.equal((src.match(/ledgerEntry = openTurnLedger\(wsId, agentSlug, \{ startedAt: ledgerStartedAt, frame: __turnControl \?\? null \}\);/g) ?? []).length, 2, 'CLI·SDK 두 try 안에서 연다(준비 단계가 던지면 항목이 안 생긴다 — HIGH-2)');
  for (const m of src.matchAll(/ledgerEntry = openTurnLedger\(/g)) assert.match(src.slice(Math.max(0, m.index - 80), m.index), /try \{\n\s*$/, '열기 직전 줄이 try {');
  assert.equal((src.match(/await artDiff\(reply\)/g) ?? []).length, 2, 'CLI·SDK 두 반환부 모두 답변을 넘긴다');
  assert.equal((src.match(/closeTurnLedger\(ledgerEntry\)/g) ?? []).length, 3, 'artDiff 안 1 + finally 2');
  assert.match(src, /artifacts\.add\(rel\); ledgerEntry\?\.observed\.add\(rel\);/, 'SDK Write/Edit 관측 → 장부');
  assert.match(src, /attributeArtifacts\(changed, \{ entry: ledgerEntry, others: overlappingTurns\(wsId, ledgerEntry\), reply \}\)/, '귀속 호출');
  assert.match(src, /보고의 산출물에는 이번 지시로 네가 만들거나 고친 파일만 적어라/, 'ko 규칙'); assert.match(src, /list as deliverables only the files you created or changed for this instruction/, 'en 규칙');
});
