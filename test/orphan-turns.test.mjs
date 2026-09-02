// 고아 턴 스위퍼 — 서버가 턴 도중 죽어 awaiting으로 남은 지시를 정직한 실패 표시로 전환하는 계약.
// 실사고 2026-08-28: 상주 재배포가 실행 중 턴을 죽여 응답·실패기록·이벤트가 전부 없었다(무언 소멸).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-orphan-'));
process.env.ARGO_ROOT = ROOT;
const { sweepOrphanTurns } = await import('../src/orphan-turns.mjs');

const mkCompany = async (ws, lang = 'ko') => {
  await mkdir(join(ROOT, ws, 'chats'), { recursive: true });
  await writeFile(join(ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: 'T', owner: 'me', lang, created: new Date().toISOString() }));
};
const thread = (msgs) => JSON.stringify({ schema: 1, messages: msgs });
const readThread = async (ws, slug) => JSON.parse(await readFile(join(ROOT, ws, 'chats', `${slug}.json`), 'utf8'));

test('고아 awaiting 지시 → failed 표시 전환(awaiting 제거·재전송 유도 문구)', async () => {
  await mkCompany('w1');
  const old = Date.now() - 10 * 60_000;
  await writeFile(join(ROOT, 'w1', 'chats', 'pepper.json'), thread([
    { who: 'user', text: '이전 정상 지시', ts: old - 1000 },
    { who: 'crew', text: '정상 답', ts: old - 900 },
    { who: 'user', text: '죽은 턴 지시', ts: old, turnId: 't1-abc', awaiting: true },
  ]));
  const n = await sweepOrphanTurns();
  assert.equal(n, 1);
  const t = await readThread('w1', 'pepper');
  const m = t.messages[2];
  assert.equal(m.awaiting, undefined, 'awaiting 해제');
  assert.match(m.failed, /서버가 재시작되어 중단/, '정직한 사유');
  assert.equal(t.messages[0].failed, undefined, '정상 메시지는 무접촉');
});

test('신선한 상태 파일(다른 프로세스 실행 중)·방금 지시는 건너뛴다', async () => {
  await mkCompany('w2');
  const old = Date.now() - 10 * 60_000;
  // (a) 신선한 status — 다른 프로세스가 돌리는 중일 수 있다
  await writeFile(join(ROOT, 'w2', 'chats', 'busy.json'), thread([{ who: 'user', text: 'x', ts: old, turnId: 't2', awaiting: true }]));
  await writeFile(join(ROOT, 'w2', 'chats', 'busy.status.json'), JSON.stringify({ stage: 'shell', ts: Date.now(), startedAt: Date.now() }));
  // (b) 방금 도착한 지시(60초 미만)
  await writeFile(join(ROOT, 'w2', 'chats', 'fresh.json'), thread([{ who: 'user', text: 'y', ts: Date.now() - 5000, turnId: 't3', awaiting: true }]));
  const n = await sweepOrphanTurns();
  assert.equal(n, 0, '둘 다 건너뜀');
  assert.equal((await readThread('w2', 'busy')).messages[0].awaiting, true);
  assert.equal((await readThread('w2', 'fresh')).messages[0].awaiting, true);
});

test('영어 회사는 영어 사유·아카이브(_)·상태 파일은 스캔 제외', async () => {
  await mkCompany('w3', 'en');
  const old = Date.now() - 10 * 60_000;
  await writeFile(join(ROOT, 'w3', 'chats', 'crew.json'), thread([{ who: 'user', text: 'z', ts: old, turnId: 't4', awaiting: true }]));
  await writeFile(join(ROOT, 'w3', 'chats', '_room-123.json'), thread([{ who: 'user', text: 'a', ts: old, turnId: 't5', awaiting: true }]));
  const n = await sweepOrphanTurns();
  assert.equal(n, 1, '아카이브는 제외');
  assert.match((await readThread('w3', 'crew')).messages[0].failed, /server restarted/i);
});
