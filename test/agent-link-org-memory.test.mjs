// 본체 조직 기억(유건 2026-10-22 22:4x "본체가 조직 대화를 개인 기억에 섞어 쓰고 조직을 나가도 회수 안 되는 결함부터 고쳐 주세요").
// 실제 chat()을 가짜 러너(외부 CLI 실행)로 돌려 메신저 v2 링크 범위 턴의 일지가 어디에 쓰이는지 본다. 실 Supabase·실 모델·네트워크 0.
// 고정하는 것(회귀 핀 — 고치기 전에도 통과): 개인 공간 링크 턴 = 개인 일지(볼트)·색인, 기억 안 남김 = 일지 0, 옛 조직 채널 턴 = PC 일지 0.
// 고치는 것: 팀 공간 링크 턴 = 볼트 밖 조직 칸(.msgr-journal, org-<공간>-ch-<방>)·볼트 0, 공간을 모르면 일지 0(fail-closed), 이어지는 턴(쪽지·결재 후속·위임)도 같은 칸.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-org-memory-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-org-memory-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
process.env.ARGO_MODEL_CATALOG = process.env.ARGO_NATIVE_RUNNERS = 'off';
process.env.ARGO_ENC_VAULT = '0';
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_TENANT_OWNER']) delete process.env[key];
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network disabled in org-memory test'); };

// 가짜 러너(codex CLI 모양) — 받은 글을 모으고 짧게 답한다
const seen = [];
globalThis.__omCli = (args) => { seen.push(args.prompt); return '정리했습니다'; };
const wrappers = new Map();
for (const [relative, replacements] of [
  ['./runners.mjs', `export const resolveRunner = async () => ({runner:'codex',available:true,fellBack:false});
    export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
    export const sdkEnvFor = async () => ({}); export const isBilledRunner = async () => false;
    export const externalExec = async (args) => globalThis.__omCli(args);`],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
  ['./oneshot.mjs', "export const runOneShot = async () => Promise.reject(new Error('one-shot off'));"],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; ${replacements}`)}`);
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = fetchBefore; delete globalThis.__omCli; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { chat } = await import('../src/chat.mjs');
const { msgrJournal } = await import('../src/gateway/msgr-handoff.mjs');
const { EXCLUDE } = await import('../src/sync.mjs');

const OWNER = '11111111-1111-4111-8111-111111111111';
const SPACE = 'aaaaaaaa-0000-4000-8000-000000000001';
const PSPACE = 'aaaaaaaa-0000-4000-8000-0000000000bb';
const ROOM = 'dddddddd-0000-4000-8000-000000000001';
const WORK = 'eeeeeeee-0000-4000-8000-000000000001';

let seq = 0;
async function company() {
  const ws = `org-memory-${++seq}`;
  await createCompany(ws, '린', '유건', OWNER, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'seoyun.md'), '---\nname: 서윤\nrole: 비서\n---\n# 서윤\n');
  return ws;
}
const files = async (dir) => (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.md') && !n.startsWith('_'));
const read = async (dir) => (await Promise.all((await files(dir)).map((n) => readFile(join(dir, n), 'utf8')))).join('\n');
const vaultJournal = (ws) => read(paths(ws).journal);
const orgJournal = (ws) => read(join(paths(ws).root, '.msgr-journal'));
const indexText = async (ws) => readFile(join(paths(ws).vault, '_index.md'), 'utf8').catch(() => '');
const link = (extra = {}) => ({ kind: 'scope', scope: { kind: 'link', work: WORK, room: ROOM, owner: true, ...extra } });
const turn = (ws, text, opts) => chat(ws, 'seoyun', text, null, { source: 'messenger', ...opts });

test('핀: 개인 공간 링크 턴(주인 1:1)은 지금처럼 개인 일지(볼트)에 쓰고 색인에 올린다', async () => {
  const ws = await company();
  await turn(ws, 'PERSONAL_ONE 정리해 줘', { mirrorCtx: link({ space: PSPACE, spaceKind: 'personal' }) });
  assert.match(await vaultJournal(ws), /지시: PERSONAL_ONE 정리해 줘/);
  assert.match(await indexText(ws), /journal\/\d{4}-\d{2}-\d{2}-seoyun/);
  assert.doesNotMatch(await orgJournal(ws), /PERSONAL_ONE/);
});

test('핀: 기억 안 남김 방(memoryOff + journal.off)은 어느 일지에도 쓰지 않는다', async () => {
  const ws = await company();
  await turn(ws, 'NO_MEMORY 비밀 이야기', { mirrorCtx: link({ memoryOff: true, space: SPACE, spaceKind: 'team' }), journal: { off: true } });
  assert.doesNotMatch(await vaultJournal(ws) + await orgJournal(ws), /NO_MEMORY/);
});

test('핀: 옛 조직 채널 턴(msgr 문맥 + 조직 태그)은 PC 일지에 쓰지 않는다(채널 기억은 서버에만, 2026-09-24)', async () => {
  const ws = await company();
  await turn(ws, 'LEGACY_CHANNEL 회의록', { mirrorCtx: { kind: 'msgr', orgId: SPACE, channelId: ROOM, channelKind: 'public', threadRoot: 1, crewId: null }, journal: msgrJournal(SPACE, ROOM) });
  assert.doesNotMatch(await vaultJournal(ws) + await orgJournal(ws), /LEGACY_CHANNEL/);
});

test('결함: 팀 공간 링크 턴은 볼트 밖 조직 칸(org-<공간>-ch-<방>)에 쓰고 개인 일지·색인에는 0, 조직 칸은 동기화 제외', async () => {
  const ws = await company();
  const r = await turn(ws, 'TEAM_ROOM 가격표 정리', { mirrorCtx: link({ space: SPACE, spaceKind: 'team' }) });
  assert.doesNotMatch(await vaultJournal(ws), /TEAM_ROOM/, '개인 일지에 섞이지 않는다');
  assert.doesNotMatch(await indexText(ws), /TEAM_ROOM|org-/, '볼트 색인에 오르지 않는다');
  const names = await files(join(paths(ws).root, '.msgr-journal'));
  assert.deepEqual(names.map((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '')), [`seoyun.org-${SPACE}-ch-${ROOM}.md`]);
  assert.match(await orgJournal(ws), /지시: TEAM_ROOM 가격표 정리/);
  assert.equal(EXCLUDE(`.msgr-journal/${names[0]}`), true, '동기화 제외 자리');
  assert.equal(r.handover ?? null, null, '화면 칩으로 열 볼트 일지가 없다');
});

test('결함: 공간을 모르는 링크 턴(옛 범위·조회 실패)은 일지를 쓰지 않는다(fail-closed)', async () => {
  const ws = await company();
  await turn(ws, 'UNKNOWN_ROOM 메모', { mirrorCtx: link() });
  await turn(ws, 'BAD_SPACE 메모', { mirrorCtx: link({ space: 'not-a-uuid', spaceKind: 'team' }) });
  assert.doesNotMatch(await vaultJournal(ws) + await orgJournal(ws), /UNKNOWN_ROOM|BAD_SPACE/);
});

test('이어지는 턴: 쪽지(sendCrewMail → 배달 문맥)·결재 범위(approvalScope)가 공간을 잃지 않고, 배달 턴도 조직 칸에 쓴다', async () => {
  const ws = await company();
  await writeFile(join(paths(ws).agents, 'mina.md'), '---\nname: 미나\nrole: 분석\n---\n# 미나\n');
  const { sendCrewMail } = await import('../src/crewmail.mjs');
  const { crewmailMirrorCtx } = await import('../src/scheduler.mjs');
  const { approvalScope } = await import('../src/thread.mjs');
  await sendCrewMail(ws, { from: 'seoyun', fromName: '서윤', to: 'mina', message: 'MAIL_TEAM 자료 확인', link: link({ space: SPACE, spaceKind: 'team' }).scope });
  const dir = join(paths(ws).root, 'mail', 'mina');
  const [name] = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  const msg = JSON.parse(await readFile(join(dir, name), 'utf8'));
  assert.deepEqual([msg.link.space, msg.link.spaceKind], [SPACE, 'team'], '쪽지 기록이 공간을 싣는다');
  const ctx = crewmailMirrorCtx(ws, 'mina', msg);
  assert.deepEqual([ctx.scope.space, ctx.scope.spaceKind], [SPACE, 'team'], '배달 턴 문맥도');
  assert.deepEqual(approvalScope(link({ space: SPACE, spaceKind: 'team' })).scope, link({ space: SPACE, spaceKind: 'team' }).scope, '결재 범위 각인은 범위를 통째로');
  await chat(ws, 'mina', 'MAIL_TEAM 배달', null, { source: 'crewmail', mirrorCtx: ctx });
  assert.doesNotMatch(await vaultJournal(ws), /MAIL_TEAM/);
  assert.match(await orgJournal(ws), /MAIL_TEAM 배달/);
  const personal = crewmailMirrorCtx(ws, 'mina', { link: { kind: 'link', work: WORK, room: ROOM, owner: true, space: PSPACE, spaceKind: 'personal' } });
  assert.equal(personal.scope.spaceKind, 'personal', '개인 공간 쪽지도 공간을 잇는다(개인 일지 그대로)');
});
