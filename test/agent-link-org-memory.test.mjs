// 본체 조직 기억(유건 2026-10-22 22:4x "본체가 조직 대화를 개인 기억에 섞어 쓰고 조직을 나가도 회수 안 되는 결함부터 고쳐 주세요").
// 실제 chat()을 가짜 러너(외부 CLI 실행)로 돌려 메신저 v2 링크 범위 턴의 일지가 어디에 쓰이는지 본다. 실 Supabase·실 모델·네트워크 0.
// 고정하는 것(회귀 핀 — 고치기 전에도 통과): 개인 공간 링크 턴 = 개인 일지(볼트)·색인, 기억 안 남김 = 일지 0, 옛 조직 채널 턴 = PC 일지 0.
// 고치는 것: 팀 공간 링크 턴 = 볼트 밖 조직 칸(.msgr-journal, org-<공간>-rm-<방> — 옛 채널 일지 -ch-와 가른다)·볼트 0, 공간을 모르면 일지 0(fail-closed), 이어지는 턴(쪽지·결재 후속·위임)도 같은 칸.
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

test('결함: 팀 공간 링크 턴은 볼트 밖 조직 칸(org-<공간>-rm-<방>)에 쓰고 개인 일지·색인에는 0, 조직 칸은 동기화 제외', async () => {
  const ws = await company();
  const r = await turn(ws, 'TEAM_ROOM 가격표 정리', { mirrorCtx: link({ space: SPACE, spaceKind: 'team' }) });
  assert.doesNotMatch(await vaultJournal(ws), /TEAM_ROOM/, '개인 일지에 섞이지 않는다');
  assert.doesNotMatch(await indexText(ws), /TEAM_ROOM|org-/, '볼트 색인에 오르지 않는다');
  const names = await files(join(paths(ws).root, '.msgr-journal'));
  assert.deepEqual(names.map((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '')), [`seoyun.org-${SPACE}-rm-${ROOM}.md`]);
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

test('이어지는 턴: 쪽지(sendCrewMail → 배달 문맥)·결재 범위(approvalScope)가 공간을 잃지 않고, 팀 방의 배달 턴(전해 받은 일)은 어느 일지에도 쓰지 않는다(검수 I-3)', async () => {
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
  assert.doesNotMatch(await vaultJournal(ws) + await orgJournal(ws), /MAIL_TEAM/, '받은 에이전트는 그 방 멤버가 아닐 수 있어 소속으로 거둘 수 없다 — 일지 0');
  await chat(ws, 'seoyun', 'APPROVAL_FOLLOW 후속', null, { mirrorCtx: { kind: 'scope', scope: approvalScope(link({ space: SPACE, spaceKind: 'team' })).scope } });
  assert.match(await orgJournal(ws), /APPROVAL_FOLLOW 후속/, '결재 후속 턴(같은 에이전트)은 조직 칸에');
  assert.equal(ctx.scope.relayed, true, '배달 문맥은 전해 받은 일 표지를 싣는다');
  await chat(ws, 'mina', 'RELAYED_FOLLOW 후속', null, { mirrorCtx: { kind: 'scope', scope: approvalScope(ctx).scope } }); // 전해 받은 일에서 올린 결재의 후속 턴(from·via 없음 — 재검수 남은 구멍)
  assert.doesNotMatch(await vaultJournal(ws) + await orgJournal(ws), /RELAYED_FOLLOW/, '전해 받은 일의 결재 후속 턴도 팀 방 일지 0');
  const personal = crewmailMirrorCtx(ws, 'mina', { link: { kind: 'link', work: WORK, room: ROOM, owner: true, space: PSPACE, spaceKind: 'personal' } });
  assert.equal(personal.scope.spaceKind, 'personal', '개인 공간 쪽지도 공간을 잇는다(개인 일지 그대로)');
});

test('회수(recallLinkRooms): 서버가 "없음"이라 한 팀 방만 — 직접 받은 줄·조직 칸·모델 전사는 에이전트 소속으로, 전해 받은 줄은 내 에이전트가 하나라도 남았나로. 개인·모름·옛 메신저 줄은 그대로(검수 I-1·I-2·I-3)', async () => {
  const ws = await company();
  const { appendTurn, loadThread, noteChannelSession, threadChannelIds } = await import('../src/thread.mjs');
  const { recallLinkRooms, recallDeparted } = await import('../src/gateway/msgr-recall.mjs');
  const GONE = 'dddddddd-0000-4000-8000-0000000000a1', KEEP = 'dddddddd-0000-4000-8000-0000000000a2', PROOM = 'dddddddd-0000-4000-8000-0000000000a3', SHARED = 'dddddddd-0000-4000-8000-0000000000a5';
  const team = (room) => ({ kind: 'link', work: WORK, room, owner: true, space: SPACE, spaceKind: 'team' });
  const cfg = { configDirs: [join(process.env.HOME, '.claude')] };
  await appendTurn(ws, 'seoyun', { userMsg: 'GONE_LINE 지시', reply: 'GONE_REPLY', sessionId: null, contextScope: team(GONE) });
  await appendTurn(ws, 'seoyun', { userMsg: 'KEEP_LINE 지시', reply: 'KEEP_REPLY', sessionId: null, contextScope: team(KEEP) });
  await appendTurn(ws, 'seoyun', { userMsg: 'RELAYED_LINE 쪽지', reply: 'RELAYED_REPLY', sessionId: null, via: 'crewmail', contextScope: team(SHARED) }); // 이 에이전트는 SHARED 멤버가 아니다
  await appendTurn(ws, 'seoyun', { userMsg: 'RELAYED_FOLLOWUP 승인 후속', reply: 'FOLLOWUP_REPLY', sessionId: null, contextScope: { ...team(SHARED), relayed: true } }); // 전해 받은 일의 결재 후속 턴 줄(via 없음, 범위 표지만)
  await appendTurn(ws, 'seoyun', { userMsg: 'PERSONAL_LINE 지시', reply: 'PERSONAL_REPLY', sessionId: null, contextScope: { kind: 'link', work: WORK, room: PROOM, owner: true, space: PSPACE, spaceKind: 'personal' } });
  await appendTurn(ws, 'seoyun', { userMsg: 'UNKNOWN_LINE 지시', reply: 'UNKNOWN_REPLY', sessionId: null, contextScope: { kind: 'link', work: WORK, room: PROOM, owner: true } }); // 공간 모름(옛 범위)
  await appendTurn(ws, 'seoyun', { userMsg: 'LEGACY_SAME_ID 지시', reply: 'LEGACY_REPLY', sessionId: null, contextScope: { kind: 'msgr-dm', channelId: GONE, ownerSolo: true } }); // 옛 채널 id = v2 방 id(백필)
  await turn(ws, 'GONE_JOURNAL 정리', { mirrorCtx: link({ room: GONE, space: SPACE, spaceKind: 'team' }) });
  await turn(ws, 'KEEP_JOURNAL 정리', { mirrorCtx: link({ room: KEEP, space: SPACE, spaceKind: 'team' }) });
  const SID = '9a000000-0000-4000-8000-000000000001', RSID = '9a000000-0000-4000-8000-000000000002';
  await noteChannelSession(ws, 'seoyun', team(GONE), SID);
  await noteChannelSession(ws, 'seoyun', team(SHARED), RSID, 'crewmail');
  const proj = join(process.env.HOME, '.claude', 'projects', 'x'); await mkdir(proj, { recursive: true });
  await writeFile(join(proj, `${SID}.jsonl`), 'GONE_TRANSCRIPT'); await writeFile(join(proj, `${RSID}.jsonl`), 'RELAYED_TRANSCRIPT');
  // 조회 실패 — 아무것도 지우지 않는다
  assert.deepEqual(await recallLinkRooms(ws, ['seoyun'], async () => null, cfg), { removed: 0, transcripts: 0, journals: 0, channels: 0 });
  assert.match(JSON.stringify(await loadThread(ws, 'seoyun')), /GONE_LINE/);
  // 1차: GONE에서 이 에이전트가 빠짐(다른 내 에이전트도 없음), KEEP 그대로, SHARED에는 이 에이전트는 없지만 내 다른 에이전트가 있다
  const asked = [];
  const answer = (map) => async (pairs) => { asked.push(...pairs.map((p) => p.id)); const out = new Map(); for (const p of pairs) { const [mine, any] = map[p.id]; out.set(`${p.slug}:${p.id}`, mine); out.set(`*:${p.id}`, any); } return out; };
  const sum = await recallLinkRooms(ws, ['seoyun'], answer({ [GONE]: [false, false], [KEEP]: [true, true], [SHARED]: [false, true] }), cfg);
  assert.deepEqual(new Set(asked), new Set([GONE, KEEP, SHARED]), '묻는 방 = 팀이라고 명시된 링크 방만 — 개인·모름·옛 메신저 방은 묻지 않는다(I-2)');
  assert.deepEqual([sum.channels, sum.journals, sum.transcripts], [1, 1, 1]);
  let t = JSON.stringify(await loadThread(ws, 'seoyun'));
  assert.doesNotMatch(t, /GONE_LINE|GONE_REPLY/, '빠진 방의 직접 받은 줄');
  for (const k of ['KEEP_LINE', 'RELAYED_LINE', 'RELAYED_FOLLOWUP', 'PERSONAL_LINE', 'UNKNOWN_LINE', 'LEGACY_SAME_ID']) assert.match(t, new RegExp(k), `남김: ${k}`);
  assert.doesNotMatch(await orgJournal(ws), /GONE_JOURNAL/); assert.match(await orgJournal(ws), /KEEP_JOURNAL/);
  assert.deepEqual((await readdir(proj)).sort(), [`${RSID}.jsonl`], '그 방의 직접 받은 링크 턴 전사만');
  // 2차: SHARED에 내 에이전트가 하나도 남지 않음 → 전해 받은 줄·그 전사도 거둔다
  await recallLinkRooms(ws, ['seoyun'], answer({ [KEEP]: [true, true], [SHARED]: [false, false] }), cfg);
  t = JSON.stringify(await loadThread(ws, 'seoyun'));
  assert.doesNotMatch(t, /RELAYED_LINE|RELAYED_REPLY|RELAYED_FOLLOWUP|FOLLOWUP_REPLY/); assert.equal((await readdir(proj)).length, 0);
  // 옛 회수(옛 브리지): 같은 id(GONE)의 옛 줄을 지워도 v2 링크 줄은 건드리지 않고, 링크 방은 묻지 않는다(I-1 반대 방향)
  await appendTurn(ws, 'seoyun', { userMsg: 'LINK_AFTER 지시', reply: 'R', sessionId: null, contextScope: team(GONE) });
  assert.ok(!(await threadChannelIds(ws, 'seoyun')).has(KEEP), '옛 회수가 모으는 방에 링크 방은 없다');
  const legacyAsked = [];
  await recallDeparted(ws, ['seoyun'], async (pairs) => { legacyAsked.push(...pairs.map((p) => p.id)); return new Map(pairs.map((p) => [`${p.slug}:${p.id}`, false])); });
  assert.deepEqual(legacyAsked, [GONE], '옛 회수는 옛 줄의 채널만 묻는다');
  t = JSON.stringify(await loadThread(ws, 'seoyun'));
  assert.doesNotMatch(t, /LEGACY_SAME_ID/, '옛 회수는 옛 줄을 지운다(종전 그대로)');
  for (const k of ['LINK_AFTER', 'KEEP_LINE', 'PERSONAL_LINE', 'UNKNOWN_LINE']) assert.match(t, new RegExp(k), `옛 회수가 남김: ${k}`);
});

test('동기화 제외: 팀·모름 방 첨부의 턴 임시 칸(vault/files/msgr2-turn/)·조직 칸, 개인 공간 첨부(vault/files/msgr2/)는 종전대로 동기화', () => {
  assert.equal(EXCLUDE('vault/files/msgr2-turn/eeeeeeee-0000-4000-8000-000000000001/a.csv'), true);
  assert.equal(EXCLUDE(`.msgr-journal/2026-10-22-seoyun.org-${SPACE}-rm-${ROOM}.md`), true);
  assert.equal(EXCLUDE('vault/files/msgr2/eeeeeeee-a.csv'), false, '개인 공간 첨부는 개인 기억(종전 그대로)');
});
