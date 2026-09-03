// I-5 회사 노드의 카드 작성기 — 모델 호출 없이 agents/<slug>.md. slug·-n·예약어·빈 값 규칙을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-card-t-'));
const { createAgentCard } = await import('../src/persona.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { listAgents } = await import('../src/hub.mjs');
const WS = 'org-lean';
await createCompany(WS, '린 컴퍼니', '회사 노드', '77777777-7777-4777-8777-777777777777', 'ko');
test('createAgentCard — frontmatter+지시 본문, 동명은 -n, 한글 이름은 crew, 목록에 보인다', async () => {
  const a = await createAgentCard(WS, { name: 'Onboarding Bot', role: '온보딩', prompt: '신입에게 첫 주 안내를 한다' });
  assert.equal(a.slug, 'onboarding-bot');
  const md = await readFile(a.file, 'utf8');
  assert.equal(md, '---\nname: Onboarding Bot\nslug: onboarding-bot\nrole: 온보딩\n---\n\n신입에게 첫 주 안내를 한다\n');
  const b = await createAgentCard(WS, { name: 'Onboarding Bot', prompt: 'x' });
  assert.equal(b.slug, 'onboarding-bot-2', '동명 카드를 덮어쓰지 않는다');
  const k = await createAgentCard(WS, { name: '온보딩 봇', prompt: 'y', runner: 'openrouter', model: 'm/x:free' });
  assert.equal(k.slug, 'crew');
  assert.match(await readFile(k.file, 'utf8'), /runner: openrouter\nmodel: m\/x:free\n---/, '러너·모델 frontmatter');
  const names = (await listAgents(WS)).map((x) => x.slug).sort();
  assert.deepEqual(names, ['crew', 'onboarding-bot', 'onboarding-bot-2']);
});
test('createAgentCard — 예약어·빈 이름·빈 지시는 거절', async () => {
  await assert.rejects(createAgentCard(WS, { name: 'room-main', prompt: 'x' }), (e) => e.code === 'SLUG_RESERVED');
  await assert.rejects(createAgentCard(WS, { name: '  ', prompt: 'x' }), /이름/);
  await assert.rejects(createAgentCard(WS, { name: 'a', prompt: ' ' }), /지시/);
});
