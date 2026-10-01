// 턴 상태 파일은 크루당 하나다. 앱 사이드카와 argo CLI가 같은 폴더를 쓰면 두 프로세스의 턴이 같은 파일을 쓰고 지운다 — 반대 검토 M-b ②(2026-10-01).
// turnGroups는 globalThis 등록부라 다른 프로세스의 턴을 모른다. 앱 턴이 끝나며 지우면 아직 도는 CLI 턴의 "작성 중" 표시가 사라진다(반대 방향도 같다).
// 계약: 상태 파일에 쓴 프로세스 pid를 남기고, 지우는 쪽은 **다른 살아 있는 프로세스가 쓴 신선한 파일**을 지우지 않는다. pid 없는 옛 파일·죽은 pid·낡은 파일은 종전대로 지운다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tsowner-'));
const { paths } = await import('../src/workspace.mjs');
const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
const { setTurnStatus, clearTurnStatus, getTurnStatus } = await import('../src/turn-status.mjs');

const WS = 'co-owner';
await mkdir(paths(WS).chats, { recursive: true });
const statusFile = (slug) => join(paths(WS).chats, `${slug}.status.json`);
const readStatus = async (slug) => JSON.parse(await readFile(statusFile(slug), 'utf8'));
const OTHER_LIVE = process.ppid; // 살아 있는 다른 프로세스(이 테스트를 띄운 프로세스)
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(r.stdout); };
const other = (extra = {}) => ({ stage: 'work', detail: 'cli', partial: '다른 프로세스의 말', source: 'chat', thought: '', steps: [], startedAt: Date.now(), ts: Date.now(), pid: OTHER_LIVE, ...extra });

test('상태 파일에 쓴 프로세스의 pid가 남는다', async () => {
  await setTurnStatus(WS, 'own', 'work', 'x');
  assert.equal((await readStatus('own')).pid, process.pid);
  await clearTurnStatus(WS, 'own');
  assert.equal(existsSync(statusFile('own')), false, '자기 파일은 종전대로 지운다');
});

test('다른 살아 있는 프로세스가 덮어쓴 신선한 상태는 내 턴이 끝나도 지우지 않는다(CLI 턴의 작성 중 표시 보존)', async () => {
  await setTurnStatus(WS, 'peer', 'work', 'app turn');
  await writeJsonAtomic(statusFile('peer'), other()); // 그 사이 CLI 프로세스가 같은 크루의 상태를 썼다
  await clearTurnStatus(WS, 'peer');
  assert.equal(existsSync(statusFile('peer')), true, '다른 프로세스의 상태를 지우면 그 턴의 작성 중 표시가 사라진다');
  assert.equal((await getTurnStatus(WS, 'peer')).detail, 'cli');
});

test('pid 없는 옛 파일·죽은 pid·낡은 파일은 종전대로 지운다(고아 표시가 남지 않게)', async () => {
  for (const [slug, st] of [['legacy', other({ pid: undefined })], ['dead', other({ pid: deadPid() })], ['stale', other({ ts: Date.now() - 200_000 })]]) {
    await setTurnStatus(WS, slug, 'work', 'x');
    await writeJsonAtomic(statusFile(slug), st);
    await clearTurnStatus(WS, slug);
    assert.equal(existsSync(statusFile(slug)), false, `${slug}: 지워야 한다`);
  }
});

test('다른 프로세스의 말(partial)·단계 궤적이 내 새 상태에 섞이지 않는다', async () => {
  await writeJsonAtomic(statusFile('bleed'), other({ partial: '남의 문장', steps: [{ n: 1 }], startedAt: 123 }));
  await setTurnStatus(WS, 'bleed', 'work', 'mine');
  const s = await readStatus('bleed');
  assert.equal(s.pid, process.pid);
  assert.equal(s.partial, '', '남의 partial을 이어받으면 내 화면에 남의 문장이 나온다');
  assert.deepEqual(s.steps, []);
  assert.notEqual(s.startedAt, 123);
  await clearTurnStatus(WS, 'bleed');
});
