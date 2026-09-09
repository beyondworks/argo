import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

// 실제 chat/지시 실행/후속 chat을 통과시키되 벤더와 커넥터 경계만 격리한다.
// 동적 import 전에 POSIX·Windows 홈도 임시화해 러너 모듈의 부수효과를 실 홈에서 격리한다.
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-cli-disposition-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-cli-disposition-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled in CLI disposition test'); };
const wrappers = new Map();
for (const [relative, replacements] of [
  ['./runners.mjs', `
    export const resolveRunner = async () => ({ runner: 'codex', available: true, fellBack: false });
    export const runnerCredType = async () => 'host';
    export const runnerCredEnv = async () => ({});
    export const isBilledRunner = async () => false;
    export const externalExec = (...args) => globalThis.__argoCliDispositionReply(...args);
  `],
  ['./connectors.mjs', `
    export const connectorBriefing = async () => [];
    export const callConnectorTool = async () => ({ ok: true, content: [{ type: 'text', text: '검수 자료' }] });
  `],
  ['./runners/catalog-remote.mjs', 'export const loadRemoteCatalog = async () => null;'],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)};\n${replacements}`)}`);
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/\/src\/(chat|cli-directives)\.mjs$/.test(context.parentURL ?? '') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = realFetch; delete globalThis.__argoCliDispositionReply; });
const { createCompany, paths } = await import('../src/workspace.mjs');
const { chat } = await import('../src/chat.mjs');
let sequence = 0;
async function run(replies, { kind = 'msgr', mutate = null } = {}) {
  const ws = `cli-disposition-${++sequence}`;
  await createCompany(ws, '검수', 'owner');
  await mkdir(paths(ws).agents, { recursive: true });
  const peers = [{ id: 'alpha-id', slug: 'alpha', display_name: '알파', owner_user_id: 'owner', ws_id: ws }, { id: 'beta-id', slug: 'beta', display_name: '베타', owner_user_id: 'owner', ws_id: ws }];
  for (const p of peers) await writeFile(join(paths(ws).agents, `${p.slug}.md`), `---\nname: ${p.display_name}\nslug: ${p.slug}\nrunner: codex\n---\n검수 크루`);
  const ctx = kind ? { kind, orgId: 'org', channelId: 'channel', crewId: 'alpha-id', uid: 'owner', wsId: ws, peers, handoffs: [] } : null;
  let calls = 0;
  globalThis.__argoCliDispositionReply = async () => {
    mutate?.(ctx, calls);
    const value = replies[calls++];
    if (value instanceof Error) throw value;
    return value;
  };
  const result = await chat(ws, 'alpha', '요청을 처리하세요', null, { source: 'messenger', mirrorCtx: ctx, journal: { off: true } });
  assert.equal(calls, replies.length, '필요한 CLI 호출만 실행');
  return { result, ctx };
}
const directive = (value) => `\n\`\`\`argo\n${JSON.stringify(value)}\n\`\`\``;
const connector = directive({ action: 'tool', server: 'check', tool: 'read' });
const mail = directive({ action: 'mail', to: 'beta', message: '출처 검수 요청' });

test('CLI 지시 결과·거부 안내를 붙여도 최종 메신저 판정은 마지막 독립 줄로 보존한다', async () => {
  const { result, ctx } = await run([`@베타 출처를 검수해 주세요.${mail}${directive({action:'unknown-check'})}\nMSGR: handoff`]);
  assert.match(result.reply, /알 수 없는 지시/);
  assert.match(result.reply, /\nMSGR: handoff$/);
  assert.equal((result.reply.match(/^MSGR:/gm) ?? []).length, 1);
  assert.equal(ctx.handoffs.length, 1);
  const completed = await run([`완료. @베타 수고했어요.${mail}\nMSGR: done`]);
  assert.doesNotMatch(completed.result.reply, /예약됨|prepared/);
  assert.match(completed.result.reply, /\nMSGR: done$/);
  const denied = await run(['zsh: operation not permitted: /tmp/report.txt\nMSGR: done']);
  assert.match(denied.result.reply, /\nMSGR: done$/);
  assert.ok(denied.result.reply.length > 'zsh: operation not permitted: /tmp/report.txt\nMSGR: done'.length, '실제 sandbox 안내 추가 경로도 통과');
});

test('CLI 커넥터 후속 턴의 마지막 판정이 앞선 판정을 대체하고 앞 marker는 본문에서 제거된다', async () => {
  for (const [first, last] of [['handoff', 'done'], ['done', 'handoff']]) {
    const { result } = await run([`자료 조회${connector}\nMSGR: ${first}`, `@베타 최종 보고\nMSGR: ${last}`]);
    assert.match(result.reply, new RegExp(`\\nMSGR: ${last}$`));
    assert.equal((result.reply.match(/^MSGR:/gm) ?? []).length, 1);
    assert.match(result.reply, /검수 자료/);
  }
  const missing = await run([`자료 조회${connector}\nMSGR: handoff`, '@베타 최종 보고']);
  assert.doesNotMatch(missing.result.reply, /^MSGR:/m, '후속 판정 누락에 앞 handoff를 승계하지 않는다');
});

test('CLI 후속 실패는 이전 marker를 노출하지 않고 실패 시도에 추가된 넘김을 폐기한다', async () => {
  const { result, ctx } = await run([`자료 조회${connector}\nMSGR: handoff`, new Error('synthetic follow-up failure\nMSGR: handoff')], {
    mutate: (ctx, call) => { if (call === 1) ctx.handoffs.push({ message: '실패 시도 잔여물' }); },
  });
  assert.match(result.reply, /후속 턴 실패/);
  assert.doesNotMatch(result.reply, /^MSGR:/m);
  assert.deepEqual(ctx.handoffs, []);
});

test('일반 CLI 턴과 위임 child는 기존 marker 문자열과 지시 결과 결합을 바꾸지 않는다', async () => {
  for (const kind of [null, 'msgr-rules']) {
    const { result } = await run([`완료${directive({ action: 'unknown-check' })}\nMSGR: done`], { kind });
    assert.match(result.reply, /MSGR: done\n\n.*알 수 없는 지시/);
  }
});
