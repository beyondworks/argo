// 온보딩 시드의 codex 구독(oauth) 자격은 복사가 아니라 이동이다(감사 2026-09-22 D1·K24).
// codex refresh 토큰은 1회용 회전형이라(codex.mjs "refresh token already used" 실측) 회사마다 사본을
// 두면 한 회사가 회전하는 순간 나머지 사본이 소비된 토큰이 된다. 첫 회사만 온보딩 자격을 받고,
// 둘째 회사부터는 정직하게 미연결로 보인다. apikey 등 다른 자격은 기존대로 복사(계정 잔존).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stubRunnerToolDirs } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT + 임시 HOME(격리 홈이 실 홈을 오염하지 않게) + 관리본 스텁(codex 워밍업 다운로드 차단).
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-seedmove-'));
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-seedmovehome-'));
await stubRunnerToolDirs();
const { accountScope, saveRunnerCred, loadRunnerCred, seedRunnerCreds } = await import('../src/runners.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const U = 'user-seedmove';
const CODEX_OAUTH = JSON.stringify({ tokens: { access_token: 'at-fake', refresh_token: 'rt-fake-once' } });

test('codex oauth는 첫 회사로 이동, apikey는 모든 회사로 복사되고 계정에 남는다', async () => {
  await saveRunnerCred(accountScope(U), 'codex', 'oauth', CODEX_OAUTH);
  await saveRunnerCred(accountScope(U), 'glm', 'apikey', 'glm-seed-key');

  await createCompany('first-co', '첫 회사', 'captain');
  assert.equal(await seedRunnerCreds('first-co', U), 2);
  assert.deepEqual(await loadRunnerCred('first-co', 'codex'), { type: 'oauth', value: CODEX_OAUTH });
  assert.equal((await loadRunnerCred('first-co', 'glm')).value, 'glm-seed-key');

  // 계정에는 apikey만 남는다 — 회전형 refresh 토큰 사본을 계정에 두지 않는다.
  assert.equal(await loadRunnerCred(accountScope(U), 'codex'), null);
  assert.equal((await loadRunnerCred(accountScope(U), 'glm')).value, 'glm-seed-key');

  await createCompany('second-co', '둘째 회사', 'captain');
  assert.equal(await seedRunnerCreds('second-co', U), 1);
  assert.equal(await loadRunnerCred('second-co', 'codex'), null, '둘째 회사에 소비될 codex 사본이 가면 안 된다');
  assert.equal((await loadRunnerCred('second-co', 'glm')).value, 'glm-seed-key');
});

test('codex apikey는 회전형이 아니라 기존대로 복사된다(계정 잔존)', async () => {
  const V = 'user-seedkey';
  await saveRunnerCred(accountScope(V), 'codex', 'apikey', 'sk-codex-seed-key');
  await createCompany('key-co-1', '키 회사1', 'captain');
  await createCompany('key-co-2', '키 회사2', 'captain');
  assert.equal(await seedRunnerCreds('key-co-1', V), 1);
  assert.equal(await seedRunnerCreds('key-co-2', V), 1);
  assert.equal((await loadRunnerCred('key-co-2', 'codex')).value, 'sk-codex-seed-key');
  assert.equal((await loadRunnerCred(accountScope(V), 'codex')).value, 'sk-codex-seed-key');
});

test('같은 계정의 회사 생성이 겹쳐도 codex oauth는 정확히 한 회사로만 간다(분리 검수 2026-09-22 HIGH — 스냅샷 경합)', async () => {
  const W = 'user-seedrace';
  await saveRunnerCred(accountScope(W), 'codex', 'oauth', CODEX_OAUTH);
  const ids = ['race-1', 'race-2', 'race-3', 'race-4'];
  for (const id of ids) await createCompany(id, id, 'captain');
  await Promise.all(ids.map((id) => seedRunnerCreds(id, W)));
  const holders = [];
  for (const id of ids) if (await loadRunnerCred(id, 'codex')) holders.push(id);
  assert.equal(holders.length, 1, `회전형 토큰이 ${holders.length}개 회사에 복제됐다: ${holders.join(',')}`);
  assert.equal(await loadRunnerCred(accountScope(W), 'codex'), null);
});
