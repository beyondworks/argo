// 크루 답 속 로컬 파일 자동 첨부(2026-10-02 실사례: 페퍼(codex) 답의 `![..](/Users/…/vault/projects/…png)`가 첨부 0건 →
// 메신저에서 깨진 그림·눌러도 반응 없는 링크). 회사 작업 폴더의 첨부 구역(vault/projects·files·_imported) 안 파일만 붙이고,
// 본문에서 로컬 경로를 지운다. 경계 밖(다른 회사·설정·홈의 다른 폴더·심링크 탈출·숨김·.env)은 붙이지 않는다.
// 가짜 db·chat 주입 — 네트워크·실제 모델·실 Supabase 0. 임시 ARGO_ROOT — 실데이터 미접촉.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { userInfo } from 'node:os';
import { beforeEach } from 'node:test';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-reply-files-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { paths } = await import('../src/workspace.mjs');

const WS = 'lean-ax-wqou';
const OTHER = 'other-co';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', CH = 'bbbbbbbb-0000-4000-8000-000000000001', CREW = 'cccccccc-0000-4000-8000-000000000001';
const OUTSIDE = await mkdtemp(join(tmpdir(), 'argo-outside-')); // 홈의 다른 폴더(~/.ssh 등) 대역
const p = paths(WS);
const PROJ = join(p.vault, 'projects', '20261002_페퍼-아바타');
for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files, PROJ, join(paths(OTHER).vault, 'projects'), join(OUTSIDE, '.ssh')]) await mkdir(d, { recursive: true });
await writeFile(p.company, JSON.stringify({ id: WS, name: 'Lean-AX', lang: 'ko', created: '2026-09-03', ownerId: '11111111-1111-4111-8111-111111111111', msgr: { enabled: true } }));
await writeFile(join(p.root, 'agents', 'pepper.md'), '---\nname: 페퍼\nrole: 모더레이터\n---\n');
await writeFile(join(PROJ, '페퍼-아바타.png'), 'PNGDATA');
await writeFile(join(PROJ, '보고서.pdf'), '%PDF-1.4');
await writeFile(join(p.vault, 'files', 'memo.md'), '# memo');
await writeFile(join(OUTSIDE, '.ssh', 'id_rsa.png'), 'PRIVATE KEY'); // 확장자가 그림이어도 밖이면 안 된다
await writeFile(join(OUTSIDE, 'secret.pdf'), 'SECRET');
await writeFile(join(OUTSIDE, 'report.pdf'), 'OUTSIDE REPORT'); // 비밀 이름이 아닌 밖 파일(이름 규칙이 아니라 경계로 막히는지 보는 용도)
await writeFile(join(paths(OTHER).vault, 'projects', 'their.png'), 'OTHER CO');
await writeFile(join(p.journal, '일지.md'), '# 일지'); // 같은 vault여도 첨부 구역 밖(기억)
await writeFile(join(PROJ, '.env'), 'API_KEY=x');
await writeFile(join(PROJ, 'prod.env'), 'API_KEY=x');
await mkdir(join(PROJ, '.hidden'), { recursive: true });
await writeFile(join(PROJ, '.hidden', 'a.png'), 'HIDDEN');
await symlink(join(OUTSIDE, 'secret.pdf'), join(PROJ, 'link.pdf')); // 파일 심링크 탈출
await symlink(OUTSIDE, join(PROJ, 'escape')); // 폴더 심링크 탈출
await writeFile(join(PROJ, 'big.pdf'), '');
await truncate(join(PROJ, 'big.pdf'), 25 * 1024 * 1024 + 1); // 25MB 초과(희소 파일 — 디스크를 쓰지 않는다)

const AVATAR = join(PROJ, '페퍼-아바타.png');
beforeEach(() => M._uploadedOnceForTest.clear()); // 같은 방·같은 내용 재사용 기억(M-5)은 시험마다 비운다 — 시험끼리 업로드 수가 섞이지 않게

const KIND_OF = { 'bbbbbbbb-0000-4000-8000-000000000002': 'public', 'bbbbbbbb-0000-4000-8000-000000000003': 'public', 'bbbbbbbb-0000-4000-8000-000000000004': 'private' }; // 첨부 재사용 시험 방(CH2~4)
let nextId = 900; // 글 id는 가짜 db 사이에서도 겹치지 않게(저장 경로 <org>/<방>/<글>/… 비교용)
function fakeDb({ finishThrows = 0 } = {}) {
  const calls = [];
  const rec = (k, ...a) => calls.push([k, ...a]);
  const executions = new Map();
  let throwsLeft = finishThrows;
  return {
    calls,
    async orgEntitled() { return true; },
    async orgConsentOk() { return true; },
    async crewBySlug(uid, ws, slug) { return slug === 'pepper' ? { id: CREW, org_id: ORG, slug, display_name: '페퍼' } : null; },
    async channel(id) { return { id, org_id: ORG, kind: KIND_OF[id] ?? 'dm', name: 'dm:페퍼', crew_memory: true }; },
    async memberName() { return '유건'; },
    async contextOf() { return []; },
    async orgCrews() { return [{ id: CREW, slug: 'pepper', display_name: '페퍼', owner_user_id: OWNER, ws_id: WS }]; },
    async channelCrewMembers() { return new Set([CREW]); },
    async settled() { return false; },
    async message() { return null; },
    async org() { return { id: ORG, slug: 'lean-ax', name: 'Lean-AX' }; },
    async attachmentsOf() { return []; },
    async instructCheck() { return 'ok'; },
    async executionStopInfo() { return null; },
    async insertMessage(row) { rec('insertMessage', row); return { id: ++nextId }; },
    async claimExecution(key) {
      rec('claimExecution', key);
      executions.set(`${key.crewId}:${key.msgId}`, { attempt: key.attempt });
      return { acquired: true, state: 'running', heartbeat_at: new Date().toISOString() };
    },
    async finishExecution(key, row) {
      if (throwsLeft > 0) { throwsLeft--; throw new Error('일시 오류'); }
      return this.insertMessage(row);
    },
    async heartbeatExecution() { return true; },
    async insertAttachment(row) { rec('insertAttachment', row); },
    async upload(path, buf, ct) { rec('upload', path, buf.toString(), ct); },
  };
}
const job = (over = {}) => ({ msgId: 51, orgId: ORG, channelId: CH, crewId: CREW, slug: 'pepper', text: '아바타 만들어줘', authorId: OWNER, threadRoot: 51, createdAt: new Date().toISOString(), ...over });
async function runTurn(reply, { db = fakeDb(), j = job() } = {}) {
  const h = M.makeMsgrHandler(WS, { session: async () => ({ db, uid: OWNER }), runChat: async () => ({ reply, handover: null, sessionId: 's1', artifacts: [] }), linkPreview: () => null });
  await h(j);
  const ins = db.calls.filter((c) => c[0] === 'insertMessage').map((c) => c[1]);
  return { db, j, reply: ins.find((r) => r.client_msg_id?.startsWith('reply:')), note: ins.find((r) => r.client_msg_id?.startsWith('attfail:')),
    uploads: db.calls.filter((c) => c[0] === 'upload'), atts: db.calls.filter((c) => c[0] === 'insertAttachment').map((c) => c[1]) };
}
const noLocalPath = (body) => {
  assert.doesNotMatch(body, new RegExp(process.env.ARGO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '본문에 작업 폴더 절대 경로가 남았다');
  assert.doesNotMatch(body, new RegExp(OUTSIDE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '본문에 밖 경로가 남았다');
  assert.doesNotMatch(body, /file:\/\//);
};

test('실사례 재현: 절대 경로 마크다운 이미지·링크 → 같은 파일 한 번 첨부, 본문에서 경로·깨진 그림 제거', async () => {
  const body = `페퍼의 아바타를 만들었습니다. PNG 파일은 [페퍼-아바타.png](${AVATAR})에 저장했습니다.\n\n![페퍼 아바타](${AVATAR})`;
  const r = await runTurn(body);
  assert.equal(r.uploads.length, 1, '같은 파일은 한 번만 첨부');
  assert.equal(r.atts.length, 1);
  assert.equal(r.atts[0].name, '페퍼-아바타.png');
  assert.equal(r.atts[0].mime, 'image/png', '말풍선에 바로 그려지는 그림 mime');
  assert.equal(r.atts[0].org_id, ORG);
  assert.equal(r.uploads[0][2], 'PNGDATA');
  assert.match(r.uploads[0][1], new RegExp(`^${ORG}/${CH}/\\d+/0-[A-Za-z0-9._-]+\\.png$`), '기존 저장 경로 규칙(<org>/<방>/<글>/<키>)');
  noLocalPath(r.reply.body);
  assert.doesNotMatch(r.reply.body, /!\[/, '이미지 마크다운은 첨부로 대신');
  assert.match(r.reply.body, /PNG 파일은 페퍼-아바타\.png에 저장했습니다/, '링크는 글자만 남긴다');
  assert.equal(r.note, undefined, '실패 안내 없음');
});

test('PDF(file:// 링크)와 상대 경로(projects/…) 정상 첨부 — PDF는 내려받기 mime', async () => {
  const r = await runTurn(`보고서: [보고서](${pathToFileURL(join(PROJ, '보고서.pdf')).href}) 메모: [memo](files/memo.md)`);
  assert.deepEqual(r.atts.map((a) => [a.name, a.mime]), [['보고서.pdf', 'application/pdf'], ['memo.md', 'text/markdown']]);
  noLocalPath(r.reply.body);
  assert.match(r.reply.body, /보고서: 보고서 메모: memo/);
});

test('경계 밖 거부: 다른 회사·홈의 다른 폴더·회사 설정 파일·vault 기억 구역·`..` 경로', async () => {
  const refs = [
    join(paths(OTHER).vault, 'projects', 'their.png'),
    join(OUTSIDE, '.ssh', 'id_rsa.png'),
    join(OUTSIDE, 'secret.pdf'),
    p.company,
    join(p.journal, '일지.md'),
    `${PROJ}/../../../company.json`,
    `${p.vault}/projects/../journal/일지.md`,
  ];
  const r = await runTurn(refs.map((x, i) => `![그림${i}](${x}) [파일${i}](${x})`).join('\n'));
  assert.equal(r.uploads.length, 0, '경계 밖은 아무것도 올리지 않는다');
  assert.equal(r.atts.length, 0);
  noLocalPath(r.reply.body);
  assert.ok(r.note, '거부도 침묵하지 않는다');
  noLocalPath(r.note.body);
  assert.match(r.note.body, /작업 폴더 밖/);
});

test('심링크 탈출 거부 — 파일 심링크·폴더 심링크 모두', async () => {
  const r = await runTurn(`[a](${join(PROJ, 'link.pdf')}) [b](${join(PROJ, 'escape', 'secret.pdf')}) [c](projects/20261002_페퍼-아바타/link.pdf)`);
  assert.equal(r.uploads.length, 0);
  assert.equal(r.uploads.some((u) => u[2] === 'SECRET'), false);
  noLocalPath(r.reply.body);
});

test('.env·숨김 파일·숨김 폴더 거부', async () => {
  const r = await runTurn(`[e](${join(PROJ, '.env')}) [p](${join(PROJ, 'prod.env')}) ![h](${join(PROJ, '.hidden', 'a.png')})`);
  assert.equal(r.uploads.length, 0);
  noLocalPath(r.reply.body);
  assert.ok(r.note);
});

test('크기 초과(25MB) 거부·구역 안 없는 파일은 "파일이 없습니다" — 경로는 본문·안내 어디에도 없다', async () => {
  const r = await runTurn(`[큰 파일](${join(PROJ, 'big.pdf')}) ![없음](${join(PROJ, 'none.png')})`);
  assert.equal(r.uploads.length, 0);
  assert.match(r.note.body, /big\.pdf.*25MB 초과/s);
  assert.match(r.note.body, /none\.png.*파일이 없습니다/s);
  noLocalPath(r.reply.body); noLocalPath(r.note.body);
  // 구역 밖은 있든 없든 같은 사유 하나 — 존재 여부를 방에 흘리지 않는다(N-5)
  const outside = await runTurn(`[a](${join(OUTSIDE, 'report.pdf')}) [b](${join(OUTSIDE, 'nope.pdf')})`, { j: job({ msgId: 91, threadRoot: 91 }) });
  assert.match(outside.note.body, /report\.pdf: 작업 폴더 밖이거나 없는 파일/);
  assert.match(outside.note.body, /nope\.pdf: 작업 폴더 밖이거나 없는 파일/);
  assert.doesNotMatch(outside.note.body, /파일이 없습니다/);
  assert.equal(outside.reply.body, 'a b');
});

test('한 답 첨부 상한 10개 — 넘는 것은 안내', async () => {
  for (let i = 0; i < 12; i++) await writeFile(join(PROJ, `n${i}.png`), `N${i}`);
  const r = await runTurn(Array.from({ length: 12 }, (_, i) => `![n${i}](${join(PROJ, `n${i}.png`)})`).join('\n'));
  assert.equal(r.uploads.length, 10);
  assert.match(r.note.body, /n11\.png/);
  noLocalPath(r.reply.body);
});

test('코드 블록 안의 경로는 손대지 않고 첨부하지 않는다', async () => {
  const body = `예시:\n\`\`\`md\n![x](${AVATAR})\n\`\`\``;
  const r = await runTurn(body);
  assert.equal(r.uploads.length, 0);
  assert.equal(r.reply.body, body);
});

test('개인 공간(org 없음) — p/<방>/<글>/<키> 경로, 첨부 행 org_id null', async () => {
  const r = await runTurn(`![a](${AVATAR})`, { j: job({ orgId: null, msgId: 61, threadRoot: 61 }) });
  assert.equal(r.uploads.length, 1);
  assert.match(r.uploads[0][1], new RegExp(`^p/${CH}/\\d+/0-`));
  assert.equal(r.atts[0].org_id, null);
  assert.ok(r.reply.body.trim().length > 0, '이미지만 있던 답도 빈 본문이 아니다(DB 제약 btrim ≥ 1)');
  noLocalPath(r.reply.body);
});

test('답글 게시 재시도 — 본문에서 경로를 지웠어도 저장해 둔 첨부 목록으로 다시 첨부한다', async () => {
  const db1 = fakeDb({ finishThrows: 2 });
  const j = job({ msgId: 71, threadRoot: 71 });
  const h1 = M.makeMsgrHandler(WS, { session: async () => ({ db: db1, uid: OWNER }), runChat: async () => ({ reply: `![a](${AVATAR})`, sessionId: null, artifacts: [] }), linkPreview: () => null });
  await assert.rejects(h1(j), /일시 오류/);
  assert.ok(j.msgrExecution?.replyRow, '결과가 잡에 보존됐다');
  noLocalPath(j.msgrExecution.replyRow.body);
  const db2 = fakeDb();
  const h2 = M.makeMsgrHandler(WS, { session: async () => ({ db: db2, uid: OWNER }), runChat: async () => { throw new Error('유료 턴 재실행 금지'); }, linkPreview: () => null });
  await h2(j);
  assert.equal(db2.calls.filter((c) => c[0] === 'upload').length, 1, '재시도에서도 첨부된다');
});

test('결재·장시간 후속(msgrPush) 답에도 같은 규칙', async () => {
  const db = fakeDb();
  const origin = { orgId: ORG, channelId: CH, crewId: CREW, threadRoot: 81, sourceMsgId: 81, uid: OWNER, wsId: WS, origin: OWNER, hop: 0 };
  db.channel = async (id) => ({ id, org_id: ORG, kind: 'private', name: 'Crew', crew_memory: true });
  db.message = async (id) => ({ id, channel_id: CH, author_kind: 'user', author_user_id: OWNER, body: '원래 지시' });
  const ok = await M.msgrPush({ type: 'job', wsId: WS, id: 'job-1', slug: 'pepper', ok: true, msgr: origin, reply: `완료했습니다. ![a](${AVATAR}) [밖](${join(OUTSIDE, 'secret.pdf')})` }, { session: async () => ({ db, uid: OWNER }) });
  assert.equal(ok, true);
  const ins = db.calls.filter((c) => c[0] === 'insertMessage').map((c) => c[1]);
  const post = ins.find((r) => r.client_msg_id.startsWith('ct:'));
  noLocalPath(post.body);
  assert.deepEqual(db.calls.filter((c) => c[0] === 'upload').map((c) => c[2]), ['PNGDATA']);
  const note = ins.find((r) => r.client_msg_id.startsWith('attfail:'));
  assert.ok(note); noLocalPath(note.body);
});

test('루틴 결과 글(msgr 알림 채널)에도 같은 규칙 — 그림 첨부, 본문 경로 제거', async () => {
  const db = fakeDb();
  db.myCrews = async () => [{ id: CREW, org_id: ORG, slug: 'pepper', display_name: '페퍼' }];
  db.crewScope = async () => new Set([CH]);
  const table = { msgr_org_members: [{ org_id: ORG, expires_at: null, msgr_orgs: { id: ORG, name: 'Lean-AX', deleted_at: null } }],
    msgr_channels: [{ id: CH, org_id: ORG, kind: 'public', name: 'general', archived_at: null, excluded_crew_ids: [] }] };
  const client = { from(t) { const q = { select: () => q, eq: () => q, is: () => q, in: () => q, then: (ok, no) => Promise.resolve({ data: table[t] }).then(ok, no) }; return q; } };
  const ok = await M.msgrPush({ type: 'routine', wsId: WS, ok: true, runAt: '2026-10-02T09:00:00Z', reply: `오늘 아바타 시안: ![a](${AVATAR})\nMSGR: done`,
    routine: { id: 'r1', title: '아침 시안', agentSlug: 'pepper', notifications: { channels: ['msgr'], msgr: { orgId: ORG, channelId: CH } } } },
  { session: async () => ({ db, client, uid: OWNER }) });
  assert.equal(ok, true);
  const post = db.calls.find((c) => c[0] === 'insertMessage' && c[1].client_msg_id.startsWith('rn:'))[1];
  noLocalPath(post.body);
  assert.match(post.body, /^\[루틴\] 아침 시안\n\n오늘 아바타 시안:/);
  assert.deepEqual(db.calls.filter((c) => c[0] === 'upload').map((c) => c[2]), ['PNGDATA']);
});

test('대상 꼴: 제목 붙은 링크·괄호 든 이름·<…> 꼴(공백)·~/ 경로 — 정상 판정', async () => {
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  await writeFile(join(PROJ, '노트 (1).pdf'), 'P1');
  await writeFile(join(PROJ, 'my file.png'), 'SP');
  const r = await planReplyFiles(WS, `[a](${AVATAR} "제목") [노트](${join(PROJ, '노트 (1).pdf')}) ![b](<${join(PROJ, 'my file.png')}>) [홈](~/.ssh/id_rsa) [웹](https://a.com/files/x.png)`);
  assert.deepEqual(r.files.map((f) => f.name), ['페퍼-아바타.png', '노트 (1).pdf', 'my file.png']);
  assert.equal(r.body, 'a 노트  홈 [웹](https://a.com/files/x.png)', '웹 링크는 그대로, 로컬 경로는 글자만');
  assert.deepEqual(r.fails.map((f) => f.name), ['id_rsa']);
});

test('긴 악성 입력도 선형 시간 — 게이트웨이를 멈추지 않는다(예전 꼴은 공백 8천 개에 282초)', async () => {
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  const n = 100_000;
  for (const s of ['[a](x' + ' '.repeat(n), '[a](x' + ' '.repeat(n) + '"', '['.repeat(n), '[a'.repeat(n / 2) + '](', '[a](' + ' "x'.repeat(n / 3), '```'.repeat(n / 3)]) {
    const t = Date.now();
    await planReplyFiles(WS, s);
    assert.ok(Date.now() - t < 1500, `입력 ${JSON.stringify(s.slice(0, 8))}… 처리에 ${Date.now() - t}ms`);
  }
});

test('크루 프롬프트(chat.mjs 메신저 턴 안내)의 예시 꼴이 실제로 첨부된다 — 아르고 메신저 planReplyFiles·텔레그램 extractFileRefs 둘 다', async () => {
  const { readFile } = await import('node:fs/promises');
  const { planReplyFiles, REPLY_FILES_MAX } = await import('../src/gateway/msgr-reply-files.mjs');
  const { extractFileRefs } = await import('../src/tg-format.mjs');
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  for (const [lang, re] of [['ko', /\(예: (!\[시안\]\(([^)]+)\)), (\[보고서\.pdf\]\(([^)]+)\))\)/], ['en', /\(e\.g\. (!\[draft\]\(([^)]+)\)), (\[report\.pdf\]\(([^)]+)\))\)/]]) {
    const m = chat.match(re);
    assert.ok(m, `프롬프트 예시(${lang})를 찾지 못했다`);
    for (const rel of [m[2], m[4]]) { await mkdir(join(p.vault, rel, '..'), { recursive: true }); await writeFile(join(p.vault, rel), 'X'); }
    const r = await planReplyFiles(WS, `완성: ${m[1]} ${m[3]}`, { lang });
    assert.equal(r.files.length, 2, `메신저(${lang}): 예시 두 파일 모두 첨부`);
    assert.doesNotMatch(r.body, /projects\//, '본문에서 경로가 지워진다');
    assert.deepEqual(extractFileRefs(`완성: ${m[1]} ${m[3]}`), [m[2], m[4]], `텔레그램(${lang}): 같은 꼴을 잡는다`);
  }
  assert.match(chat, new RegExp(`답변당 최대 ${REPLY_FILES_MAX}개`), '프롬프트 상한 = 코드 상한');
});

// ── 분리 검수 지적 반영(2026-10-02) ─────────────────────────────────────────────
// M-1: 마크다운 링크 경로가 확장자를 보지 않아 첨부 구역 안의 설정·비밀 파일이 방에 올라갔다(검수 재현 목록 그대로).
const IMP = join(p.vault, '_imported');
const UNSORTED = join(IMP, 'unsorted', 'Personal');
const LEAKS = [ // 검수가 재현한 파일 — 전부 첨부 구역(vault/projects·_imported) 안
  join(UNSORTED, 'credentials.json'), join(PROJ, 'secrets.yaml'), join(PROJ, 'wallet.kdbx'), join(PROJ, 'auth.json'),
  join(PROJ, 'notes.sqlite'), join(PROJ, 'server.key'), join(IMP, 'manifest.json'),
];
await mkdir(UNSORTED, { recursive: true });
for (const f of LEAKS) await writeFile(f, 'SENSITIVE');
await writeFile(join(UNSORTED, 'plan.pdf'), 'UNSORTED PDF'); // 허용 확장자여도 unsorted는 구역 밖
await writeFile(join(IMP, 'imported-report.pdf'), 'IMPORTED PDF'); // _imported의 정리된 산출물은 그대로 붙는다
await writeFile(join(PROJ, 'token.pdf'), 'T'); // 비밀 이름(token)은 허용 확장자여도 거부
await writeFile(join(PROJ, 'api.db'), 'DB');

test('M-1 검수 재현: 구역 안 설정·비밀 파일(credentials.json·secrets.yaml·wallet.kdbx·auth.json·notes.sqlite·server.key·_imported/manifest.json)은 상대·절대 링크 모두 첨부하지 않는다', async () => {
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  const rel = (abs) => abs.slice(p.vault.length + 1);
  for (const shape of [(f) => `[x](${rel(f)})`, (f) => `[x](${f})`, (f) => `[x](${pathToFileURL(f).href})`, (f) => `![x](${f})`]) {
    const r = await planReplyFiles(WS, LEAKS.map(shape).join('\n'));
    assert.deepEqual(r.files.map((f) => f.name), [], `첨부 대상이 되면 안 된다: ${shape('…')}`);
    assert.equal(r.fails.length, LEAKS.length, '거부도 침묵하지 않는다');
    assert.doesNotMatch(r.body, new RegExp(p.vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '본문에 작업 폴더 경로가 남지 않는다');
  }
  const r = await runTurn(LEAKS.map((f) => `[x](${rel(f)})`).join(' '), { j: job({ msgId: 101, threadRoot: 101 }) });
  assert.equal(r.uploads.length, 0, '방에 아무것도 올라가지 않는다');
  assert.equal(r.uploads.some((u) => u[2] === 'SENSITIVE'), false);
});

test('M-1: _imported/unsorted/는 구역 밖(허용 확장자여도) · 비밀 이름(token·.db)은 거부 · 정리된 _imported 산출물은 그대로 첨부', async () => {
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  const r = await planReplyFiles(WS, `[a](_imported/unsorted/Personal/plan.pdf) [b](${join(UNSORTED, 'plan.pdf')}) [c](${join(PROJ, 'token.pdf')}) [d](${join(PROJ, 'api.db')}) [e](_imported/imported-report.pdf) _imported/unsorted/Personal/plan.pdf`);
  assert.deepEqual(r.files.map((f) => f.name), ['imported-report.pdf']);
  assert.deepEqual(r.fails.map((f) => f.name).sort(), ['api.db', 'plan.pdf', 'token.pdf'].sort());
});

test('M-1: 결과물 확장자 허용 목록은 한 곳 — 텔레그램 extractFileRefs와 메신저 마크다운 경로가 같은 목록을 쓴다', async () => {
  const { ATTACH_EXT, extractFileRefs } = await import('../src/tg-format.mjs');
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  assert.ok(ATTACH_EXT instanceof RegExp);
  await writeFile(join(PROJ, 'ok.csv'), 'a,b');
  await writeFile(join(PROJ, 'no.json'), '{}');
  assert.equal(ATTACH_EXT.test('ok.csv'), true); assert.equal(ATTACH_EXT.test('no.json'), false);
  assert.deepEqual(extractFileRefs('projects/20261002_페퍼-아바타/ok.csv projects/20261002_페퍼-아바타/no.json', { max: 10 }), ['projects/20261002_페퍼-아바타/ok.csv']);
  const r = await planReplyFiles(WS, `[a](${join(PROJ, 'ok.csv')}) [b](${join(PROJ, 'no.json')})`);
  assert.deepEqual(r.files.map((f) => f.name), ['ok.csv']);
});

// L-2: `/login`·`/api/v1/users` 같은 웹 경로 링크를 로컬 파일로 판정해 본문에서 지우고 '작업 폴더 밖' 안내를 따로 붙였다.
// N-5(2차): 존재 여부로 가르면 없는 파일 경로가 본문에 남고(D26 위반) 링크 하나로 파일이 있는지 알아낼 수 있다 → 경로 모양으로만 가른다.
test('L-2: 확장자 없고 홈·작업 루트·임시 폴더 밖인 절대 경로(웹 경로 링크)는 본문 그대로, 실패 안내 없음', async () => {
  const body = '로그인은 [로그인 화면](/login)에서, 목록은 [사용자 API](/api/v1/users)로 받습니다. [인증](/auth) [토큰](/api/token)';
  const r = await runTurn(body, { j: job({ msgId: 111, threadRoot: 111 }) });
  assert.equal(r.reply.body, body, '웹 경로 링크는 손대지 않는다(비밀 낱말 auth·token으로 끝나도)');
  assert.equal(r.note, undefined, '실패 안내를 붙이지 않는다');
  assert.equal(r.uploads.length, 0);
});

test('N-5: 구역 밖 경로는 있는 파일과 없는 파일의 결과가 같다 — 홈·작업 루트·임시 폴더 아래면 지우고 같은 안내, 아니면 둘 다 그대로', async () => {
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  const { homedir } = await import('node:os');
  await mkdir(join(OUTSIDE, 'dir-exists'), { recursive: true });
  const pairs = [ // [있는 것, 없는 것]
    [join(OUTSIDE, 'report.pdf'), join(OUTSIDE, 'nope.pdf')],                       // 임시 폴더 아래 파일
    [join(OUTSIDE, 'dir-exists'), join(OUTSIDE, 'dir-nope')],                        // 임시 폴더 아래(확장자 없음)
    [homedir(), join(homedir(), 'nobody-xyz-argo', 'Desktop', 'plan')],              // 홈 아래(확장자 없음)
    ['/usr', '/usrx-argo-nope'],                                                     // 홈·임시 밖 → 둘 다 손대지 않는다
    ['/etc/hosts', '/etc/argo-nope-hosts.pdf'],                                      // 홈·임시 밖은 확장자가 있어도 손대지 않는다(F-3)
    ['/Users/Shared', '/Users/argo-nope-xyz'],                                        // 로컬 위치 첫 칸 + 칸 둘 이상(MEDIUM-4·LOW-4) — 둘 다 지운다
    ['/Users/Shared', '/Users/Shared/argo-nope/draft.png'],
    ['/Volumes', '/Volumes-argo-nope'],                                               // 칸 하나뿐인 로컬 첫 칸은 웹 경로로 본다(LOW-4) — 둘 다 그대로
  ];
  const shape = (r) => ({ body: r.body.replace(/\S*(nope|exists|nobody|usr|report|hosts|Volumes|Shared)\S*/g, 'X'), files: r.files.length, fails: r.fails.map((f) => f.reason) });
  for (const [there, absent] of pairs) {
    const a = await planReplyFiles(WS, `[링크](${there})`);
    const b = await planReplyFiles(WS, `[링크](${absent})`);
    assert.deepEqual(shape(a), shape(b), `있음/없음 결과가 같아야 한다: ${there} / ${absent}`);
  }
  const home = await planReplyFiles(WS, `[계획](${join(homedir(), 'nobody-xyz-argo', 'Desktop', 'plan.pdf')})`);
  assert.equal(home.body, '계획', '홈 아래 없는 파일 경로도 본문에서 지운다(D26)');
  assert.match(home.fails[0].reason, /작업 폴더 밖이거나 없는 파일/);
  const web = await planReplyFiles(WS, '[x](/usr) [y](/usrx-argo-nope)');
  assert.equal(web.body, '[x](/usr) [y](/usrx-argo-nope)');
  assert.deepEqual(web.fails, []);
});

test('N-4: 비밀 낱말(password·api key·private key·service account·camelCase Token)과 하드 링크는 첨부하지 않는다', async () => {
  const { planReplyFiles, readReplyFile } = await import('../src/gateway/msgr-reply-files.mjs');
  const { link } = await import('node:fs/promises');
  const names = ['passwords.csv', 'api_keys.csv', 'accessToken.md', 'private-key.md', 'service-account.md', 'passwd.md', 'apiKey.md'];
  for (const n of names) await writeFile(join(PROJ, n), 'SENSITIVE');
  const r = await planReplyFiles(WS, names.map((n) => `[x](${join(PROJ, n)})`).join(' '));
  assert.deepEqual(r.files.map((f) => f.name), []);
  assert.deepEqual(r.fails.map((f) => f.name).sort(), [...names].sort());
  // 낱말 경계 — 평범한 이름은 그대로(tokenizer·passage·keynote·author)
  for (const n of ['tokenizer-diagram.png', 'passage.md', 'keynote.pdf', 'author.pdf', 'monkey.png']) await writeFile(join(PROJ, n), 'OK');
  const ok = await planReplyFiles(WS, ['tokenizer-diagram.png', 'passage.md', 'keynote.pdf', 'author.pdf', 'monkey.png'].map((n) => `[x](${join(PROJ, n)})`).join(' '));
  assert.equal(ok.files.length, 5, ok.fails.map((f) => f.name).join(','));
  // 하드 링크: 밖 파일과 같은 inode를 구역 안 이름으로 가리킨다 — realpath로는 못 가른다
  await link(join(OUTSIDE, 'report.pdf'), join(PROJ, 'hard.pdf'));
  const h = await planReplyFiles(WS, `[h](${join(PROJ, 'hard.pdf')})`);
  assert.deepEqual(h.files, []);
  assert.match(h.fails[0].reason, /하드 링크라서 보내지 않았습니다/);
  assert.match(r.fails[0].reason, /비밀 정보가 담긴 이름으로 보여 보내지 않았습니다/);
  // 계획 뒤에 하드 링크가 생겨도 읽을 때 다시 막는다
  await writeFile(join(PROJ, 'later.pdf'), 'LEGIT');
  const plan = await planReplyFiles(WS, `[l](${join(PROJ, 'later.pdf')})`);
  assert.equal(plan.files.length, 1);
  await link(join(PROJ, 'later.pdf'), join(OUTSIDE, 'later-copy.pdf'));
  await assert.rejects(readReplyFile(WS, plan.files[0]), (e) => e.roomSafe === true && /하드 링크/.test(e.message));
});

// 3차 검수 F-2: 구역 안 심링크 폴더가 밖을 가리키면, 있는 파일은 '밖'·없는 파일은 '없음'으로 갈려 밖에 파일이 있는지 드러났다.
test('F-2: 구역 안 심링크 폴더를 거친 경로는 있든 없든 같은 사유("밖이거나 없는 파일") — 구역 안 진짜 폴더의 없는 파일만 "없음"', async () => {
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  // PROJ/escape → OUTSIDE(심링크 폴더, 맨 위에서 만들었다). OUTSIDE/report.pdf는 있고 OUTSIDE/nope.pdf는 없다
  for (const shape of [(n) => join(PROJ, 'escape', n), (n) => `projects/20261002_페퍼-아바타/escape/${n}`]) {
    const there = await planReplyFiles(WS, `[a](${shape('report.pdf')})`);
    const absent = await planReplyFiles(WS, `[a](${shape('nope.pdf')})`);
    assert.deepEqual(absent.fails.map((f) => f.reason), there.fails.map((f) => f.reason), `있음/없음 같은 사유: ${shape('…')}`);
    assert.match(absent.fails[0].reason, /작업 폴더 밖이거나 없는 파일/);
    assert.equal(absent.body, there.body);
  }
  const deeper = await planReplyFiles(WS, `[a](${join(PROJ, 'escape', 'no-dir', 'x.pdf')})`); // 없는 하위 폴더까지 — 가장 가까운 있는 부모(escape)가 밖
  assert.match(deeper.fails[0].reason, /작업 폴더 밖이거나 없는 파일/);
  const real = await planReplyFiles(WS, `[a](${join(PROJ, 'nope.pdf')}) [b](${join(p.vault, 'projects', 'no-such-dir', 'x.pdf')})`);
  assert.deepEqual(real.fails.map((f) => f.reason), ['파일이 없습니다', '파일이 없습니다'], '구역 안 진짜 폴더(없는 하위 폴더 포함)는 그대로 "없음"');
});

// 통합본 재검수 MEDIUM-4: 홈·작업 루트 밖이라도 로컬 위치(외장 볼륨·공유 사용자 폴더·/opt 등)나 드라이브 문자 경로가 본문에 그대로 남아
// 고객사 폴더 이름이 손님에게 보이고, 크루는 보냈다고 믿는데 사용자는 깨진 링크만 받았다.
test('MEDIUM-4·LOW-4·LOW-5: 로컬 위치 첫 칸(/Volumes·/Users·/home·/mnt·/opt·/private·/var/folders, 칸 둘 이상)·/media/<사용자>/…·/run/media/<사용자>/…·드라이브 문자 경로(/C:/ 포함)는 지우고 안내 하나 — 웹 경로는 그대로', async () => {
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  const local = [
    ['[계약서](/Volumes/고객사A/계약/계약서.pdf)', '계약서'], ['![시안](/Users/Shared/고객B/draft.png)', '시안'], ['[x](/opt/acme-client/report.pdf)', 'x'],
    ['[a](/home/kim/고객C/a.pdf)', 'a'], ['[b](/mnt/nas/고객D/b.png)', 'b'], [`[c](/media/${userInfo().username}/USB/고객E/c.pdf)`, 'c'], [`[r](/run/media/${userInfo().username}/USB/a.pdf)`, 'r'], ['[d](/private/etc/고객F.pdf)', 'd'],
    ['[e](/var/folders/zz/고객G.pdf)', 'e'], ['[윈](C:\\Users\\kim\\고객H\\견적.pdf)', '윈'], ['[윈2](D:/고객I/시안.png)', '윈2'], ['[윈3](c:/x.pdf)', '윈3'],
    ['[L](file:///C:/Users/kim/고객J/x.pdf)', 'L'], ['[L2](/C:/Users/kim/고객K/y.pdf)', 'L2'], // macOS fileURLToPath가 돌려주는 /C:/… 꼴(LOW-5)
  ];
  for (const [src, text] of local) {
    const r = await planReplyFiles(WS, src);
    assert.equal(r.body, text, `경로를 지운다: ${src}`);
    assert.doesNotMatch(r.body, /고객/);
    assert.equal(r.fails.length, 1, `안내 하나: ${src}`);
    assert.match(r.fails[0].reason, /작업 폴더 밖이거나 없는 파일/);
    assert.equal(r.fails[0].name, src.match(/\(([^)]*)\)/)[1].split(/[\\/]/).pop(), `안내에는 마지막 이름만(폴더 이름 없이): ${r.fails[0].name}`);
    assert.deepEqual(r.files, []);
  }
  const web = '[가이드](/docs/guide.pdf) [로그인](/login) [옵션](/optional/x.pdf) [볼륨](/volumes-info) [홈](/homepage)'
    + ' [로고](/media/logo.png) [업로드](/media/uploads/2024/x.png) [h](/home) [o](/opt) [m](/mnt) [u](/Users) [v](/Volumes) [md](/media) [rm](/run/media/x) [rm2](/run/media)';
  const w = await planReplyFiles(WS, web);
  assert.equal(w.body, web, '첫 칸이 목록과 정확히 같고 칸이 둘 이상일 때만 로컬 위치 — /media는 두 번째 칸이 이 컴퓨터 사용자 이름일 때만(LOW-4)');
  assert.deepEqual(w.fails, []);
});

// 3차 검수 F-3: 확장자만으로 지우다 보니 `[가이드](/docs/guide.pdf)` 같은 웹 다운로드 링크가 사라졌다.
test('F-3: 홈·작업 루트·임시 폴더 밖 절대 경로는 확장자가 있어도 본문 그대로 — 홈 판정은 macOS에서 대소문자를 무시한다', async () => {
  const { planReplyFiles } = await import('../src/gateway/msgr-reply-files.mjs');
  const { homedir } = await import('node:os');
  const web = '[가이드](/docs/guide.pdf) [호스트](/etc/hosts) [이미지](/static/logo.png)';
  const r = await planReplyFiles(WS, web);
  assert.equal(r.body, web);
  assert.deepEqual(r.fails, []);
  if (process.platform === 'darwin') {
    const upper = join(homedir().toUpperCase(), 'Desktop', 'plan.pdf');
    const h = await planReplyFiles(WS, `[계획](${upper})`);
    assert.equal(h.body, '계획', '대문자로 쓴 홈 경로도 지운다');
    assert.match(h.fails[0].reason, /작업 폴더 밖이거나 없는 파일/);
  }
});

// M-5: 같은 파일을 답마다 새 경로로 다시 올렸다(루틴 결과 글·대화 중 같은 시안 재언급). 같은 방에 이미 올린 같은 내용이면 기존 객체를 재사용한다.
const CH2 = 'bbbbbbbb-0000-4000-8000-000000000002', CH3 = 'bbbbbbbb-0000-4000-8000-000000000003', CH4 = 'bbbbbbbb-0000-4000-8000-000000000004';
test('M-5: 같은 방·같은 내용은 다시 올리지 않고 기존 저장 경로로 첨부 행만 만든다 — 다른 방·바뀐 내용은 새로 올린다, DB 조회 추가 0', async () => {
  const a = await runTurn(`![a](${AVATAR})`, { j: job({ channelId: CH2, msgId: 121, threadRoot: 121 }) });
  assert.equal(a.uploads.length, 1);
  const first = a.atts[0].storage_path;
  const db = fakeDb();
  const b = await runTurn(`다시 보냅니다 ![a](${AVATAR})`, { db, j: job({ channelId: CH2, msgId: 122, threadRoot: 122 }) });
  assert.equal(b.uploads.length, 0, '같은 방·같은 내용은 다시 올리지 않는다');
  assert.equal(b.atts.length, 1);
  assert.deepEqual({ ...b.atts[0], message_id: 0 }, { ...a.atts[0], message_id: 0 }, '저장 경로·이름·mime·크기는 첫 첨부와 같다');
  assert.notEqual(b.atts[0].message_id, a.atts[0].message_id, '첨부 행은 새 글에 붙는다');
  assert.equal(b.note, undefined);
  assert.deepEqual([...new Set(db.calls.map((c) => c[0]))].sort(), ['claimExecution', 'insertAttachment', 'insertMessage'].sort(), '재사용 판정에 DB 조회를 더하지 않는다');
  // 같은 내용, 다른 이름 — 객체는 재사용하고 이름은 새 이름으로
  await writeFile(join(PROJ, '아바타-사본.png'), 'PNGDATA');
  const c = await runTurn(`![a](${join(PROJ, '아바타-사본.png')})`, { j: job({ channelId: CH2, msgId: 123, threadRoot: 123 }) });
  assert.equal(c.uploads.length, 0);
  assert.equal(c.atts[0].storage_path, first);
  assert.equal(c.atts[0].name, '아바타-사본.png');
  // 다른 방은 새로 올린다(읽기 권한이 방 단위)
  const d = await runTurn(`![a](${AVATAR})`, { j: job({ channelId: CH3, msgId: 124, threadRoot: 124 }) });
  assert.equal(d.uploads.length, 1);
  // 내용이 바뀌면 새로 올린다
  await writeFile(join(PROJ, 'draft.png'), 'V1');
  const e1 = await runTurn(`![a](${join(PROJ, 'draft.png')})`, { j: job({ channelId: CH2, msgId: 125, threadRoot: 125 }) });
  await writeFile(join(PROJ, 'draft.png'), 'V2');
  const e2 = await runTurn(`![a](${join(PROJ, 'draft.png')})`, { j: job({ channelId: CH2, msgId: 126, threadRoot: 126 }) });
  assert.deepEqual([e1.uploads.length, e2.uploads.length], [1, 1]);
  assert.equal(e2.uploads[0][2], 'V2');
});

test('M-5: 재사용 첨부 행이 거부되면 예전처럼 새로 올린다 · 개인 방은 정책상 자기 글 경로만 받으므로 재사용하지 않는다', async () => {
  const seed = await runTurn(`![a](${AVATAR})`, { j: job({ channelId: CH4, msgId: 131, threadRoot: 131 }) });
  const cached = seed.atts[0].storage_path;
  const db = fakeDb();
  db.insertAttachment = async (row) => { if (row.storage_path === cached) throw new Error('rls'); db.calls.push(['insertAttachment', row]); };
  const r = await runTurn(`![a](${AVATAR})`, { db, j: job({ channelId: CH4, msgId: 132, threadRoot: 132 }) });
  assert.equal(r.uploads.length, 1, '재사용이 막히면 새로 올린다');
  assert.equal(r.atts.length, 1);
  assert.notEqual(r.atts[0].storage_path, cached);
  assert.equal(r.note, undefined, '사용자에게는 실패가 아니다');
  const p1 = await runTurn(`![a](${AVATAR})`, { j: job({ orgId: null, channelId: CH4, msgId: 133, threadRoot: 133 }) });
  const p2 = await runTurn(`![a](${AVATAR})`, { j: job({ orgId: null, channelId: CH4, msgId: 134, threadRoot: 134 }) });
  assert.deepEqual([p1.uploads.length, p2.uploads.length], [1, 1], '개인 방은 매번 자기 글 경로로');
  assert.match(p2.atts[0].storage_path, /^p\//);
  assert.notEqual(p2.atts[0].storage_path, p1.atts[0].storage_path);
});

test('N-2: DM 방은 첨부를 재사용하지 않는다(위임 주인 읽기 판정이 경로의 글을 본다) · 방 종류를 모르면 재사용하지 않는다', async () => {
  const DM = 'bbbbbbbb-0000-4000-8000-000000000005'; // KIND_OF에 없음 → fakeDb.channel이 dm
  const a = await runTurn(`![a](${AVATAR})`, { j: job({ channelId: DM, msgId: 141, threadRoot: 141 }) });
  const b = await runTurn(`![a](${AVATAR})`, { j: job({ channelId: DM, msgId: 142, threadRoot: 142 }) });
  assert.deepEqual([a.uploads.length, b.uploads.length], [1, 1], 'DM은 매번 자기 글 경로로');
  assert.notEqual(b.atts[0].storage_path, a.atts[0].storage_path);
});

test('M-5: 루틴 결과 글은 한 답 첨부 상한 3개', async () => {
  const db = fakeDb();
  db.myCrews = async () => [{ id: CREW, org_id: ORG, slug: 'pepper', display_name: '페퍼' }];
  db.crewScope = async () => new Set([CH]);
  const table = { msgr_org_members: [{ org_id: ORG, expires_at: null, msgr_orgs: { id: ORG, name: 'Lean-AX', deleted_at: null } }],
    msgr_channels: [{ id: CH, org_id: ORG, kind: 'public', name: 'general', archived_at: null, excluded_crew_ids: [] }] };
  const client = { from(t) { const q = { select: () => q, eq: () => q, is: () => q, in: () => q, then: (ok, no) => Promise.resolve({ data: table[t] }).then(ok, no) }; return q; } };
  for (let i = 0; i < 5; i++) await writeFile(join(PROJ, `r${i}.png`), `R${i}`);
  const ok = await M.msgrPush({ type: 'routine', wsId: WS, ok: true, runAt: '2026-10-02T10:00:00Z', reply: Array.from({ length: 5 }, (_, i) => `![r${i}](${join(PROJ, `r${i}.png`)})`).join('\n'),
    routine: { id: 'r2', title: '시안 다섯 장', agentSlug: 'pepper', notifications: { channels: ['msgr'], msgr: { orgId: ORG, channelId: CH } } } },
  { session: async () => ({ db, client, uid: OWNER }) });
  assert.equal(ok, true);
  assert.equal(db.calls.filter((c) => c[0] === 'upload').length, 3);
  const note = db.calls.find((c) => c[0] === 'insertMessage' && c[1].client_msg_id.startsWith('attfail:'))[1];
  assert.match(note.body, /r3\.png: 한 답에 최대 3개까지/);
});

// L-6: 읽기 직전 경로를 다시 stat해 inode를 대조했다 — 중간 폴더를 심링크로 바꾸면 open과 stat이 같은 바꿔치기를 따라가 통과했다.
test('L-6: 계획 뒤 중간 폴더를 심링크로 바꿔치기해도 밖 파일을 읽지 않는다(열린 fd의 fstat와 열고 난 뒤의 realpath·stat 대조)', async () => {
  const { planReplyFiles, readReplyFile } = await import('../src/gateway/msgr-reply-files.mjs');
  const fsp = await import('node:fs/promises');
  const SWAP = join(p.vault, 'projects', 'swap');
  const EVIL = join(OUTSIDE, 'evil');
  await mkdir(SWAP, { recursive: true }); await mkdir(EVIL, { recursive: true });
  await writeFile(join(SWAP, 'a.pdf'), 'LEGIT'); await writeFile(join(EVIL, 'a.pdf'), 'OUTSIDE SECRET');
  const plan = await planReplyFiles(WS, `[a](${join(SWAP, 'a.pdf')})`);
  assert.equal(plan.files.length, 1);
  assert.equal((await readReplyFile(WS, plan.files[0])).toString(), 'LEGIT', '바꿔치기 없으면 정상');
  const swapIn = async () => { await fsp.rename(SWAP, `${SWAP}.real`); await fsp.symlink(EVIL, SWAP); };
  const swapBack = async () => { await fsp.unlink(SWAP); await fsp.rename(`${SWAP}.real`, SWAP); };
  // ① open 직전에 바꿔치기하고 그대로 둔다
  const io1 = { ...fsp, open: async (...a) => { await swapIn(); return fsp.open(...a); } };
  await assert.rejects(readReplyFile(WS, plan.files[0], 'ko', io1), (e) => e.roomSafe === true, '밖 파일을 읽으면 안 된다');
  await swapBack();
  // ② open 직전에 바꿔치기하고 열자마자 되돌린다(열린 fd만 밖을 가리킨다)
  const io2 = { ...fsp, open: async (...a) => { await swapIn(); const fh = await fsp.open(...a); await swapBack(); return fh; } };
  await assert.rejects(readReplyFile(WS, plan.files[0], 'ko', io2), (e) => e.roomSafe === true, '열린 fd가 밖이면 거부');
});
