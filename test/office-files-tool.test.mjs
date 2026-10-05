// 에이전트 문서함·드라이브 도구(office_files) — 분리 검수 MEDIUM 4(PARITY-B V14·O2·C9): 인트라넷 docs_list·docs_read·docs_upload·customers_attach·drive_list·drive_mkdir·drive_upload를 오피스로.
// DB 함수·Storage·오피스 서버 함수는 가짜로 대신한다(라이브 호출 0). 권한·범위는 회사 도구와 같다 — 메신저 조직 채널의 그 조직, 주인의 기기 세션, 손님 턴 거절.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-files-tool-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';

const { makeCrewServer } = await import('../src/chat.mjs');
const { crewToolSpecs, ensureRequired } = await import('../src/engine/native-query.mjs');
const { filesTool, filesDeps } = await import('../src/gateway/office-files.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const ME = 'owner-uid', ORG = '11111111-1111-4111-8111-111111111111', CUST = '22222222-2222-4222-8222-222222222222';
const real = { ...filesDeps };
after(() => Object.assign(filesDeps, real));
const WSROOT = await mkdtemp(join(tmpdir(), 'argo-files-ws-'));
await mkdir(join(WSROOT, 'vault', 'files'), { recursive: true });
await writeFile(join(WSROOT, 'vault', 'files', '김민수_명함.png'), Buffer.from('PNGDATA'));
const OUTSIDE = await mkdtemp(join(tmpdir(), 'argo-files-out-'));
await writeFile(join(OUTSIDE, 'secret.pdf'), Buffer.from('%PDF'));
await symlink(join(OUTSIDE, 'secret.pdf'), join(WSROOT, 'vault', 'files', 'link.pdf'));

const msgrCtx = (extra = {}) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: ORG, channelId: 'ch-1', crewId: 'crew-1', uid: ME, wsId: 'w', origin: ME, ...extra });
const FILES = [
  { id: 'f1', kind: 'file', title: '한빛 견적서.pdf', category: 'quote', customer_id: CUST, size: 120000, ocr_status: 'done', summary: '견적 합계 5,940,000원', source: 'generated' },
  { id: 'f2', kind: 'file', title: '넥스트필드_통장사본.png', category: 'bankbook', customer_id: null, size: 9000, ocr_status: 'done', summary: '계좌번호 123456-78-901234', source: 'upload' },
];
function table(rows) {
  const q = { f: [], select() { return q; }, eq(k, v) { q.f.push((r) => r[k] === v); return q; }, in(k, vs) { q.f.push((r) => vs.includes(r[k])); return q; },
    then(ok, no) { return Promise.resolve({ data: rows.filter((r) => q.f.every((x) => x(r))), error: null }).then(ok, no); } };
  return q;
}
function fake({ members = { 'dm-1': [ME] }, rpcError = null, createError = null, api = {} } = {}) {
  const calls = [];
  const client = {
    from: (t) => t === 'msgr_channel_members' ? table(Object.entries(members).flatMap(([ch, ids]) => ids.map((id) => ({ channel_id: ch, member_kind: 'user', member_id: id }))))
      : table([{ org_id: ORG, user_id: ME, role: 'owner', removed_at: null }]),
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (rpcError) return { data: null, error: { message: rpcError } };
      if (name === 'office_file_list') return { data: { files: FILES, more: false, folders: [] }, error: null };
      if (name === 'office_file_get') return { data: { ...FILES.find((f) => f.id === args.p_id), full_text: args.p_id === 'f2' ? '예금주 넥스트필드 계좌번호 123456-78-901234' : '견 적 서 ... 합계 5,940,000원' }, error: null };
      if (name === 'office_file_write' && args.p_action === 'file.create' && createError) return { data: null, error: { message: createError } };
      if (name === 'office_file_write' && args.p_action === 'file.reserve') return { data: { key: `o-${args.p_org}/files/${args.p_data.id}.png` }, error: null };
      if (name === 'office_file_write') return { data: { id: args.p_data.id }, error: null };
      return { data: null, error: { message: 'unknown' } };
    },
    storage: { from: () => { throw new Error('Supabase Storage를 쓰면 안 된다(R2로 옮김)'); } },
  };
  Object.assign(filesDeps, {
    session: async () => ({ client, uid: ME }), jwt: async () => 'jwt-1', newId: () => '33333333-3333-4333-8333-333333333333', wsRoot: () => WSROOT, workRoots: async () => [],
    origin: () => 'https://office.example.com',
    fetch: async (url, init = {}) => { calls.push({ name: 'fetch', url: String(url), init }); const h = Object.entries(api).find(([re]) => new RegExp(re).test(String(url))); return h ? h[1](String(url), init) : new Response('{"error":"op"}', { status: 404 }); },
  });
  return calls;
}
const run = (args, opts = {}) => filesTool(args, { ctx: msgrCtx(), crew: 'pepper', lang: 'ko', ownerId: ME, ...opts });

test('F1. 메신저 조직 채널이 아니거나·위임 턴·주인 아닌 로그인·손님이 있는 방이면 거절(쓰기 호출 없음)', async () => {
  const calls = fake({ members: { 'pv-1': [ME, 'g1'] } });
  assert.match(await run({ action: 'files' }, { ctx: null }), /조직 채널/);
  assert.match(await run({ action: 'files' }, { ctx: { kind: 'msgr-rules' } }), /위임 턴/);
  assert.match(await run({ action: 'files' }, { ownerId: 'someone' }), /주인의 계정이 아니라/);
  assert.match(await run({ action: 'files' }, { ctx: msgrCtx({ channelKind: 'private', channelId: 'pv-1' }) }), /손님/);
  assert.ok(!calls.some((c) => c.name.startsWith('office_')));
});

test('F2(O2). files는 그 조직 문서함을 검색(제목·파일명·본문·태그 — 서버 office_file_list), 거래처로 거를 수 있다', async () => {
  const calls = fake();
  const out = await run({ action: 'files', q: '견적', customer_id: CUST });
  const c = calls.find((x) => x.name === 'office_file_list');
  assert.deepEqual(c.args, { p_org: ORG, p_q: '견적', p_trash: false, p_customer: CUST });
  assert.match(out, /"한빛 견적서\.pdf" · quote · .*id=f1/);
  assert.match(out, /견적 합계/);
  assert.doesNotMatch(out, /123456-78-901234/, '여럿이 보는 채널에서는 통장사본 요약을 싣지 않는다');
});

test('F3(O2). file_read는 한 건 전문(office_file_get), 통장사본 글자는 주인과의 1:1에서만', async () => {
  fake();
  assert.match(await run({ action: 'file_read', id: 'f1' }), /견 적 서 .* 합계 5,940,000원/);
  const pub = await run({ action: 'file_read', id: 'f2' });
  assert.doesNotMatch(pub, /123456/); assert.match(pub, /1:1/);
  assert.match(await run({ action: 'file_read', id: 'f2' }, { ctx: msgrCtx({ channelKind: 'dm', channelId: 'dm-1' }) }), /123456-78-901234/);
  assert.match(await run({ action: 'file_read' }), /id/);
});

const STORE = {
  'api/storage/upload-url': (u, init) => new Response(JSON.stringify({ key: JSON.parse(init.body).key, url: 'https://r2.example.com/argo-office/k?X-Amz-Signature=x', headers: { 'content-type': 'image/png', 'if-none-match': '*' } })),
  'r2\\.example\\.com': () => new Response(null, { status: 200 }),
  'api/storage/commit': (u, init) => new Response(JSON.stringify({ key: JSON.parse(init.body).key, bytes: 7 })),
};
test('F4(C9). attach: 작업 공간 안 파일만 — 자리(키는 DB가 정함) → 오피스 서명 주소 → R2에 PUT → 확인 → 등록(거래처·분류·agent)', async () => {
  let calls = fake({ api: STORE });
  assert.match(await run({ action: 'attach', path: join(OUTSIDE, 'secret.pdf'), customer_id: CUST }), /작업 공간/);
  assert.match(await run({ action: 'attach', path: 'vault/files/link.pdf', customer_id: CUST }), /작업 공간/, '심링크로 밖을 가리켜도 거절');
  assert.ok(!calls.some((c) => c.name.startsWith('office_') || c.name === 'fetch'));
  const out = await run({ action: 'attach', path: 'vault/files/김민수_명함.png', customer_id: CUST, category: 'card' });
  const seq = calls.filter((c) => c.name === 'office_file_write' || c.name === 'fetch').map((c) => (c.name === 'fetch' ? (c.init.method === 'PUT' ? 'PUT' : c.url.split('/').pop()) : c.args.p_action));
  assert.deepEqual(seq, ['file.reserve', 'upload-url', 'PUT', 'commit', 'file.create']);
  const reserve = calls.find((c) => c.args?.p_action === 'file.reserve').args;
  assert.equal(reserve.p_org, ORG); assert.deepEqual(reserve.p_data, { id: '33333333-3333-4333-8333-333333333333', filename: '김민수_명함.png', size: 7, mime: 'image/png' }, '키는 보내지 않는다(DB가 정함)');
  const key = `o-${ORG}/files/33333333-3333-4333-8333-333333333333.png`;
  const fetches = calls.filter((c) => c.name === 'fetch');
  assert.deepEqual(JSON.parse(fetches[0].init.body), { key }); assert.equal(fetches[0].init.headers.authorization, 'Bearer jwt-1');
  assert.equal(fetches[1].url, 'https://r2.example.com/argo-office/k?X-Amz-Signature=x'); assert.deepEqual(fetches[1].init.headers, { 'content-type': 'image/png', 'if-none-match': '*' });
  assert.equal(fetches[1].init.headers.authorization, undefined, 'R2에는 로그인 토큰을 보내지 않는다'); assert.equal(fetches[1].init.body.length, 7);
  const create = calls.find((c) => c.args?.p_action === 'file.create').args.p_data;
  assert.deepEqual([create.customer_id, create.category, create.source, create.mime, create.storage_path], [CUST, 'card', 'agent', 'image/png', key]);
  assert.match(out, /붙였다/);
  calls = fake({ createError: 'file_quota', api: STORE });
  assert.match(await run({ action: 'attach', path: 'vault/files/김민수_명함.png' }), /저장 공간/);
  calls = fake({ api: { ...STORE, 'api/storage/upload-url': () => new Response(JSON.stringify({ key: 'k', url: 'http://evil.example/x', headers: {} })) } });
  assert.match(await run({ action: 'attach', path: 'vault/files/김민수_명함.png' }), /https가 아니라/);
  assert.ok(!calls.some((c) => c.name === 'fetch' && c.init.method === 'PUT'), 'https가 아닌 곳으로는 파일을 보내지 않는다');
  calls = fake({ api: { ...STORE, 'api/storage/commit': () => new Response('{"error":"file_size_mismatch"}', { status: 409 }) } });
  assert.match(await run({ action: 'attach', path: 'vault/files/김민수_명함.png' }), /오피스 호출 실패: file_size_mismatch/);
  assert.ok(!calls.some((c) => c.args?.p_action === 'file.create'), '확인이 실패하면 등록하지 않는다');
});

test('F5(V14). 드라이브: 목록·가져오기·새 폴더·보내기는 오피스 서버 함수(주인 로그인 JWT)로, 오피스 주소는 https·루프백만', async () => {
  let calls = fake({ api: {
    'api/drive/list': () => new Response(JSON.stringify({ files: [{ id: 'g1', name: '제안서', mimeType: 'application/vnd.google-apps.document', isFolder: false, link: 'https://docs.google.com/x' }] })),
    'api/drive/import': (u, init) => new Response(JSON.stringify({ id: 'nf', title: '제안서.pdf', ...JSON.parse(init.body) })),
    'api/drive/mkdir': () => new Response(JSON.stringify({ id: 'd1', name: '2026 계약', link: 'https://drive.google.com/d1' })),
    'api/drive/export': () => new Response(JSON.stringify({ error: 'need_write' }), { status: 403 }),
  } });
  const list = await run({ action: 'drive', q: '제안서' });
  const l = calls.find((c) => c.name === 'fetch' && /drive\/list/.test(c.url));
  assert.equal(l.url, 'https://office.example.com/api/drive/list?q=%EC%A0%9C%EC%95%88%EC%84%9C');
  assert.equal(l.init.headers.authorization, 'Bearer jwt-1');
  assert.match(list, /"제안서" .*id=g1/);
  assert.match(await run({ action: 'drive_import', drive_id: 'g1', customer_id: CUST }), /가져왔다\(id=g1\)[^\n]*\n--- 바깥 글 시작[^\n]*\n"제안서\.pdf"\n--- 바깥 글 끝 /);
  assert.deepEqual(JSON.parse(calls.find((c) => /drive\/import/.test(c.url ?? '')).init.body), { org: ORG, id: 'g1', customerId: CUST });
  assert.match(await run({ action: 'drive_mkdir', name: '2026 계약' }), /폴더를 만들었다/);
  assert.match(await run({ action: 'drive_export', id: 'f1' }), /보내기 권한/);
  calls = fake();
  filesDeps.origin = () => 'http://office.example.com';
  assert.match(await run({ action: 'drive' }), /오피스 주소/);
  assert.ok(!calls.some((c) => c.name === 'fetch'));
});

const WS = 'files-wire';
await createCompany(WS, '파일도구사', 'owner', ME);
test('F6. office_files 도구는 메신저 조직 턴에만 보이고(네이티브 sink 포함), 손님 턴은 세션을 부르지 않으며, 벤더 스키마에 required가 있다', async () => {
  const none = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], null, 'ko', [], '', none);
  assert.ok(!none.some((d) => d.name === 'office_files'));
  let called = 0; Object.assign(filesDeps, { session: async () => { called++; return null; } });
  const guest = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx({ origin: 'guest-uid' }), 'ko', [], '', guest);
  assert.match((await guest.find((d) => d.name === 'office_files').handler({ action: 'files' })).content[0].text, /주인이 아닌 사람/);
  assert.equal(called, 0);
  fake();
  const owner = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx(), 'en', [], '', owner);
  const def = owner.find((d) => d.name === 'office_files');
  assert.match(def.description, /Argo Office files/);
  assert.deepEqual(ensureRequired(crewToolSpecs([def])[0].input_schema).required, ['action']);
  assert.match((await def.handler({ action: 'files' })).content[0].text, /한빛 견적서/);
});
