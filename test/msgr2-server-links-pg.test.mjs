// 메신저 v2 VPS 서버 연결(20261023190000_msgr2_server_links.sql) — 연결 코드 → 보고 → 승인 → 봇이 받고 답하기 → 다시 연결·정리 → 연결 해제 → 되돌림.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-server-links-pg.test.mjs
// 운영 기본(Pro 관문·1:1 밖 막기 켬)으로 본다. 서버 스크립트·봇은 anon 문맥(코드·토큰이 자격), 앱은 앱 기기 문맥.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-server-links-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261023190000_msgr2_server_links.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261023190000_msgr2_server_links.down.sql', import.meta.url));
const P = 'b0000000-0000-4000-8000-000000000001'; // Pro 주인
const F = 'b0000000-0000-4000-8000-000000000002'; // 무료
const X = 'b0000000-0000-4000-8000-000000000003'; // 남(Pro)

let db, pApp, pRun, fApp, xApp, PS;
const sha = (t) => createHash('sha256').update(t).digest('hex');
const newToken = () => `argo_bot_v2${randomBytes(24).toString('hex')}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lit = (o) => `${q(JSON.stringify(o))}::jsonb`;
// anon 문맥(서버 스크립트·봇) — 마지막 줄 또는 오류 문구
const anon = (sql) => { const r = db.raw(['-A', '-t', '-c', `set role anon; select set_config('argo.uid', '', false); select ${sql}`]); return r.status === 0 ? { out: r.stdout.trim().split('\n').pop() } : { err: r.stderr }; };
const anonOk = (sql) => { const r = anon(sql); if (r.err) throw new Error(r.err); return r.out; };
const app = (who, sql) => db.as(who.uid, who.sid, `select ${sql}`);
const appErr = (who, sql) => db.asErr(who.uid, who.sid, `select ${sql}`) ?? '';
const create = (who = pApp) => JSON.parse(app(who, 'public.msgr2_server_link_create()::text'));
const agentRep = (kind, id, name, tok, def = false) => ({ kind, id, name, default: def, token_hash: sha(tok), token_hint: tok.slice(0, 14) });
const report = (code, host, agents) => anon(`public.msgr2_server_link_report(${q(code)}, ${q(host)}, ${lit(agents)})`);
const get = (who, link = null) => JSON.parse(app(who, `public.msgr2_server_link_get(${link ? q(link) + '::uuid' : 'null'})::text`) || 'null');
const approve = (who, link, picks, retire = []) => JSON.parse(app(who, `public.msgr2_server_link_approve(${q(link)}::uuid, ${lit(picks)}, '{${retire.join(',')}}'::uuid[])::text`));
const status = (code) => JSON.parse(anonOk(`public.msgr2_server_link_status(${q(code)})::text`));
const updates = (tok, after = 0) => JSON.parse(anonOk(`public.msgr2_bot_updates(${q(tok)}, ${after}, 1)::text`));
const finish = (tok, attempt, text) => anon(`public.msgr2_bot_finish(${q(tok)}, ${q(attempt)}::uuid, ${q(text)})`);
const say = (who, room, body) => db.as(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${room}', 'user', '${who.uid}', ${q(body)}) returning id`);
const dm = (who, agent) => JSON.parse(app(who, `public.msgr2_agent_dm_open('${agent}')::text`)).room_id;
const agentOf = (host, kind, id, owner = P) => db.sql(`select id from public.msgr2_agents where owner_user_id = '${owner}' and ws_id = 'vps:${host}' and slug = '~bot.${kind}.${id}'`);
const xmins = (t, where) => db.xmins(t, where);
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);

// 처음 연결 한 바퀴(보고 → 승인 → 완료). 반환 { link, code, toks, agents }
function connect(host, list, picks = list.map(([k, i]) => [k, i]), who = pApp, retire = []) {
  const { link_id: link, code } = create(who);
  const toks = Object.fromEntries(list.map(([k, i]) => [`${k}:${i}`, newToken()]));
  assert.equal(report(code, host, list.map(([k, i, n], x) => agentRep(k, i, n, toks[`${k}:${i}`], x === 0))).err, undefined);
  const out = approve(who, link, picks.map(([kind, id]) => ({ kind, id })), retire);
  anonOk(`public.msgr2_server_link_done(${q(code)}, ${lit(out.map((o) => ({ kind: o.kind, id: o.id, ok: true, detail: '' })))})`);
  return { link, code, toks, out };
}

before(() => {
  if (!DB) return;
  db = setup(DB);
  db.sql(`create table if not exists public.test_pro (uid uuid primary key);
    create or replace function public.is_pro_for(p uuid) returns boolean language sql stable as $$ select exists (select 1 from public.test_pro where uid = p) $$;
    insert into public.test_pro values ('${P}'), ('${X}');
    insert into public.msgr_settings values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_bot_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  db.sql(`delete from public.msgr_settings where key in ('msgr2_lite', 'msgr2_pro_gate')`); // 운영 기본(켬)
  pApp = seedDevice(db, P, 'app'); pRun = seedDevice(db, P, 'runner'); fApp = seedDevice(db, F, 'app'); xApp = seedDevice(db, X, 'app');
  for (const u of [P, F, X]) {
    const s = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${u}') returning id`);
    db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${s}', '${u}', 'owner')`);
    if (u === P) PS = s;
  }
});

test('연결 코드: 앱 기기 + Pro만 만든다, 본체 기기·무료·anon은 거부, 10분에 10개 상한', { skip }, () => {
  const c = create();
  assert.match(c.code, /^argo_link_[0-9a-f]{48}$/);
  assert.equal(db.sql(`select code_hash = encode(sha256(convert_to('${c.code}', 'utf8')), 'hex') from public.msgr2_server_links where id = '${c.link_id}'`), 't', '원문이 아니라 해시만 저장');
  assert.match(appErr(pRun, 'public.msgr2_server_link_create()'), /msgr2_app_device_required/);
  assert.match(appErr(fApp, 'public.msgr2_server_link_create()'), /msgr2_pro_required/);
  assert.match(anon('public.msgr2_server_link_create()').err ?? '', /permission denied/);
  for (const t of ['msgr2_server_links', 'msgr2_bots']) assert.match(db.asErr(P, pApp.sid, `select * from public.${t}`) ?? '', /permission denied/, `${t} 직접 읽기 금지`);
  db.sql(`update public.msgr2_server_links set created_at = now() - interval '1 hour' where owner_user_id = '${P}'`);
  for (let i = 0; i < 10; i++) create();
  assert.match(appErr(pApp, 'public.msgr2_server_link_create()'), /msgr2_rate/);
  db.sql(`update public.msgr2_server_links set created_at = now() - interval '1 hour' where owner_user_id = '${P}'`);
});

test('보고: 코드당 한 번, v1 토큰 힌트·잘못된 호스트 거부, 만료 코드 거부, 앱에는 해시를 주지 않는다', { skip }, () => {
  const { link_id: link, code } = create();
  const t1 = newToken();
  assert.match(report(code, 'vps1', [{ ...agentRep('hermes', 'default', 'Hermes', t1), token_hint: 'argo_bot_abc' }]).err, /msgr_link_bad_agents/, 'v1 토큰(argo_bot_ + hex)은 받지 않는다');
  assert.match(report(code, 'bad host!', [agentRep('hermes', 'default', 'Hermes', t1)]).err, /msgr_link_bad_agents/);
  assert.equal(report(code, 'vps1', [agentRep('hermes', 'default', 'Hermes', t1, true)]).err, undefined);
  assert.match(report(code, 'evil', [agentRep('hermes', 'x', 'X', newToken())]).err, /msgr_link_used/, '두 번째 보고(코드를 본 남)는 409');
  const g = get(pApp, link);
  assert.equal(g.status, 'reported'); assert.equal(g.host, 'vps1');
  assert.deepEqual(g.agents, [{ kind: 'hermes', id: 'default', name: 'Hermes', default: true }]);
  assert.ok(!JSON.stringify(g).includes(sha(t1)), '토큰 해시는 앱에 가지 않는다');
  assert.equal(get(xApp, link), null, '남의 연결은 안 보인다');
  assert.deepEqual(status(code), { status: 'reported', approved: [] });
  const c2 = create();
  db.sql(`update public.msgr2_server_links set expires_at = now() - interval '1 second' where id = '${c2.link_id}'`);
  assert.match(report(c2.code, 'vps1', [agentRep('hermes', 'default', 'Hermes', newToken())]).err, /msgr_link_invalid/);
  assert.match(appErr(pApp, `public.msgr2_server_link_approve('${c2.link_id}'::uuid, '[{"kind":"hermes","id":"default"}]'::jsonb)`), /msgr_link_invalid/);
});

test('승인 → 에이전트(hosting bot) + 봇 토큰, 남·무료는 승인 못 함, 스크립트는 승인 목록만 본다', { skip }, () => {
  const { link_id: link, code } = create();
  const toks = { d: newToken(), r: newToken() };
  report(code, 'vps-a', [agentRep('hermes', 'default', 'Hermes', toks.d, true), agentRep('hermes', 'research', 'Research', toks.r)]);
  assert.match(appErr(xApp, `public.msgr2_server_link_approve('${link}'::uuid, '[{"kind":"hermes","id":"default"}]'::jsonb)`), /msgr_link_invalid/);
  assert.match(appErr(pApp, `public.msgr2_server_link_approve('${link}'::uuid, '[{"kind":"hermes","id":"nope"}]'::jsonb)`), /msgr_link_no_picks/);
  const out = approve(pApp, link, [{ kind: 'hermes', id: 'default' }]);
  assert.equal(out.length, 1); assert.equal(out[0].reused, false);
  const ag = agentOf('vps-a', 'hermes', 'default');
  assert.equal(out[0].agent_id, ag);
  assert.equal(db.sql(`select hosting || '|' || status || '|' || display_name from public.msgr2_agents where id = '${ag}'`), 'bot|active|Hermes');
  assert.equal(db.sql(`select count(*) from public.msgr2_agents where ws_id = 'vps:vps-a'`), '1', '고르지 않은 research는 만들지 않는다');
  assert.equal(db.sql(`select count(*) from public.msgr2_bots where agent_id = '${ag}' and token_hash = '${sha(toks.d)}' and revoked_at is null`), '1');
  assert.deepEqual(status(code), { status: 'approved', approved: [{ kind: 'hermes', id: 'default' }] });
  assert.match(appErr(pApp, `public.msgr2_server_link_approve('${link}'::uuid, '[{"kind":"hermes","id":"default"}]'::jsonb)`), /msgr_link_used/, '두 번 승인 금지');
  anonOk(`public.msgr2_server_link_done(${q(code)}, '[{"kind":"hermes","id":"default","ok":true,"detail":"ok"}]'::jsonb)`);
  assert.equal(get(pApp, link).status, 'done');
  assert.deepEqual(JSON.parse(app(pApp, 'public.msgr2_bots_mine()::text')).map((b) => `${b.host}:${b.name}:${b.kind}`), ['vps-a:Hermes:hermes']);
  assert.deepEqual(JSON.parse(app(xApp, 'public.msgr2_bots_mine()::text')), [], '남의 봇은 안 보인다');
});

test('봇이 받고 답한다: 1:1 글 → 봇 일(본체 없이) → getUpdates가 잡음 → 최종 답이 v2 글로, 재전송은 같은 id, 유휴 쓰기 0', { skip }, () => {
  const { toks } = connect('vps-b', [['hermes', 'default', 'Hermes']]);
  const tok = toks['hermes:default'];
  const ag = agentOf('vps-b', 'hermes', 'default');
  assert.deepEqual(JSON.parse(anonOk(`public.msgr2_bot_me(${q(tok)})::text`)).agent_id, ag);
  assert.match(anon(`public.msgr2_bot_me(${q(newToken())})`).err, /msgr_bot_unauthorized/);
  const room = dm(pApp, ag);
  // 유휴: 일이 없을 때 두 번 불러도 봇·일 표에 쓰기 없음(last_seen_at은 첫 호출에서 이미 채워졌다)
  updates(tok);
  const before = [xmins('msgr2_bots', `agent_id = '${ag}'`), xmins('msgr2_works', `agent_id = '${ag}'`)];
  assert.deepEqual(updates(tok), []); assert.deepEqual(updates(tok), []);
  assert.deepEqual([xmins('msgr2_bots', `agent_id = '${ag}'`), xmins('msgr2_works', `agent_id = '${ag}'`)], before, '유휴 폴링은 쓰기 0');
  const src = Number(say(pApp, room, '안녕 헤르메스'));
  const w = JSON.parse(db.sql(`select row_to_json(x)::text from (select id, kind, state from public.msgr2_works where room_id = '${room}') x`));
  assert.equal(w.kind, 'bot'); assert.equal(w.state, 'offered', '주인 본체에 bot 기능이 없어도 VPS 봇 토큰이 있으면 일이 생긴다');
  const [u] = updates(tok);
  assert.equal(u.update_id, src);
  assert.equal(u.message.execution_attempt, w.id); assert.equal(u.message.text, '안녕 헤르메스');
  assert.equal(u.message.chat.id, room); assert.equal(u.message.chat.kind, 'dm');
  assert.equal(db.sql(`select state || '|' || (lease_device = (select id from public.msgr2_bots where agent_id = '${ag}' and revoked_at is null))::text from public.msgr2_works where id = '${w.id}'`), 'accepted|true');
  assert.deepEqual(updates(tok, src), [], '받은 뒤(offset)에는 다시 주지 않는다');
  assert.equal(updates(tok, 0).length, 1, '받고 답하지 않은 일은 offset 이전이면 다시 준다(봇 재시작)');
  // 남의 봇은 이 일에 답하지 못한다
  const other = connect('vps-x', [['hermes', 'default', 'X']], undefined, xApp).toks['hermes:default'];
  assert.match(finish(other, w.id, '가로채기').err, /msgr_execution_not_owner/);
  assert.match(finish(tok, w.id, '').err, /msgr_bot_bad_body/);
  const mid = finish(tok, w.id, '안녕하세요').out;
  assert.equal(db.sql(`select author_kind || '|' || author_agent_id || '|' || body || '|' || (meta->>'work') from public.msgr2_messages where id = ${mid}`), `agent|${ag}|안녕하세요|${w.id}`);
  assert.equal(db.sql(`select state || '|' || has_result from public.msgr2_works where id = '${w.id}'`), 'done|true');
  const n = db.sql(`select count(*) from public.msgr2_messages where room_id = '${room}'`);
  assert.equal(finish(tok, w.id, '안녕하세요').out, mid, '보관함 재전송은 같은 글 id, 새 글 없음');
  assert.equal(db.sql(`select count(*) from public.msgr2_messages where room_id = '${room}'`), n);
  // 보충 글: 1시간 안에 일을 받은 방만
  assert.ok(Number(anonOk(`public.msgr2_bot_send(${q(tok)}, '${room}'::uuid, '파일 주소')`)) > 0);
  const other2 = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${PS}', 'private', 'o') returning id`);
  assert.match(anon(`public.msgr2_bot_send(${q(tok)}, '${other2}'::uuid, '스팸')`).err, /msgr_bot_not_member/);
  // 무료가 되면 받기 거부(403 이름)
  db.sql(`delete from public.test_pro where uid = '${P}'`);
  try { assert.match(anon(`public.msgr2_bot_updates(${q(tok)}, 0, 1)`).err, /msgr_bot_plan_required/); } finally { db.sql(`insert into public.test_pro values ('${P}')`); }
});

test('다시 연결: 같은 에이전트는 토큰만 교체(옛 토큰 무효), 이번 보고에 없는 봇은 정리 제안 → 고르면 은퇴·방에서 빠짐', { skip }, () => {
  const first = connect('vps-c', [['hermes', 'default', 'Hermes'], ['hermes', 'old', 'Old']]);
  const agD = agentOf('vps-c', 'hermes', 'default'); const agO = agentOf('vps-c', 'hermes', 'old');
  const room = dm(pApp, agO);
  const { link_id: link, code } = create();
  const t2 = newToken();
  report(code, 'vps-c', [agentRep('hermes', 'default', 'Hermes', t2, true)]);
  assert.deepEqual(get(pApp, link).missing.map((m) => `${m.agent_id}:${m.name}`), [`${agO}:Old`]);
  const out = approve(pApp, link, [{ kind: 'hermes', id: 'default' }], [agO]);
  assert.deepEqual(out.map((o) => `${o.agent_id}:${o.reused}`), [`${agD}:true`]);
  assert.equal(db.sql(`select count(*) from public.msgr2_agents where ws_id = 'vps:vps-c'`), '2', '새 에이전트 행을 만들지 않는다');
  assert.match(anon(`public.msgr2_bot_me(${q(first.toks['hermes:default'])})`).err, /msgr_bot_unauthorized/, '옛 토큰은 무효');
  assert.equal(JSON.parse(anonOk(`public.msgr2_bot_me(${q(t2)})::text`)).agent_id, agD);
  assert.equal(db.sql(`select status from public.msgr2_agents where id = '${agO}'`), 'retired');
  assert.equal(db.sql(`select count(*) from public.msgr2_room_members where room_id = '${room}' and member_id = '${agO}' and removed_at is null`), '0');
  assert.match(anon(`public.msgr2_bot_me(${q(first.toks['hermes:old'])})`).err, /msgr_bot_unauthorized/);
  // 남의 봇·다른 서버의 봇은 p_retire로 은퇴시키지 못한다
  const xb = connect('vps-y', [['hermes', 'default', 'Y']], undefined, xApp);
  const agX = agentOf('vps-y', 'hermes', 'default', X);
  const c3 = create(); report(c3.code, 'vps-c', [agentRep('hermes', 'default', 'Hermes', newToken())]);
  approve(pApp, c3.link_id, [{ kind: 'hermes', id: 'default' }], [agX]);
  assert.equal(db.sql(`select status from public.msgr2_agents where id = '${agX}'`), 'active');
  assert.ok(xb);
});

test('연결 해제: 토큰 폐기·에이전트 retired·방 멤버 닫힘·열린 일 취소, 글은 남는다, 남은 해제 못 함, 같은 서버로 다시 연결하면 되살아난다', { skip }, () => {
  const { toks } = connect('vps-d', [['hermes', 'default', 'Hermes']]);
  const tok = toks['hermes:default']; const ag = agentOf('vps-d', 'hermes', 'default');
  const room = dm(pApp, ag);
  say(pApp, room, '첫 질문');
  const [u] = updates(tok); finish(tok, u.message.execution_attempt, '첫 답');
  say(pApp, room, '두 번째');
  assert.match(appErr(xApp, `public.msgr2_bot_revoke('${ag}'::uuid)`), /msgr2_forbidden/);
  assert.equal(app(pApp, `public.msgr2_bot_revoke('${ag}'::uuid)::text`), 'true');
  assert.equal(db.sql(`select status from public.msgr2_agents where id = '${ag}'`), 'retired');
  assert.equal(db.sql(`select count(*) from public.msgr2_room_members where member_id = '${ag}' and removed_at is null`), '0');
  assert.equal(db.sql(`select count(*) from public.msgr2_works where agent_id = '${ag}' and state in ('offered', 'accepted', 'running')`), '0');
  assert.equal(db.sql(`select count(*) from public.msgr2_messages where room_id = '${room}' and body = '첫 답'`), '1', '기억 데이터는 지우지 않는다');
  assert.match(anon(`public.msgr2_bot_updates(${q(tok)}, 0, 1)`).err, /msgr_bot_unauthorized/, '서버 쪽 봇은 다음 폴링에서 401');
  assert.deepEqual(JSON.parse(app(pApp, 'public.msgr2_bots_mine()::text')).filter((b) => b.host === 'vps-d'), []);
  assert.match(appErr(pApp, `public.msgr2_bot_revoke('${ag}'::uuid)`), /msgr2_forbidden/, '두 번 해제는 거부(이미 없음)');
  connect('vps-d', [['hermes', 'default', 'Hermes']]);
  assert.equal(db.sql(`select status from public.msgr2_agents where id = '${ag}'`), 'active', '같은 행이 되살아난다(고아 행이 늘지 않음)');
  assert.match(anon(`public.msgr2_bot_me(${q(tok)})`).err, /msgr_bot_unauthorized/, '해제한 옛 토큰은 에이전트가 되살아나도 무효');
});

test('#1154 검수 I-1·I-2: 주인이 팀 방에서 빠지면 그 방 일을 받지도 답하지도 못한다, 리스가 지난 일은 답 못 함, 남의 봇은 내 일을 못 가져간다', { skip }, () => {
  const { toks } = connect('vps-t', [['hermes', 'default', 'Hermes']]);
  const tok = toks['hermes:default']; const ag = agentOf('vps-t', 'hermes', 'default');
  setting('msgr2_lite', 'off'); // 팀 방(1:1 밖)
  try {
    const T = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id, name) values ('team', '${X}', 't') returning id`);
    db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${T}', '${X}', 'owner'), ('${T}', '${P}', 'member')`);
    db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${ag}', '${T}', 'all')`);
    const R = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${T}', 'open', '팀방') returning id`);
    db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${R}', 'user', '${X}'), ('${R}', 'user', '${P}'), ('${R}', 'agent', '${ag}')`);
    const post = (who, body) => db.as(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${R}', 'user', '${who.uid}', ${q(body)}, '{${ag}}') returning id`);
    post(pApp, '첫 일');
    const [ua] = updates(tok);
    assert.ok(ua, '방에 있는 동안은 받는다');
    post(xApp, '두 번째 일');
    const wb = db.sql(`select id from public.msgr2_works where room_id = '${R}' and state = 'offered'`);
    assert.ok(wb);
    // 손님 기한이 끝난 주인(방 멤버 행은 그대로, S2 _msgr2_owner_active) — 받기·답하기 모두 막힌다
    db.sql(`update public.msgr2_space_members set role = 'guest', expires_at = now() - interval '1 minute' where space_id = '${T}' and user_id = '${P}'`);
    assert.deepEqual(updates(tok, 0), [], '기한 끝난 손님 주인의 봇에게 그 방 일은 없다');
    assert.match(finish(tok, ua.message.execution_attempt, '답').err, /msgr_execution_forbidden/);
    db.sql(`update public.msgr2_space_members set role = 'member', expires_at = null where space_id = '${T}' and user_id = '${P}'`);
    // P가 팀 공간·방에서 빠진다
    db.sql(`update public.msgr2_space_members set removed_at = now() where space_id = '${T}' and user_id = '${P}'`);
    db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${R}' and member_kind = 'user' and member_id = '${P}'`);
    assert.deepEqual(updates(tok, 0), [], '빠진 방의 일(offered·잡은 일)은 주지 않는다 — 원문·방 이름이 새지 않는다');
    assert.equal(db.sql(`select state from public.msgr2_works where id = '${wb}'`), 'offered', '잡지도 않는다');
    const n = db.sql(`select count(*) from public.msgr2_messages where room_id = '${R}'`);
    assert.match(finish(tok, ua.message.execution_attempt, '답').err, /msgr_execution_forbidden/, '이미 잡은 일도 답이 방에 들어가지 않는다');
    assert.equal(db.sql(`select count(*) from public.msgr2_messages where room_id = '${R}'`), n);
  } finally { setting('msgr2_lite', null); }
  // 오래 걸린 작업(재검수 ⓐ): 16분 뒤 답은 받는다(리스는 다시 주기에만), 만들어진 지 25시간 지난 답은 거부
  const room = dm(pApp, ag);
  say(pApp, room, '긴 작업');
  const [uc] = updates(tok);
  const wc = uc.message.execution_attempt;
  db.sql(`update public.msgr2_works set lease_until = now() - interval '1 minute', created_at = now() - interval '16 minutes' where id = '${wc}'`);
  assert.deepEqual(updates(tok, 0), [], '리스가 지난 일은 다시 주지 않는다');
  const late = finish(tok, wc, '16분 걸린 답');
  assert.equal(late.err, undefined, '16분 뒤 답은 받는다');
  assert.equal(db.sql(`select body || '|' || (select state from public.msgr2_works where id = '${wc}') from public.msgr2_messages where id = ${late.out}`), '16분 걸린 답|done', '방에 올라가고 일이 끝난다');
  say(pApp, room, '아주 오래된 질문');
  const [ue] = updates(tok);
  db.sql(`update public.msgr2_works set lease_until = now() - interval '24 hours', created_at = now() - interval '25 hours' where id = '${ue.message.execution_attempt}'`);
  assert.match(finish(tok, ue.message.execution_attempt, '25시간 뒤 답').err, /msgr_execution_not_owner/, '만들어진 지 24시간이 지난 답은 거부');
  // I-2: 남의 봇은 내 offered 일을 가져가지 못한다
  say(pApp, room, '새 질문');
  const wd = db.sql(`select id from public.msgr2_works where room_id = '${room}' and state = 'offered'`);
  const other = connect('vps-i2', [['hermes', 'default', 'Other']], undefined, xApp).toks['hermes:default'];
  assert.deepEqual(updates(other, 0), [], '다른 사용자의 봇에게 내 일은 없다');
  assert.equal(db.sql(`select state from public.msgr2_works where id = '${wd}'`), 'offered', '내 일은 그대로 offered');
  assert.equal(updates(tok)[0].message.execution_attempt, wd, '내 봇은 받는다');
});

test('일 만들기 관문: VPS 봇 토큰이 없으면 봇 일은 종전처럼 "업데이트 필요" 안내', { skip }, () => {
  const ag = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name, hosting) values ('${X}', 'w', 'pcbot', 'pc', 'bot') returning id`);
  db.sql(`update public.msgr2_bots set revoked_at = now() where owner_user_id = '${X}'`);
  const room = dm(xApp, ag);
  say(xApp, room, '안녕');
  assert.equal(db.sql(`select count(*) from public.msgr2_works where room_id = '${room}'`), '0');
  assert.equal(JSON.parse(db.sql(`select meta::text from public.msgr2_messages where room_id = '${room}' and kind = 'system' order by id desc limit 1`)).limit, 'need_update');
});

test('되돌림: 봇 에이전트를 닫고 표·함수를 지운다, 다시 적용해도 된다', { skip }, () => {
  const live = db.sql(`select count(*) from public.msgr2_agents where ws_id like 'vps:%' and status = 'active'`);
  assert.ok(Number(live) > 0);
  db.psql(['-c', readFileSync(DOWN, 'utf8')]);
  assert.equal(db.sql(`select count(*) from public.msgr2_agents where ws_id like 'vps:%' and status = 'active'`), '0', '고아로 남지 않게 닫는다');
  assert.equal(db.sql(`select to_regclass('public.msgr2_bots') is null and to_regprocedure('public.msgr2_bot_updates(text,bigint,integer)') is null`), 't');
  assert.doesNotMatch(db.sql(`select prosrc from pg_proc where proname = '_msgr2_runner_has'`), /msgr2_bots/);
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  db.psql(['-c', readFileSync(MIG, 'utf8')]); // 두 번 적용(멱등)
  assert.match(db.sql(`select prosrc from pg_proc where proname = '_msgr2_runner_has'`), /msgr2_bots/);
});
