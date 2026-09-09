// 같은 채널의 1~6 릴레이: 실제 로컬 Supabase RLS → drain → 디스크 큐 → handler → 답글.
// LLM만 문맥 의존 가짜 함수다. SDK send_to_crew / CLI 지시 블록은 실제 구현을 실행한다.
// node scripts/e2e-msgr-relay.mjs [--hold]
// --hold: 성공 시에만 격리 계정/데이터를 UI 검수용으로 유지. 자격은 임시 폴더 0600 파일에만 저장.
// node scripts/e2e-msgr-relay.mjs --cleanup <출력된 임시 폴더>
// E2E_SB_DIR 없으면 실행 중인 msgr-local-stack의 status를 임시 config로 읽는다. 스택 시작/종료 없음.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const argv = process.argv.slice(2);
const hold = argv.length === 1 && argv[0] === '--hold';
const cleanupPath = argv.length === 2 && argv[0] === '--cleanup' ? argv[1] : null;
assert.ok(!argv.length || hold || cleanupPath, '사용법: [--hold] 또는 --cleanup <임시 폴더>');
const started = Date.now();
const log = (s) => console.log(`[relay-e2e ${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stackCredentials() {
  let dir = process.env.E2E_SB_DIR;
  let scratch;
  try {
    if (!dir) {
      scratch = await mkdtemp(join(tmpdir(), 'argo-local-stack-status-'));
      await mkdir(join(scratch, 'supabase'));
      await writeFile(join(scratch, 'supabase', 'config.toml'), 'project_id = "msgr-local-stack"\n');
      dir = scratch;
    }
    const result = spawnSync('supabase', ['status', '-o', 'env'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, '로컬 Supabase status 실패 — 실행 중 스택 확인 필요');
    const vars = Object.fromEntries(result.stdout.split('\n').filter((s) => s.includes('=')).map((s) => {
      const i = s.indexOf('='); return [s.slice(0, i).trim(), s.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }));
    const url = new URL(vars.API_URL);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '로컬 Supabase만 허용');
    assert.equal(url.protocol, 'http:', '로컬 http 스택만 허용');
    assert.ok(vars.ANON_KEY && vars.SERVICE_ROLE_KEY, '로컬 스택 자격 누락');
    return { url: url.origin, anon: vars.ANON_KEY, service: vars.SERVICE_ROLE_KEY };
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}

const stack = await stackCredentials();
const network = { telegram: 0, external: 0 };
const realFetch = globalThis.fetch;
// 의도 밖 네트워크는 I/O 이전 차단한다. 주소/헤더/본문/자격은 출력하지 않는다.
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== stack.url) {
    if (url.hostname === 'api.telegram.org') network.telegram++;
    else network.external++;
    throw new Error('E2E에서 외부 네트워크 호출을 차단했습니다');
  }
  return realFetch(input, init);
};
const client = (key) => createClient(stack.url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const admin = client(stack.service);
const ok = async (query, label) => {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.code ?? 'DB error'}`);
  return data;
};

async function removeFixtures(meta) {
  assert.equal(meta.kind, 'argo-msgr-relay-e2e');
  assert.equal(meta.url, stack.url);
  for (const id of meta.orgIds) await ok(admin.from('msgr_orgs').delete().eq('id', id), '격리 조직 정리');
  for (const id of meta.userIds) await ok(admin.auth.admin.deleteUser(id), '격리 계정 정리');
}

if (cleanupPath) {
  const root = await realpath(cleanupPath);
  assert.ok(basename(root).startsWith('argo-e2e-relay-'), '이 스크립트의 임시 폴더만 정리 가능');
  await removeFixtures(JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8')));
  await rm(root, { recursive: true, force: true });
  log('보관한 로컬 검수 계정·조직·임시 폴더 정리 PASS');
  process.exit(0);
}

const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-relay-'));
const HOME = join(ROOT, 'home');
await mkdir(HOME, { mode: 0o700 });
process.env.ARGO_ROOT = ROOT;
process.env.HOME = HOME;
process.env.ARGO_ENC_VAULT = '0';
for (const key of Object.keys(process.env)) if (/^NEXT_PUBLIC_SUPABASE|SUPABASE_SERVICE_ROLE_KEY|ARGO_TENANT|ARGO_SYNC/.test(key)) delete process.env[key];
const meta = { kind: 'argo-msgr-relay-e2e', url: stack.url, orgIds: [], userIds: [] };
let stopWorker;
let passed = false;
const active = new Set();

try {
  const stamp = randomUUID().replaceAll('-', '').slice(0, 16);
  async function user(tag) {
    const email = `relay-${tag}-${stamp}@example.test`;
    const password = randomUUID();
    const data = await ok(admin.auth.admin.createUser({ email, password, email_confirm: true }), `계정 ${tag} 생성`);
    meta.userIds.push(data.user.id);
    const c = client(stack.anon);
    const signed = await ok(c.auth.signInWithPassword({ email, password }), `계정 ${tag} 로그인`);
    return { id: data.user.id, c, session: signed.session, email, password };
  }
  const owner = await user('owner');
  const member = await user('member');
  const org = await ok(owner.c.from('msgr_orgs').insert({ name: '메신저 릴레이 검수', slug: `relay-${stamp}`, owner_user_id: owner.id }).select('id').single(), '조직 생성');
  meta.orgIds.push(org.id);
  await ok(admin.from('msgr_org_entitlements').update({ plan: 'team', seats: 10 }).eq('org_id', org.id), '로컬 팀 좌석');
  const invite = await ok(owner.c.from('msgr_invites').insert({ org_id: org.id, created_by: owner.id, role: 'member' }).select('code').single(), '초대 생성');
  assert.equal(await ok(member.c.rpc('msgr_accept_invite', { code: invite.code }), '멤버 가입'), org.id);
  const ws = `relay-${stamp}`;
  const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
  const { saveDeviceSession } = await import('../src/devicesession.mjs');
  const { makeCrewServer } = await import('../src/chat.mjs');
  const { parseDirectives, runDirectives } = await import('../src/cli-directives.mjs');
  const { updateConnection } = await import('../src/connections.mjs');
  const { _pushEventForTest } = await import('../src/gateway.mjs');
  const M = await import('../src/gateway/msgr.mjs');
  const Q = await import('../src/gateway/queue.mjs');
  await createCompany(ws, '메신저 릴레이 검수', '검수 소유자', owner.id, 'ko');
  await updateCompany(ws, { msgr: { enabled: true } });
  await saveDeviceSession({ url: stack.url, anonKey: stack.anon, session: owner.session });
  const peers = [];
  for (const [slug, name] of [['alpha', '알파'], ['beta', '베타']]) {
    await writeFile(join(paths(ws).agents, `${slug}.md`), `---\nname: ${name}\nslug: ${slug}\nrole: 릴레이 검수\nrunner: claude\n---\n`);
    const row = await ok(owner.c.from('msgr_crews').insert({ org_id: org.id, owner_user_id: owner.id, ws_id: ws, slug, display_name: name, allow: 'all' }).select('id, slug, display_name').single(), '크루 생성');
    peers.push(row);
  }
  const forged = await member.c.from('msgr_crews').insert({ org_id: org.id, owner_user_id: owner.id, ws_id: ws, slug: 'forged', display_name: '거부 대상' });
  assert.ok(forged.error, '멤버가 소유자 명의 크루 생성하면 RLS 거부');
  log('실제 RLS: 멤버 초대 PASS / 소유자 명의 위조 등록 거부 PASS');
  // 회귀 시 텔레그램 분기가 실제로 시도할 설정. 가짜 값이고 네트워크 방어선이 I/O 전에 차단한다.
  await updateConnection(ws, 'telegram', { enabled: true, token: 'e2e-relay-not-a-real-credential', chatId: 'e2e-chat' });
  const sess = await M.sessionClient();
  assert.equal(sess.uid, owner.id);
  const channels = [];

  for (const mode of ['SDK', 'CLI']) {
    const channel = await ok(owner.c.from('msgr_channels').insert({ org_id: org.id, kind: 'public', name: `relay-${mode.toLowerCase()}`, created_by: owner.id }).select('id').single(), '채널 생성');
    channels.push({ ...channel, mode });
    const calls = [];
    const rawHandler = M.makeMsgrHandler(ws, { runChat: async (_ws, slug, text, _session, opts) => {
      // 상태 카운터가 아니라 브리지가 전달한 실제 채널 문맥에서 다음 수를 구한다.
      const seen = [...text.matchAll(/^(?:알파|베타):\s*([1-6])(?=\s|$)/gm)].map((m) => Number(m[1]));
      const n = Math.max(0, ...seen) + 1;
      assert.ok(n <= 6, '완료한 릴레이가 다시 실행됨');
      assert.equal(slug, n % 2 ? 'alpha' : 'beta', '발화 순서 불일치');
      assert.equal(opts.mirrorCtx.channelId, channel.id);
      calls.push({ slug, n, sawPrior: n === 1 || seen.includes(n - 1) });
      if (n < 6) {
        const to = slug === 'alpha' ? 'beta' : 'alpha';
        const message = `현재 ${n}까지 셌습니다. 다음 숫자를 이어 주세요.`;
        if (mode === 'SDK') {
          const sink = [];
          makeCrewServer(ws, slug, peers.find((p) => p.slug === slug).display_name,
            peers.filter((p) => p.slug !== slug).map((p) => ({ slug: p.slug, name: p.display_name })),
            0, [], opts.mirrorCtx, 'ko', [], '', sink, opts.journal);
          const tool = sink.find((t) => t.name === 'send_to_crew');
          assert.ok(tool, 'SDK 쪽지 도구 누락');
          const result = await tool.handler({ to, message });
          assert.match(JSON.stringify(result), /예약/);
        } else {
          const parsed = parseDirectives(`\`\`\`argo\n${JSON.stringify({ action: 'mail', to, message })}\n\`\`\``);
          assert.equal(parsed.directives.length, 1, 'CLI 지시 블록 파싱');
          const result = await runDirectives(ws, slug, parsed.directives, { mirrorCtx: opts.mirrorCtx });
          assert.deepEqual(result, []);
          assert.equal(opts.mirrorCtx.handoffs.at(-1).to.slug, to);
        }
      }
      return { reply: `${n}${n === 6 ? ' @알파 완료. 수고했어요.' : ''}\nMSGR: ${n === 6 ? 'done' : 'handoff'}`, sessionId: null };
    } });
    const trackedHandler = (job, info) => {
      const promise = rawHandler(job, info); active.add(promise);
      return promise.finally(() => active.delete(promise));
    };
    await M.drain(ws, { db: sess.db, uid: sess.uid });
    stopWorker = Q.startQueueWorker(ws, M.MSGR_KEY, trackedHandler);
    const root = await ok(member.c.from('msgr_messages').insert({ channel_id: channel.id, author_kind: 'user', author_user_id: member.id,
      body: '@알파 @베타 알파부터 시작해서 1부터 6까지 번갈아 한 숫자씩 세어 주세요.', mentions: peers.map((p) => ({ kind: 'crew', id: p.id })) }).select('id').single(), '사람 지시');
    const rows = () => ok(member.c.from('msgr_messages').select('id, body, crew_id, author_kind, kind, reply_to, thread_root, client_msg_id, mentions').eq('channel_id', channel.id).order('id'), '멤버 답글 열람');
    const deadline = Date.now() + 35_000;
    for (;;) {
      await M.drain(ws, { db: sess.db, uid: sess.uid });
      const current = (await rows()).filter((r) => r.author_kind === 'crew');
      if (current.some((r) => r.kind === 'system' || /^처리 실패/.test(r.body))) throw new Error(`${mode}: 채널 실패/거절 안내 발생`);
      if (current.length >= 6) break;
      assert.ok(Date.now() < deadline, `${mode}: 35초 안에 릴레이 6턴 미도착 (실행 ${calls.map((c) => c.n).join(',')})`);
      await sleep(250);
    }
    // 뒤늦게 재적재/도착할 중복을 두 번의 워커 틱과 동시 drain으로 관측한다.
    await Promise.all([M.drain(ws, { db: sess.db, uid: sess.uid }), M.drain(ws, { db: sess.db, uid: sess.uid })]);
    await sleep(2300);
    await M.drain(ws, { db: sess.db, uid: sess.uid });
    const answers = (await rows()).filter((r) => r.author_kind === 'crew');
    assert.deepEqual(answers.map((r) => Number(r.body.match(/^([1-6])(?:\s|$)/)?.[1])), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(calls.map((c) => c.n), [1, 2, 3, 4, 5, 6], '저장 멱등성 뒤에 숨은 중복 실행도 없음');
    assert.ok(calls.every((c) => c.sawPrior));
    assert.ok(answers.every((r) => r.thread_root === root.id));
    assert.equal(new Set(answers.map((r) => r.client_msg_id)).size, 6);
    assert.deepEqual(answers.map((r) => r.crew_id), [0, 1, 0, 1, 0, 1].map((i) => peers[i].id));
    assert.equal((await readdir(Q.queueDir(ws, M.MSGR_KEY))).filter((n) => /\.json(?:\.claimed)?$/.test(n)).length, 0);
    assert.deepEqual(await readdir(join(paths(ws).root, 'mail')).catch(() => []), [], '일반 쪽지 파일이 생기면 우회 경로');
    stopWorker(); stopWorker = null;
    log(`${mode}: 1→2→3→4→5→6 / 각 1회 실행·저장 / 같은 스레드 / 큐·우편 잔존 0 PASS`);
  }
  for (const type of ['crewmail', 'delegate']) {
    await _pushEventForTest({ type, wsId: ws, slug: 'beta', from: 'alpha', reply: '격리 미배달 검수',
      msgr: { channelId: channels[0].id }, ctx: { kind: 'msgr', channelId: channels[0].id } }, { pushMsgr: async () => false });
  }
  assert.equal(network.telegram, 0, 'Telegram 호출 시도 발생');
  assert.equal(network.external, 0, '다른 외부 네트워크 호출 시도 발생');
  log('Telegram 연결이 있어도 메신저 미배달 폴백 호출 0 / 외부 네트워크 시도 0 PASS');
  if (hold) {
    // 브라우저용 별도 로그인 세션: 기기 세션과 refresh token을 공유하지 않는다.
    const ui = await ok(owner.c.auth.signInWithPassword({ email: owner.email, password: owner.password }), 'UI 전용 세션');
    await writeFile(join(ROOT, 'ui-session.json'), JSON.stringify({ url: stack.url, anonKey: stack.anon, session: ui.session, email: owner.email, password: owner.password, orgId: org.id, wsId: ws, channels }), { mode: 0o600 });
    await writeFile(join(ROOT, 'fixture.json'), JSON.stringify(meta), { mode: 0o600 });
    log(`UI 검수용 데이터 보관: ${ROOT}`);
    log('자격 값은 출력하지 않음: ui-session.json(0600). 끝나면 --cleanup <위 폴더> 실행.');
  }
  passed = true;
} catch (error) {
  // 인증/HTTP 에러 객체에는 요청 정보가 섞일 수 있어 스택/원본 객체는 출력하지 않는다.
  log(`FAIL: ${String(error.message).slice(0, 500)}`);
  process.exitCode = 1;
} finally {
  stopWorker?.();
  await Promise.allSettled([...active]);
  if (!hold || !passed) {
    try { await removeFixtures(meta); log('격리 DB 계정·조직 정리 PASS'); }
    catch { log('FAIL: 로컬 격리 데이터 정리 실패'); process.exitCode = 1; }
    await rm(ROOT, { recursive: true, force: true });
  }
  globalThis.fetch = realFetch;
}
