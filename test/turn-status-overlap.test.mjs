// K51 — 크루 상태 파일·심박은 크루당 하나다. 같은 크루의 턴이 겹치면(1:1 대화 + 루틴 + 위임 수신) 먼저 끝난 턴의
// clearTurnStatus가 남은 턴의 진행 표시와 심박을 지웠다 → 남은 턴은 이벤트가 없는 긴 단계에서 "작성 중"이 사라졌다.
// 턴의 생존은 chat.mjs가 이미 쓰는 turn-abort 등록부(withTurnControl이 runChat 전체를 감싼다 — 논리 턴 = group)로 본다.
// 등록은 실제 모듈(registerTurn)로 한다 — chat.mjs와 같은 순서: 등록 → set … → clear(아직 등록된 채) → release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tsoverlap-'));
const { paths } = await import('../src/workspace.mjs');
const { setTurnStatus, clearTurnStatus, getTurnStatus, _setHeartbeatMsForTest } = await import('../src/turn-status.mjs');
const { registerTurn } = await import('../src/turn-abort.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusPath = (ws, slug) => join(paths(ws).chats, `${slug}.status.json`);
async function waitFor(cond, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (await cond()) return; await sleep(10); }
  assert.fail(message);
}
test.afterEach(() => _setHeartbeatMsForTest(30_000));

test('겹친 턴: 먼저 끝난 턴(1:1)의 clear가 아직 도는 턴(루틴)의 진행 표시를 지우지 않는다 — 마지막 턴이 끝나면 지워진다', async () => {
  const ws = 'overlap', slug = 'seoyun';
  await mkdir(paths(ws).chats, { recursive: true });
  const a = registerTurn(ws, slug, () => {}, { source: 'chat' });
  const b = registerTurn(ws, slug, () => {}, { source: 'routine' });
  await setTurnStatus(ws, slug, 'boot', '', undefined, 'chat');
  await setTurnStatus(ws, slug, 'shell', 'npm test', undefined, 'routine');
  await clearTurnStatus(ws, slug); // 1:1 턴 종료 — chat.mjs처럼 아직 등록된 채로
  a.release();
  assert.equal((await getTurnStatus(ws, slug))?.stage, 'shell', '루틴 턴의 진행 표시가 남는다');
  await clearTurnStatus(ws, slug); // 루틴 턴 종료 — 이제 남은 턴 없음
  b.release();
  assert.equal(await getTurnStatus(ws, slug), null);
  assert.equal(existsSync(statusPath(ws, slug)), false);
});

test('겹친 턴: 먼저 끝난 턴이 심박을 끄지 않는다 — 남은 턴의 긴 단계에서도 ts가 갱신된다', { timeout: 10_000 }, async () => {
  const ws = 'overlap-hb', slug = 'minjun';
  await mkdir(paths(ws).chats, { recursive: true });
  _setHeartbeatMsForTest(20);
  const a = registerTurn(ws, slug, () => {});
  const b = registerTurn(ws, slug, () => {});
  try {
    await setTurnStatus(ws, slug, 'memory', '', undefined, 'delegate');
    await clearTurnStatus(ws, slug);
    a.release();
    const { readFile } = await import('node:fs/promises');
    const ts0 = JSON.parse(await readFile(statusPath(ws, slug), 'utf8')).ts;
    await waitFor(async () => JSON.parse(await readFile(statusPath(ws, slug), 'utf8')).ts > ts0, '남은 턴의 심박이 멈췄다');
  } finally { await clearTurnStatus(ws, slug); b.release(); }
});

test('단독 턴(인접 행동): 제 턴이 등록된 채 clear해도 종전처럼 즉시 지워진다', async () => {
  const ws = 'solo', slug = 'luca';
  await mkdir(paths(ws).chats, { recursive: true });
  const a = registerTurn(ws, slug, () => {});
  const retry = registerTurn(ws, slug, () => {}, { group: a.group }); // 같은 논리 턴의 재시도·프로바이더 핸들(같은 group)
  await setTurnStatus(ws, slug, 'boot', '', undefined, 'chat');
  await clearTurnStatus(ws, slug);
  assert.equal(existsSync(statusPath(ws, slug)), false, '같은 group의 핸들은 "다른 턴"이 아니다');
  retry.release(); a.release();
});

test('동시 종료 경합: 두 턴이 서로 미룬 채 둘 다 끝나면 심박이 등록부가 빈 것을 보고 치운다 — 영구 "작성 중" 없음', { timeout: 10_000 }, async () => {
  const ws = 'race', slug = 'pepper';
  await mkdir(paths(ws).chats, { recursive: true });
  _setHeartbeatMsForTest(20);
  const a = registerTurn(ws, slug, () => {});
  const b = registerTurn(ws, slug, () => {});
  await setTurnStatus(ws, slug, 'write', 'a.md', undefined, 'chat');
  await clearTurnStatus(ws, slug); // A: B가 살아 있어 미룸
  await clearTurnStatus(ws, slug); // B: A의 등록 해제 전이라 역시 미룸
  a.release(); b.release();
  await waitFor(() => !existsSync(statusPath(ws, slug)), '둘 다 끝났는데 상태 파일이 남았다');
  await sleep(80);
  assert.equal(existsSync(statusPath(ws, slug)), false, '심박이 되살리지 않는다');
});
