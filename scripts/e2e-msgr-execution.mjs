// 실제 로컬 PostgreSQL/RLS + 두 Node 프로세스의 실행권 경합. 벤더/텔레그램 호출은 하지 않는다.
// 먼저 20260909120000_msgr_execution_claims.sql을 로컬 msgr-local-stack에 적용한 뒤 실행한다.
// node scripts/e2e-msgr-execution.mjs — 기존 스택만 사용하며 만든 조직·계정·임시 파일만 정리한다.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { executionDb, beginMessengerExecution, finishMessengerExecution } from '../src/gateway/msgr-execution.mjs';

const localClient = (url, key, access = null) => {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), '로컬 스택만 허용');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false },
    ...(access ? { global: { headers: { Authorization: `Bearer ${access}` } } } : {}) });
};
const replyFor = (job) => ({ channel_id: job.channelId, author_kind: 'crew', crew_id: job.crewId, kind: 'text',
  reply_to: job.msgId, thread_root: job.threadRoot ?? job.msgId, client_msg_id: `reply:${job.crewId}:${job.msgId}`,
  body: '1', mentions: [], meta: { hop: 0, origin: job.authorId } });
const ok = async (request, label) => {
  const { data, error } = await request;
  if (error) throw new Error(`${label}: ${error.code ?? 'DB error'}`);
  return data;
};

if (process.argv[2] === '--worker') {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  const client = localClient(config.url, config.anon, config.access);
  const db = executionDb(client), job = config.job;
  const meta = { path: join(config.root, `${process.pid}.json.claimed`) };
  await new Promise((r) => setTimeout(r, Math.max(0, config.startAt - Date.now())));
  const result = await beginMessengerExecution(config.ws, db, job, meta);
  let runs = 0;
  if (result.kind === 'run') { runs++; await finishMessengerExecution(config.ws, db, job, replyFor(job), meta); }
  console.log(JSON.stringify({ kind: result.kind, runs }));
} else {
  assert.equal(process.argv.length, 2, '추가 인자를 받지 않습니다');
  const root = await mkdtemp(join(tmpdir(), 'argo-e2e-execution-'));
  const orgIds = [], userIds = [];
  let admin;
  try {
    await mkdir(join(root, 'supabase'));
    await writeFile(join(root, 'supabase', 'config.toml'), 'project_id = "msgr-local-stack"\n');
    const status = spawnSync('supabase', ['status', '-o', 'env'], { cwd: root, encoding: 'utf8' });
    assert.equal(status.status, 0, '로컬 Supabase status 실패');
    const vars = Object.fromEntries(status.stdout.split('\n').filter((s) => s.includes('=')).map((s) => {
      const i = s.indexOf('='); return [s.slice(0, i).trim(), s.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }));
    const url = vars.API_URL, anon = vars.ANON_KEY;
    admin = localClient(url, vars.SERVICE_ROLE_KEY);
    const stamp = randomUUID().replaceAll('-', '').slice(0, 16), ws = `exec-${stamp}`;
    async function user(tag) {
      const email = `execution-${tag}-${stamp}@example.test`, password = randomUUID();
      const u = await ok(admin.auth.admin.createUser({ email, password, email_confirm: true }), '격리 계정 생성');
      userIds.push(u.user.id);
      const client = localClient(url, anon);
      const signed = await ok(client.auth.signInWithPassword({ email, password }), '격리 계정 로그인');
      return { id: u.user.id, client, access: signed.session.access_token };
    }
    const owner = await user('owner'), other = await user('other');
    const org = await ok(owner.client.from('msgr_orgs').insert({ name: '실행권 검수', slug: ws, owner_user_id: owner.id }).select('id').single(), '조직 생성');
    orgIds.push(org.id);
    const crew = await ok(owner.client.from('msgr_crews').insert({ org_id: org.id, owner_user_id: owner.id, ws_id: ws, slug: 'alpha', display_name: '알파', allow: 'all' }).select('id').single(), '크루 생성');
    const channel = await ok(owner.client.from('msgr_channels').insert({ org_id: org.id, kind: 'public', name: 'execution-test', created_by: owner.id }).select('id').single(), '채널 생성');
    async function newJob(mentions = [{ kind: 'crew', id: crew.id }]) {
      const src = await ok(owner.client.from('msgr_messages').insert({ channel_id: channel.id, author_kind: 'user', author_user_id: owner.id,
        body: '@알파 실행권 격리 검수', mentions }).select('id').single(), '지시 생성');
      return { crewId: crew.id, channelId: channel.id, msgId: src.id, authorId: owner.id };
    }
    const db = executionDb(owner.client);
    const raceJob = await newJob(), startAt = Date.now() + 750;
    const worker = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '';
      child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { errors += data; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(`격리 워커 실패 ${code}: ${errors.slice(-1500)}`)));
      child.stdin.end(JSON.stringify({ url, anon, access: owner.access, ws, root, startAt, job: raceJob }));
    });
    const outcomes = await Promise.all([worker(), worker()]);
    assert.equal(outcomes.reduce((n, r) => n + r.runs, 0), 1, '실제 두 프로세스의 실행 합계');
    const replies = await ok(owner.client.from('msgr_messages').select('id').eq('client_msg_id', `reply:${crew.id}:${raceJob.msgId}`), '답글 조회');
    assert.equal(replies.length, 1);
    console.log('PASS: PostgreSQL + 독립 Node 프로세스 2개 경합 / 실행 1회 / 답글 1개');

    const lostClaim = await newJob();
    const meta = { path: join(root, 'claim-loss.json.claimed') };
    await assert.rejects(beginMessengerExecution(ws, { ...db, claimExecution: async (...args) => { await db.claimExecution(...args); throw new Error('lost acquire'); } }, lostClaim, meta), /lost acquire/);
    assert.equal((await beginMessengerExecution(ws, db, JSON.parse(await readFile(meta.path, 'utf8')), meta)).kind, 'pending');
    await ok(admin.from('msgr_executions').update({ heartbeat_at: '2000-01-01T00:00:00Z' }).eq('crew_id', crew.id).eq('source_msg_id', lostClaim.msgId), '격리 심박 만료');
    assert.deepEqual(await beginMessengerExecution(ws, db, { ...lostClaim, msgrExecution: undefined }), { kind: 'pending', stale: true });
    console.log('PASS: acquire 응답 유실 + 오래된 심박 + 새 attempt에도 재실행 없음');

    const lostFinish = await newJob(), finishMeta = { path: join(root, 'finish-loss.json.claimed') };
    assert.equal((await beginMessengerExecution(ws, db, lostFinish, finishMeta)).kind, 'run');
    const expected = replyFor(lostFinish);
    let replyId;
    await assert.rejects(finishMessengerExecution(ws, { ...db, finishExecution: async (...args) => { replyId = (await db.finishExecution(...args)).id; throw new Error('lost finish'); } }, lostFinish, expected, finishMeta), /lost finish/);
    const afterRestart = JSON.parse(await readFile(finishMeta.path, 'utf8'));
    assert.deepEqual(await beginMessengerExecution(ws, db, afterRestart, finishMeta), { kind: 'completed', row: { id: replyId } });
    const saved = await ok(owner.client.from('msgr_messages').select('id').eq('client_msg_id', expected.client_msg_id), '멱등 완료 조회');
    assert.deepEqual(saved.map((r) => r.id), [replyId]);
    console.log('PASS: finish 응답 유실 / 로컬 체크포인트 복원 / 동일 답글 ID / 추가 실행 0');

    const retry = await newJob(), retryMeta = { path: join(root, 'publish-retry.json.claimed') };
    let runs = 0, attempts = 0;
    assert.equal((await beginMessengerExecution(ws, db, retry, retryMeta)).kind, 'run'); runs++;
    const unavailable = { ...db, finishExecution: async (...args) => { if (++attempts < 3) throw new Error('publish offline'); return db.finishExecution(...args); } };
    await assert.rejects(finishMessengerExecution(ws, unavailable, retry, replyFor(retry), retryMeta), /publish offline/);
    await assert.rejects(beginMessengerExecution(ws, unavailable, JSON.parse(await readFile(retryMeta.path, 'utf8')), retryMeta), /publish offline/);
    assert.equal((await beginMessengerExecution(ws, unavailable, JSON.parse(await readFile(retryMeta.path, 'utf8')), retryMeta)).kind, 'completed');
    assert.equal(runs, 1);
    console.log('PASS: 답글 게시 2회 실패 뒤 DB 저장 재시도 / LLM 재실행 0');

    const followup = await ok(owner.client.from('msgr_messages').insert({ channel_id: channel.id, author_kind: 'user', author_user_id: owner.id,
      body: '@알파 이 스레드에서 이어 주세요', mentions: [{ kind: 'crew', id: crew.id }], reply_to: retry.msgId, thread_root: retry.msgId }).select('id').single(), '사람 스레드 후속 지시');
    const followupJob = { crewId: crew.id, channelId: channel.id, msgId: followup.id, authorId: owner.id, threadRoot: retry.msgId };
    assert.equal((await beginMessengerExecution(ws, db, followupJob)).kind, 'run');
    const followupReply = await finishMessengerExecution(ws, db, followupJob, replyFor(followupJob));
    const threaded = await ok(owner.client.from('msgr_messages').select('thread_root,reply_to').eq('id', followupReply.id).single(), '스레드 보존 확인');
    assert.deepEqual(threaded, { thread_root: retry.msgId, reply_to: followup.id });
    console.log('PASS: 기존 스레드에 사람이 새 지시를 답글로 달아도 원래 스레드 보존');

    const atomic = await newJob();
    assert.equal((await beginMessengerExecution(ws, db, atomic)).kind, 'run');
    await assert.rejects(finishMessengerExecution(ws, db, atomic, { ...replyFor(atomic), body: 'x'.repeat(20_001) }), /constraint/);
    const unfinished = await ok(owner.client.from('msgr_executions').select('state,reply_id').eq('crew_id', crew.id).eq('source_msg_id', atomic.msgId).single(), '실패 트랜잭션 상태');
    assert.deepEqual(unfinished, { state: 'running', reply_id: null });
    const absent = await ok(owner.client.from('msgr_messages').select('id').eq('client_msg_id', replyFor(atomic).client_msg_id), '실패 답글 부재');
    assert.equal(absent.length, 0);
    assert.ok((await finishMessengerExecution(ws, db, atomic, replyFor(atomic))).id);
    assert.deepEqual(await ok(other.client.from('msgr_executions').select('crew_id'), '다른 소유자 실행권 열람'), []);
    console.log('PASS: 답글 INSERT 실패 트랜잭션은 completed 변경도 롤백 / 타 소유자 RLS 열람 0행');

    const denied = await newJob();
    await assert.rejects(beginMessengerExecution(ws, executionDb(other.client), denied), /forbidden/);
    await assert.rejects(beginMessengerExecution('wrong-workspace', db, await newJob()), /forbidden/);
    await assert.rejects(beginMessengerExecution(ws, db, { ...await newJob(), channelId: randomUUID() }), /forbidden/);
    await assert.rejects(beginMessengerExecution(ws, db, await newJob([])), /not_targeted/);
    const wrongAttempt = { ...retry, msgrExecution: { attempt: randomUUID() } };
    await assert.rejects(finishMessengerExecution(ws, db, wrongAttempt, replyFor(retry)), /not_owner/);
    const direct = await owner.client.from('msgr_executions').update({ attempt: randomUUID() }).eq('crew_id', crew.id);
    assert.ok(direct.error, '클라이언트 직접 실행권 수정 거절');
    const anonymous = await localClient(url, anon).rpc('msgr_execution_claim', { p_ws: ws, p_crew: crew.id, p_source: denied.msgId, p_channel: channel.id, p_attempt: randomUUID() });
    assert.ok(anonymous.error, '무인증 RPC 거절');
    console.log('PASS: 타 소유자·다른 회사/채널·멘션 없는 원문·다른 attempt·직접 변경·무인증 거절');
  } finally {
    if (admin) {
      for (const id of orgIds) await ok(admin.from('msgr_orgs').delete().eq('id', id), '격리 조직 정리');
      for (const id of userIds) await ok(admin.auth.admin.deleteUser(id), '격리 계정 정리');
    }
    await rm(root, { recursive: true, force: true });
  }
}
