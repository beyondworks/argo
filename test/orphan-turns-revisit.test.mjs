// K47 — 부팅 스윕이 신선한 상태 파일(다른 프로세스가 돌리는 중일 수 있음)에 걸려 건너뛴 스레드는
// 창이 지난 뒤 다시 봐야 한다. 재방문이 없으면 2분 안에 재시작한 서버의 죽은 턴이 영영 awaiting(실패 표시·재전송 버튼 없음)으로 남는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-orphan-revisit-'));
process.env.ARGO_ROOT = ROOT;
const { sweepOrphanTurns } = await import('../src/orphan-turns.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chats = join(ROOT, 'w1', 'chats');
const readMsg = async (slug) => JSON.parse(await readFile(join(chats, `${slug}.json`), 'utf8')).messages[0];

test('신선 창에 걸려 건너뛴 죽은 턴은 창이 지난 뒤 다시 쓸어 실패 표시로 바꾼다', async () => {
  await mkdir(chats, { recursive: true });
  await writeFile(join(ROOT, 'w1', 'company.json'), JSON.stringify({ id: 'w1', name: 'T', owner: 'me', lang: 'ko' }));
  const old = Date.now() - 10 * 60_000;
  await writeFile(join(chats, 'pepper.json'), JSON.stringify({ schema: 1, messages: [{ who: 'user', text: '죽은 턴', ts: old, turnId: 't1', awaiting: true }] }));
  // 죽은 프로세스가 남긴 상태 파일 — 아직 120초 창 안(곧 만료)
  await writeFile(join(chats, 'pepper.status.json'), JSON.stringify({ stage: 'shell', ts: Date.now() - 119_700, startedAt: old }));
  const n = await sweepOrphanTurns({ retryMs: 600 });
  assert.equal(n, 0, '첫 스윕은 신선 창이라 건너뛴다(살아 있는 프로세스 보호)');
  assert.equal((await readMsg('pepper')).awaiting, true);
  await sleep(1500);
  const m = await readMsg('pepper');
  assert.equal(m.awaiting, undefined, '창이 지난 뒤 재방문해 awaiting 해제');
  assert.match(m.failed ?? '', /서버가 재시작되어 중단/);
});

test('계속 심박하는(살아 있는) 턴은 재방문에서도 건드리지 않는다', async () => {
  const old = Date.now() - 10 * 60_000;
  await writeFile(join(chats, 'alive.json'), JSON.stringify({ schema: 1, messages: [{ who: 'user', text: '살아 있는 턴', ts: old, turnId: 't2', awaiting: true }] }));
  await writeFile(join(chats, 'alive.status.json'), JSON.stringify({ stage: 'shell', ts: Date.now(), startedAt: old }));
  await sweepOrphanTurns({ retryMs: 300 });
  await sleep(900);
  assert.equal((await readMsg('alive')).awaiting, true, '신선한 상태 파일이면 재방문도 건너뛴다');
});

test('이 프로세스가 시작된 뒤 받은 지시는(상태 파일이 아직 없어도) 고아로 보지 않는다', async () => {
  // 재방문은 부팅 2분 뒤에 돈다 — 그때는 이 프로세스가 받은 지시도 60초를 넘길 수 있다(상태 파일 쓰기 전 대기 등)
  await writeFile(join(chats, 'mine.json'), JSON.stringify({ schema: 1, messages: [{ who: 'user', text: '이 프로세스의 턴', ts: Date.now(), turnId: 't3', awaiting: true }] }));
  const n = await sweepOrphanTurns({ now: Date.now() + 130_000, retryMs: 0 });
  assert.equal(n, 0);
  assert.equal((await readMsg('mine')).awaiting, true, '부팅 뒤 지시는 이 프로세스가 돌리는 중');
});
