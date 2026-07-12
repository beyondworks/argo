// 회귀 테스트 — 가장 위험한 로직(데이터 유실·동기화 충돌·리스·페어링)에 방어선을 친다.
// 실행: npm test (node --test). 외부 의존 없이 순수·파일 단위만 검증(Supabase·SDK 미호출).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic, readJson, readJsonLenient } from '../src/jsonstore.mjs';
import { mergeLedger, isLedger, isText, isThread } from '../src/sync.mjs';
import { isDue } from '../src/routines.mjs';
import { createPairing, bindPairing, claimPairing } from '../app/api/auth/pair/store.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'argo-test-'));

/* ── jsonstore: 원자성·손상 안전 (D1) ── */
test('writeJsonAtomic 왕복', async () => {
  const d = await tmp();
  const f = join(d, 'x.json');
  await writeJsonAtomic(f, { a: 1, ko: '한글' });
  assert.deepEqual(await readJson(f, {}), { a: 1, ko: '한글' });
  await rm(d, { recursive: true, force: true });
});

test('readJson: ENOENT는 fallback, 손상은 throw+백업', async () => {
  const d = await tmp();
  const f = join(d, 'x.json');
  // 부재 → fallback
  assert.deepEqual(await readJson(f, { seed: true }), { seed: true });
  // 손상 → throw + .corrupt 백업 (조용한 리셋 금지)
  await writeFile(f, '{ broken json');
  await assert.rejects(() => readJson(f, {}), (e) => e.corrupt === true);
  const names = await readdir(d);
  assert.ok(names.some((n) => n.includes('.corrupt-')), '손상 파일이 .corrupt로 백업되어야 함');
  // 원본은 치워졌다(다음 로드는 fallback) — 하지만 데이터는 백업에 살아있음
  await rm(d, { recursive: true, force: true });
});

test('readJsonLenient: 손상도 fallback으로 관용(캐시성)', async () => {
  const d = await tmp();
  const f = join(d, 's.json');
  await writeFile(f, 'not json');
  assert.deepEqual(await readJsonLenient(f, { x: 0 }), { x: 0 });
  await rm(d, { recursive: true, force: true });
});

test('writeJsonAtomic는 부분쓰기로 원본을 오염시키지 않는다(rename 원자성)', async () => {
  const d = await tmp();
  const f = join(d, 'x.json');
  await writeJsonAtomic(f, { v: 1 });
  // 동시에 여러 번 써도 항상 완전한 JSON (tmp→rename이라 중간상태 노출 없음)
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(f, { v: i })));
  const parsed = JSON.parse(await readFile(f, 'utf8')); // 파싱 실패 없어야 함
  assert.equal(typeof parsed.v, 'number');
  await rm(d, { recursive: true, force: true });
});

/* ── sync: 원장 병합·파일 분류 (D2/D3) ── */
test('mergeLedger: 두 기기 append 행 합집합(유실 없음)', () => {
  const a = Buffer.from('{"t":1}\n{"t":2}\n');
  const b = Buffer.from('{"t":1}\n{"t":3}\n'); // t:1 공통, t:2/t:3 각자
  const m = mergeLedger(a, b).toString().trim().split('\n');
  assert.equal(m.length, 3, '공통 1 + 각자 1씩 = 3행');
  assert.ok(m.includes('{"t":2}') && m.includes('{"t":3}'), '양쪽 고유 행 보존');
});

test('mergeLedger: 빈 입력 안전', () => {
  assert.equal(mergeLedger(Buffer.from(''), Buffer.from('')).length, 0);
  assert.equal(mergeLedger(Buffer.from('{"a":1}\n'), Buffer.from('')).toString().trim(), '{"a":1}');
});

test('파일 분류', () => {
  assert.ok(isLedger('usage.jsonl') && isLedger('events.jsonl'));
  assert.ok(!isLedger('company.json'));
  assert.ok(isText('vault/notes/x.md') && !isText('x.json'));
  assert.ok(isThread('chats/seo-jihyun.json') && !isThread('chats/.archive/x.json') && !isThread('company.json'));
});

/* ── routines: 이중 실행 방지 dedup (스케줄러) ── */
test('isDue: 시각 일치 + 같은 분 재실행 차단', () => {
  const now = new Date('2026-07-12T09:00:30');
  const base = { enabled: true, schedule: { type: 'daily', time: '09:00' } };
  assert.equal(isDue(base, now), true, '09:00에 실행');
  assert.equal(isDue({ ...base, schedule: { type: 'daily', time: '09:01' } }, now), false, '다른 분 아님');
  assert.equal(isDue({ ...base, enabled: false }, now), false, '비활성');
  // 이미 이 분에 실행됨 → 차단(이중 과금 방지)
  assert.equal(isDue({ ...base, lastRun: now.toISOString() }, now), false, '같은 분 재실행 차단');
});

test('isDue: 주간은 요일까지', () => {
  const sun = new Date('2026-07-12T17:00:10'); // 일요일
  const wk = { enabled: true, schedule: { type: 'weekly', time: '17:00', dow: 5 } }; // 금요일
  assert.equal(isDue(wk, sun), false, '금요일 아님');
  assert.equal(isDue({ ...wk, schedule: { ...wk.schedule, dow: 0 } }, sun), true, '일요일 일치');
});

/* ── 페어링: verifier로 세션 탈취 차단 (L2 보안) ── */
test('claimPairing: verifier 불일치는 회수 불가(탈취 차단)', () => {
  createPairing('code-abc', 'verifier-xyz');
  bindPairing('code-abc', { access_token: 'A', refresh_token: 'R' });
  // 코드만 아는 공격자(verifier 모름) → expired로 숨김
  assert.equal(claimPairing('code-abc', 'wrong-verifier').status, 'expired');
  // 정당한 앱(verifier 일치) → 회수 성공
  const ok = claimPairing('code-abc', 'verifier-xyz');
  assert.equal(ok.status, 'ready');
  assert.equal(ok.session.access_token, 'A');
  // 1회 소비 후 재회수 불가
  assert.equal(claimPairing('code-abc', 'verifier-xyz').status, 'expired');
});

test('claimPairing: 봉인 전엔 pending', () => {
  createPairing('code-2', 'ver-2');
  assert.equal(claimPairing('code-2', 'ver-2').status, 'pending');
});
