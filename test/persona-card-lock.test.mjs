// 분리 검수(2026-09-24) MEDIUM — writeJsonAtomic의 rename 재시도 예산이 3초로 늘면서, 먼저 읽은
// 쓰기가 늦게 성공해 나중 변경을 덮어쓰는 lost-update 창이 넓어졌다. persona.mjs의 카드 read-
// modify-write를 withLock(persona-card:wsId:slug)으로 직렬화해 이 창을 없앴다 — 이 테스트는 서로
// 다른 함수(updateAgentMeta·appendAgentRule)로 같은 카드를 "동시에" 두 번 고쳐도 둘 다 반영되는지
// 본다(락이 없으면 두 read가 겹쳐 나중 write가 먼저 read한 옛 상태를 덮어써 한쪽이 사라진다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-persona-lock-'));
const { paths, createCompany, updateCompany, loadCompany } = await import('../src/workspace.mjs');
const { updateAgentMeta, appendAgentRule, readAgentCard } = await import('../src/persona.mjs');

const CARD = '---\nname: 알파\nslug: a\nrole: 초기역할\n---\n\n# 알파 — 초기역할\n\n## 일하는 방식\n- 기존 규칙\n';

test('카드 동시 갱신 — updateAgentMeta·appendAgentRule을 동시에 걸어도 둘 다 반영된다(lost-update 없음)', async () => {
  const ws = 'lockco-a1';
  await createCompany(ws, '락 회사', 'captain', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'a.md'), CARD);

  await Promise.all([
    updateAgentMeta(ws, 'a', { role: '바뀐역할' }),
    appendAgentRule(ws, 'a', '동시에 추가된 규칙'),
  ]);

  const { meta, md } = await readAgentCard(ws, 'a');
  assert.equal(meta.role, '바뀐역할', 'updateAgentMeta의 변경이 살아 있어야 한다');
  assert.match(md, /동시에 추가된 규칙/, 'appendAgentRule의 변경도 함께 살아 있어야 한다(한쪽이 다른 쪽을 덮으면 안 됨)');
});

test('회사 정보 동시 갱신 — updateCompany 두 호출을 동시에 걸어도 서로 다른 필드가 둘 다 반영된다', async () => {
  const ws = 'lockco-a2';
  await createCompany(ws, '원래 이름', 'captain', null, 'ko');

  await Promise.all([
    updateCompany(ws, { name: '새 이름' }),
    updateCompany(ws, { lang: 'en' }),
  ]);

  const company = await loadCompany(ws);
  assert.equal(company.name, '새 이름');
  assert.equal(company.lang, 'en');
});

// 2026-09-26 잔여 LOW — msgr-node·msgr 알림 켜기·msgr enabled 동기화가 company.msgr을 잠금 밖에서 읽고
// 스프레드한 객체를 넘겼다. 사이에 다른 쪽이 msgr의 다른 필드를 바꾸면 그 변경이 사라진다.
// updateCompany에 함수를 넘기면 잠금 안에서 최신 값을 받아 patch를 만든다.
test('회사 정보 동시 갱신 — 함수 patch는 잠금 안의 최신 msgr을 받아 서로 다른 msgr 필드가 둘 다 남는다', async () => {
  const ws = 'lockco-a3';
  await createCompany(ws, '메신저 회사', 'captain', null, 'ko');
  await updateCompany(ws, { msgr: { enabled: false } });

  await Promise.all([
    updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), enabled: true, nodeOrgId: 'org-1' } })),
    updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), notify: { mode: 'dm' } } })),
  ]);

  const { msgr, id } = await loadCompany(ws);
  assert.deepEqual(msgr, { enabled: true, nodeOrgId: 'org-1', notify: { mode: 'dm' } });
  assert.equal(id, ws, 'id는 함수 patch가 돌려줘도 바뀌지 않는다');
});

test('updateCompany — async patch 함수는 조용히 무시되지 않고 거절된다', async () => {
  const ws = 'lockco-a4';
  await createCompany(ws, '원래', 'captain', null, 'ko');
  await assert.rejects(updateCompany(ws, async () => ({ name: 'ASYNC' })), /동기/);
  assert.equal((await loadCompany(ws)).name, '원래');
});

// 보조 잠금(행동 테스트가 호출부 하나하나를 다 덮지 못하는 자리): 잠금 밖에서 읽은 msgr을 스프레드한 객체 patch가 다시 생기지 않게 한다.
test('호출부 — 잠금 밖에서 읽은 msgr을 스프레드한 객체 patch가 없다(함수 patch만)', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const root = new URL('..', import.meta.url).pathname;
  const walk = async (d) => (await readdir(d, { withFileTypes: true })).flatMap((e) => e.isDirectory() ? [] : [join(d, e.name)]);
  const files = [];
  for (const d of ['src', 'src/gateway', 'app', 'app/api/companies/[ws]/msgr', 'app/api/companies/[ws]/msgr/notify']) files.push(...(await walk(join(root, d))).filter((f) => /\.(mjs|js|jsx)$/.test(f)));
  const bad = [];
  for (const f of files) {
    const s = await readFile(f, 'utf8');
    if (/update(?:Company)?\(\s*\w+\s*,\s*\{\s*msgr:\s*\{\s*\.\.\./.test(s)) bad.push(f.slice(root.length));
  }
  assert.deepEqual(bad, []);
});
