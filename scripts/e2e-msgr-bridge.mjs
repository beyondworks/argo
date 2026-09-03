// 팀 메신저 브리지 격리 E2E — **로컬 Supabase 스택**(supabase start, 실자격 0)에 마이그레이션이 적용된 상태에서
// 실제 RLS·PostgREST·Realtime 왕복 + 가짜 Anthropic SSE 러너로 크루 턴을 끝까지 돌린다.
// 검증: ① B가 @크루 멘션 → A의 브리지가 처리 → 답글 정확히 1건(Realtime 깨우기로 폴 주기보다 빨리)
//       ② 브리지 재시작 + drain 동시 2회(리더 교체 창 재현) → 중복 답글 0  ③ 허용 범위 'owner' → 거절 안내 1건·답글 0
//       ④ 결재 카드 미러: B의 확정 시도는 RLS로 0행, A 확정 → 로컬 결재 approved(resolvedBy = A)
// 사용: E2E_SB_DIR=<supabase 프로젝트 디렉터리> node scripts/e2e-msgr-bridge.mjs
//       또는 SB_URL·SB_ANON_KEY·SB_SERVICE_KEY env 직접 지정. 값은 로그에 찍지 않는다.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const t0 = Date.now();
const log = (m) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const fails = [];
const check = (name, ok, detail = '') => { log(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fails.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeoutMs = 30_000, everyMs = 300 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(everyMs); }
}

// ── 스택 자격 ──
let SB_URL = process.env.SB_URL, ANON = process.env.SB_ANON_KEY, SERVICE = process.env.SB_SERVICE_KEY;
if (!SB_URL && process.env.E2E_SB_DIR) {
  const r = spawnSync('supabase', ['status', '-o', 'env'], { cwd: process.env.E2E_SB_DIR, encoding: 'utf8' });
  const env = Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
  SB_URL = env.API_URL; ANON = env.ANON_KEY; SERVICE = env.SERVICE_ROLE_KEY;
}
if (!SB_URL || !ANON || !SERVICE) { console.error('SB_URL/SB_ANON_KEY/SB_SERVICE_KEY 또는 E2E_SB_DIR 필요'); process.exit(2); }

// ── 격리: 임시 ARGO_ROOT·HOME, 가짜 Anthropic SSE(러너 자격·비용 0) ──
const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-msgr-'));
const HOME = join(ROOT, 'home'); await mkdir(HOME, { recursive: true, mode: 0o700 });
process.env.ARGO_ROOT = ROOT; process.env.HOME = HOME;
for (const k of Object.keys(process.env)) if (/^NEXT_PUBLIC_SUPABASE|SUPABASE_SERVICE_ROLE_KEY|ARGO_TENANT|ARGO_SYNC/i.test(k)) delete process.env[k]; // 세션 모드(hostedCredsOff) — 서비스 롤 유입 금지
const REPLY = 'E2E-REPLY 확인했습니다. 회의 자료를 정리하겠습니다.';
const sse = createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (!/\/v1\/messages/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', { message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: REPLY } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
    ev('message_stop', {});
    res.end();
  });
});
await new Promise((r) => sse.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${sse.address().port}`;

// ── 사용자 A(크루 소유자)·B(동료) ──
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const stamp = Date.now().toString(36);
const mkUser = async (tag) => {
  const email = `e2e-${tag}-${stamp}@example.test`; const password = `pw-${stamp}-${tag}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  const c = createClient(SB_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const s = await c.auth.signInWithPassword({ email, password });
  if (s.error) throw new Error(`signIn ${tag}: ${s.error.message}`);
  return { id: data.user.id, email, session: s.data.session, client: c };
};
const A = await mkUser('owner'); const B = await mkUser('member');
log(`사용자 A·B 생성 (${A.id.slice(0, 8)}·${B.id.slice(0, 8)})`);
const q = (c, fn) => fn(c.client).then(({ data, error }) => { if (error) throw new Error(error.message); return data; });

let ws = `lean-e2e-${stamp}`; let stopBridge = null; let stopWorker = null;
async function cleanup(code) {
  try { stopBridge?.(); stopWorker?.(); } catch { /* 종료됨 */ }
  sse.close();
  await admin.auth.admin.deleteUser(A.id).catch(() => {}); await admin.auth.admin.deleteUser(B.id).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
try {
  // ── 클라우드 시드(A) ──
  const org = await q(A, (c) => c.from('msgr_orgs').insert({ name: '린', slug: `lean-${stamp}`, owner_user_id: A.id }).select('id').single());
  const inv = await q(A, (c) => c.from('msgr_invites').insert({ org_id: org.id, role: 'member', created_by: A.id }).select('code').single());
  const accepted = await q(B, (c) => c.rpc('msgr_accept_invite', { code: inv.code }));
  check('초대 수락(B) = org', accepted === org.id);
  await admin.from('msgr_org_entitlements').update({ plan: 'team', seats: 10 }).eq('org_id', org.id); // 서비스 롤 = 엣지 펑션 자리
  const ch = await q(A, (c) => c.from('msgr_channels').insert({ org_id: org.id, kind: 'public', name: 'general', created_by: A.id }).select('id').single());
  const crew = await q(A, (c) => c.from('msgr_crews').insert({ org_id: org.id, owner_user_id: A.id, ws_id: ws, slug: 'seoyun', display_name: '서윤', allow: 'all' }).select('id').single());
  const denied = await B.client.from('msgr_crews').insert({ org_id: org.id, owner_user_id: A.id, ws_id: ws, slug: 'x', display_name: 'x' });
  check('B가 A 명의 크루 등록 → RLS 거부', !!denied.error);

  // ── 로컬 시드(A의 아르고) — 회사·크루 카드·가짜 러너 자격·기기 세션 ──
  const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
  const { saveRunnerCred } = await import('../src/runners/creds.mjs');
  const { saveDeviceSession } = await import('../src/devicesession.mjs');
  await createCompany(ws, '린', '사장', A.id, 'ko');
  await writeFile(join(paths(ws).agents, 'seoyun.md'), '---\nname: 서윤\nrole: 마케터\nrunner: claude\n---\n마케팅 담당.\n');
  await saveRunnerCred(ws, 'claude', 'apikey', 'e2e-fake-not-a-real-key'); // 가짜 서버는 인증을 보지 않는다 — 실키 모양(sk-ant-) 금지(커밋 훅)
  await saveDeviceSession({ url: SB_URL, anonKey: ANON, session: A.session });
  await updateCompany(ws, { msgr: { enabled: true } });
  const M = await import('../src/gateway/msgr.mjs');
  const { startQueueWorker } = await import('../src/gateway/queue.mjs');
  const { addApproval, loadApprovals } = await import('../src/approvals.mjs');
  const sess = await M.sessionClient();
  check('기기 세션 클라이언트 = A', sess?.uid === A.id);

  const post = (user, body, extra = {}) => q(user, (c) => c.from('msgr_messages').insert({ channel_id: ch.id, author_kind: 'user', author_user_id: user.id, body, mentions: [{ kind: 'crew', id: crew.id }], ...extra }).select('id, created_at').single());
  const repliesTo = async (id) => (await admin.from('msgr_messages').select('id, kind, body, client_msg_id, created_at').eq('reply_to', id).order('id')).data ?? [];
  const start = (pollMs) => { stopWorker = startQueueWorker(ws, M.MSGR_KEY, M.makeMsgrHandler(ws)); stopBridge = M.startMsgrBridge(ws, { pollMs }); };

  // ① 멘션 → 답글 1건, Realtime 깨우기(폴 20s보다 훨씬 빨리)
  start(20_000);
  await sleep(1500); // 첫 drain(커서 초기화·구독)
  const m1 = await post(B, '@서윤 이번 주 회의 자료 정리해줘');
  const r1 = await until(async () => { const r = await repliesTo(m1.id); return r.find((x) => x.kind === 'text') ? r : null; }, { timeoutMs: 60_000 });
  const lat = r1 ? (Date.parse(r1[0].created_at) - Date.parse(m1.created_at)) / 1000 : null;
  check('멘션 → 크루 답글 도착', !!r1, r1 ? `${lat.toFixed(1)}s, "${r1[0].body.slice(0, 40)}"` : '60s 타임아웃');
  check('답글 본문 = 가짜 러너 응답', !!r1 && r1[0].body.includes('E2E-REPLY'));
  check('client_msg_id = reply:<crew>:<msg>', !!r1 && r1[0].client_msg_id === `reply:${crew.id}:${m1.id}`);
  check('Realtime 깨우기(폴 20s 미만에 처리)', lat != null && lat < 15, `${lat?.toFixed(1)}s`);
  const cur = (await admin.from('msgr_crews').select('cursor_msg_id, last_seen_at').eq('id', crew.id).single()).data;
  check('서버 커서 전진 ≥ 메시지 id', cur.cursor_msg_id >= m1.id, `${cur.cursor_msg_id}/${m1.id}`);
  check('하트비트(last_seen_at) 기록', !!cur.last_seen_at && Date.now() - Date.parse(cur.last_seen_at) < 60_000);

  // ② 재시작 + 동시 drain 2회(리더 교체 창) → 중복 0
  stopBridge(); stopWorker();
  const m2 = await post(B, '@서윤 두 번째 지시');
  await Promise.all([M.drain(ws, { db: sess.db, uid: sess.uid }), M.drain(ws, { db: sess.db, uid: sess.uid })]);
  start(2_000);
  const r2 = await until(async () => { const r = await repliesTo(m2.id); return r.find((x) => x.kind === 'text') ? r : null; }, { timeoutMs: 60_000 });
  await sleep(4000); // 늦은 중복이 있다면 도착할 시간
  const r2b = await repliesTo(m2.id); const r1b = await repliesTo(m1.id);
  check('재시작·동시 drain 후 답글 정확히 1건', r2b.filter((x) => x.kind === 'text').length === 1, `${r2b.length}건`);
  check('첫 메시지 답글도 여전히 1건(재처리 없음)', r1b.filter((x) => x.kind === 'text').length === 1, `${r1b.length}건`);
  const q1 = (await import('node:fs/promises')).readdir(join(paths(ws).root, `.gw-queue-${M.MSGR_KEY}`)).catch(() => []);
  check('큐 비움(잡 파일 잔존 0)', (await q1).filter((n) => n.endsWith('.json')).length === 0);

  // ③ 허용 범위 'owner' → B의 멘션은 거절 안내, 답글 0
  await q(A, (c) => c.from('msgr_crews').update({ allow: 'owner' }).eq('id', crew.id));
  const m3 = await post(B, '@서윤 이건 막혀야 함');
  const r3 = await until(async () => { const r = await repliesTo(m3.id); return r.length ? r : null; }, { timeoutMs: 30_000 });
  check('거절 안내(system, deny:)', !!r3 && r3[0].kind === 'system' && r3[0].client_msg_id === `deny:${crew.id}:${m3.id}`, r3?.[0]?.body?.slice(0, 40));
  await sleep(3000);
  check('거절 시 크루 답글 0', (await repliesTo(m3.id)).filter((x) => x.kind === 'text').length === 0);
  const m3b = await post(A, '@서윤 소유자는 된다');
  const r3b = await until(async () => { const r = await repliesTo(m3b.id); return r.find((x) => x.kind === 'text') ? r : null; }, { timeoutMs: 60_000 });
  check('소유자 멘션은 실행', !!r3b);

  // ④ 결재 카드 미러 — RLS 왕복
  const it = await addApproval(ws, { slug: 'seoyun', action: '메일 발송', reason: 'E2E', kind: 'tool' });
  M._activeCtxForTest.set(`${ws}:seoyun`, { chatType: 'group', kind: 'msgr', orgId: org.id, channelId: ch.id, crewId: crew.id, threadRoot: m1.id, uid: A.id });
  const pushed = await M.msgrPush({ type: 'approval', wsId: ws, item: it });
  M._activeCtxForTest.clear();
  const meta = (await loadApprovals(ws)).find((a) => a.id === it.id)?.msgr;
  check('결재 카드 미러 행 + 로컬 메타', pushed && !!meta?.rowId && !!meta?.messageId, JSON.stringify(meta ?? null).slice(0, 80));
  const card = (await admin.from('msgr_messages').select('kind, body').eq('id', meta.messageId).single()).data;
  check('채널에 approval_card 메시지', card?.kind === 'approval_card' && /결재 요청: 메일 발송/.test(card?.body ?? ''));
  const bTry = await B.client.from('msgr_crew_approvals').update({ status: 'approved', decided_by: B.id, decided_at: new Date().toISOString() }).eq('id', meta.rowId).select('id');
  check('B(비소유자)의 확정 → RLS 0행', !bTry.error && (bTry.data ?? []).length === 0);
  const aOk = await A.client.from('msgr_crew_approvals').update({ status: 'approved', decided_by: A.id, decided_at: new Date().toISOString() }).eq('id', meta.rowId).select('id');
  check('A(소유자)의 확정 → 1행', !aOk.error && (aOk.data ?? []).length === 1, aOk.error?.message);
  const local = await until(async () => (await loadApprovals(ws)).find((a) => a.id === it.id && a.status === 'approved'), { timeoutMs: 20_000 });
  check('로컬 결재 approved(브리지가 큐 우회 반영)', !!local && local.resolvedBy?.uid === A.id && local.resolvedBy?.via === 'msgr', JSON.stringify(local?.resolvedBy ?? null));
  const again = await A.client.from('msgr_crew_approvals').update({ status: 'rejected', decided_by: A.id }).eq('id', meta.rowId).select('id');
  check('확정은 1회(pending 아닌 행 update 0)', (again.data ?? []).length === 0);

  // 스레드 actor·via 기록(로컬 정본)
  const { loadThread } = await import('../src/thread.mjs');
  const th = await loadThread(ws, 'seoyun');
  const u = th.messages.find((m) => m.who === 'user' && m.via === 'msgr');
  check('스레드에 via:msgr + actor(uid=B)', !!u && u.actor?.uid === B.id, JSON.stringify(u?.actor ?? null));
  check('스레드에 crew_memory=true → 일지 파일(org 태그)', (await (await import('node:fs/promises')).readdir(paths(ws).journal)).some((f) => f.includes(`.org-${org.id}`)));
} catch (e) {
  check('예외 없이 완주', false, e.stack?.split('\n').slice(0, 3).join(' | '));
}
log(fails.length ? `FAIL ${fails.length}건: ${fails.join(' / ')}` : 'ALL OK');
await cleanup(fails.length ? 1 : 0);
