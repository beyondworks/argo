// qbwr 실전 시험 Q6~Q11(볼트 2026-10-18-msgr2-u9-qbwr-plan 4절) — 백필(Q4) 뒤에 돌린다. 칸마다 { 칸, 이름, 기대, 실제, 통과, 메모 } JSON 한 줄.
// 실행: bash scripts/qbwr-q6.sh [q6 q7 …]            qbwr(검문한 접속·anon 키·합성 비밀번호)
//       node test/fixtures/msgr2/qbwr-q6.mjs --local postgresql://postgres@127.0.0.1:<포트>/<db> [q6 …]   로컬 연습 DB(경로·출력 확인용)
// 엣지(msgr2-push)가 필요한 칸은 "엣지 대기"로 적는다(배포는 맥 one). 합성 계정(@example.test)만 쓴다. Q11은 p059 계정을 실제로 지운다(맨 마지막에).
import { makeCaller, APP, RUNNER } from './qbwr-caller.mjs';
import { randomUUID } from 'node:crypto';

const C = await makeCaller();
const which = C.argv.filter((a) => /^q\d+$/.test(a));
const want = (q) => !which.length || which.includes(q);
const IDLE_S = Number(process.env.QBWR_IDLE_S ?? (C.mode === 'local' ? 2 : 600));
const results = [];
const cell = (q, name, expect, actual, pass, memo) => { const r = { q, name, expect, actual, pass: pass === null ? null : !!pass, ...(memo ? { memo } : {}) }; results.push(r); console.log(JSON.stringify(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = C.admin;
const has = (rel) => A(`select to_regclass('${rel}') is not null`) === 't';
const uidOf = (n) => A(`select id from auth.users where email = 'p${String(n).padStart(3, '0')}@example.test'`);
const nOf = (uid) => Number(A(`select substring(email from 2 for 3) from auth.users where id = '${uid}'`));
async function person(n, args = APP) { const s = await C.login(n); const d = await s.rpc('msgr2_device_register', args); s.device = d.data?.device_id ?? null; if (!s.device) throw new Error(`기기 등록 실패 p${n}: ${d.error?.message}`); return s; }
const big = () => A(`select id from public.msgr2_rooms where id = (select id from public.msgr_channels where org_id = (select id from public.msgr_orgs where slug = 'qbwr-org-1') and name = '공개1')`);

// 쓰기·방송 스냅샷: 표별 n_tup 합(인증 제외)과 방송 행 수. 다른 연결의 통계가 넘어오도록 잠깐 기다린다
const RT = () => (has('realtime.sent') ? 'realtime.sent' : 'realtime.messages'); // 로컬 대역은 realtime.send가 realtime.sent에 쓴다
async function snap() {
  await sleep(C.mode === 'local' ? 300 : 1500);
  return JSON.parse(A(`select jsonb_build_object('t', coalesce(jsonb_object_agg(schemaname || '.' || relname, n_tup_ins + n_tup_upd + n_tup_del), '{}'), 'rt', (select count(*) from ${RT()}))
    from pg_stat_all_tables where schemaname in ('public', 'realtime', 'net', 'storage') and n_tup_ins + n_tup_upd + n_tup_del > 0`));
}
const delta = (a, b) => { const t = {}; let w = 0; for (const [k, v] of Object.entries(b.t)) { const d = v - (a.t[k] ?? 0); if (d) { t[k] = d; w += d; } } return { writes: w, rt: b.rt - a.rt, tables: t }; };

if (want('q6')) {
  // 스위치(설계 6절 4단계): 표지 두 줄. 옮긴 방이 열리고 새 방 0, 목록·검색·안 읽음 응답 시간
  A(`insert into public.msgr_settings (key, value) values ('msgr2_switched_at', now()::text), ('msgr2_enabled', 'on') on conflict (key) do nothing`);
  const o = await person(1);
  const space = A(`select id from public.msgr2_spaces where slug = 'qbwr-org-1'`);
  const roomsBefore = Number(A('select count(*) from public.msgr2_rooms'));
  const list = await o.rpc('msgr2_dm_list', { p_include_groups: true });
  cell('Q6', '1:1 목록', '오류 없음', list.error?.message ?? `${Array.isArray(list.data) ? list.data.length : '?'}개 ${list.ms.toFixed(0)}ms`, !list.error, { ms: Math.round(list.ms) });
  // 옮긴 1:1(사람 둘의 direct 방)을 그 사람이 다시 열면 같은 방, 새 방 0 — 팀 공간 방이면 p_space, 개인이면 null
  const pair = A(`select r.id || '|' || m1.member_id || '|' || m2.member_id || '|' || case when s.kind = 'team' then s.id::text else '' end
     from public.msgr2_rooms r join public.msgr2_spaces s on s.id = r.space_id
     join public.msgr2_room_members m1 on m1.room_id = r.id and m1.member_kind = 'user' and m1.removed_at is null
     join public.msgr2_room_members m2 on m2.room_id = r.id and m2.member_kind = 'user' and m2.member_id > m1.member_id and m2.removed_at is null
     where r.kind = 'direct' and s.deleted_at is null and r.archived_at is null order by (s.kind = 'team') desc, r.id limit 1`);
  if (pair) {
    const [room, a1, a2, sp] = pair.split('|');
    const actor = a1 === o.uid ? o : await person(nOf(a1));
    const op = await actor.rpc('msgr2_dm_open', { p_user: a2, p_space: sp || null });
    const got = op.data?.room_id ?? op.data?.id ?? op.data?.room?.id ?? null;
    cell('Q6', `옮긴 1:1 다시 열기 = 같은 방(${sp ? '팀' : '개인'})`, room, op.error?.message ?? got, !op.error && got === room, { ms: Math.round(op.ms), existing: op.data?.existing });
  } else cell('Q6', '옮긴 1:1 다시 열기', '사람 둘 1:1', '합성 데이터에 없음', false);
  cell('Q6', '스위치 뒤 새 방 0', roomsBefore, Number(A('select count(*) from public.msgr2_rooms')), Number(A('select count(*) from public.msgr2_rooms')) === roomsBefore);
  // 검색 상한은 방이 가장 많은 합성 계정으로 잰다(검색 후보가 가장 넓다)
  const heavy = A(`select m.member_id || '|' || count(*) from public.msgr2_room_members m join public.msgr2_rooms r on r.id = m.room_id join auth.users u on u.id = m.member_id and u.email like '%@example.test'
     where m.member_kind = 'user' and m.removed_at is null and r.archived_at is null group by m.member_id order by count(*) desc, m.member_id limit 1`).split('|');
  const openRooms = Number(heavy[1]);
  const hv = heavy[0] === o.uid ? o : await person(nOf(heavy[0]));
  // 검색어: 이 사람이 들어 있는 방의 실제 합성 글 본문(큰 방은 글 10만 개)
  const term = A(`select m.body from public.msgr2_messages m join public.msgr2_room_members rm on rm.room_id = m.room_id and rm.member_kind = 'user' and rm.member_id = '${hv.uid}' and rm.removed_at is null
     where m.body like '합성 글 %' and m.deleted_at is null order by m.id desc limit 1`);
  const sr = await hv.rpc('msgr2_search', { p_q: term, p_limit: 20 });
  const hits = Array.isArray(sr.data?.messages) ? sr.data.messages.length : null;
  cell('Q6', `검색 응답(내 방 ${openRooms}개)`, '0.65초 이하·글 결과 있음', sr.error?.message ?? `${sr.ms.toFixed(0)}ms·글 ${hits}건`, !sr.error && sr.ms <= 650 && hits > 0, { ms: Math.round(sr.ms), open_rooms: openRooms, term });
  const un = await o.rpc('msgr2_unread', { p_space: null });
  cell('Q6', '안 읽음', '오류 없음', un.error?.message ?? `${un.ms.toFixed(0)}ms`, !un.error, { ms: Math.round(un.ms) });
}

if (want('q7')) {
  // 게이트 B 상황을 실 경로로: 단계별 쓰기·방송(로컬 값은 test/msgr2-gate-b-pg.test.mjs·볼트 gate-b.md와 대조)
  const steps = [];
  const step = async (name, fn) => { const a = await snap(); const extra = await fn(); const d = delta(a, await snap()); steps.push({ name, ...d }); cell('Q7', name, '기록', `쓰기 ${d.writes}·방송 ${d.rt}`, null, { ...d, ...(extra ?? {}) }); };
  let run, app, AG, room, W, gen = null;
  const seqs = new Map();
  const env = (type, work, agent, data) => { const s = (seqs.get(`${work}`) ?? 0) + 1; seqs.set(`${work}`, s); return { v: 1, id: randomUUID(), work, seq: s, type, agent, device: run.device, at: new Date().toISOString(), data }; };
  const send = async (e) => { const r = await run.rpc('msgr2_link_send', { p_env: e }); if (r.error || r.data?.ok === false) throw new Error(`${e.type}: ${r.error?.message ?? JSON.stringify(r.data)}`); return r.data; };
  await step('1 로그인(runner·app 등록 + 에이전트 목록)', async () => {
    run = await person(1, RUNNER); app = await person(1);
    const mine = A(`select string_agg(ws_id || ':' || slug, ',' order by slug) from (select ws_id, slug from public.msgr_agents where owner_user_id = '${run.uid}' order by slug limit 3) x`).split(',');
    await send({ ...env('agent.sync', null, null, { agents: mine.map((x) => { const [ws, slug] = x.split(':'); return { ws, slug, name: slug, role: '', face_hash: null }; }) }), agent: null });
    // 에이전트를 막지 않은 1:1 방이 있거나 아직 방이 없는 에이전트(막힌 방이면 offer가 생기지 않는다)
    AG = A(`select a.id from public.msgr2_agents a where a.owner_user_id = '${run.uid}' and a.slug in (${mine.map((x) => `'${x.split(':')[1]}'`).join(', ')})
      order by exists (select 1 from public.msgr2_room_members m join public.msgr2_rooms r on r.id = m.room_id where m.member_kind = 'agent' and m.member_id = a.id and r.agent_policy = 'blocked'), a.slug limit 1`);
  });
  await step('2 공간 목록', async () => { await app.rpc('msgr2_my_personal_space'); });
  await step('3 에이전트 1:1 방 열기', async () => { const r = await app.rpc('msgr2_agent_dm_open', { p_agent: AG }); room = r.data?.room_id ?? r.data?.id ?? null; if (!room) throw new Error(`agent_dm_open: ${r.error?.message ?? JSON.stringify(r.data)}`); });
  await step('4 글 보내기(→ offer)', async () => {
    const r = await app.insert('msgr2_messages', { room_id: room, author_kind: 'user', author_user_id: app.uid, body: '이거 해줘' });
    if (r.error) throw new Error(`글: ${r.error.message}`);
    for (let i = 0; i < 20 && !W; i++) { W = A(`select id from public.msgr2_works where room_id = '${room}' order by created_at desc limit 1`) || null; if (!W) await sleep(200); }
    if (!W) throw new Error('offer 없음');
  });
  await step('5 본체 받기(따라잡기·accept·진행)', async () => {
    await run.rpc('msgr2_link_pending');
    await send(env('work.accept', W, AG, {}));
    gen = Number(A(`select lease_gen from public.msgr2_works where id = '${W}'`));
    await send(env('work.progress', W, AG, { stage: 'thinking', lease_gen: gen })).catch(() => {}); // 진행은 저장하지 않는 방송 — 서버가 받지 않아도 다음으로
  });
  await step('6 결재(요청·결정·효과)', async () => {
    const ap = randomUUID();
    await send(env('work.approval_request', W, AG, { approval_id: ap, action: '메일 발송', risk: 'high', summary: '3명', effect_key: `mail-${W.slice(0, 8)}`, expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    const d = await app.rpc('msgr2_approval_decide', { p_approval: ap, p_decision: 'approve' });
    if (d.error) throw new Error(`결정: ${d.error.message}`);
    await send(env('work.effect', W, AG, { effect_key: `mail-${W.slice(0, 8)}`, state: 'intent', kind: 'mail' }));
    await send(env('work.effect', W, AG, { effect_key: `mail-${W.slice(0, 8)}`, state: 'done' }));
  });
  await step('7 결과', async () => { await send(env('work.result', W, AG, { text: '끝', files: [], handoffs: [] })); return { state: A(`select state from public.msgr2_works where id = '${W}'`) }; });
  const a = await snap(); await sleep(IDLE_S * 1000); const d = delta(a, await snap());
  cell('Q7', `8 유휴 ${IDLE_S}초`, '쓰기 0·방송 0', `쓰기 ${d.writes}·방송 ${d.rt}`, d.writes === 0 && d.rt === 0, d);
  // 재접속: 앱은 마지막으로 받은 글 id부터 따라잡는다(0부터 부르면 전 기록을 받는다 — 실제 앱은 그렇게 부르지 않는다)
  const lastSeen = Number(A(`select coalesce(max(id), 0) - 5 from public.msgr2_messages where room_id = '${room}'`));
  await step('9 재접속 따라잡기', async () => {
    const p = await run.rpc('msgr2_link_pending'); const c = await app.rpc('msgr2_catch_up', { p_since_id: lastSeen });
    if (p.error || c.error) throw new Error(`따라잡기: ${p.error?.message ?? ''} ${c.error?.message ?? ''}`);
  });
}

if (want('q8')) {
  // 푸시: 글 → pg_net → 엣지 1번. 로컬은 pg_net 대역 표(가짜 엣지 — 경로만), qbwr는 실 pg_net이 qbwr 엣지 주소로 보낸다(엣지 미배포면 404 = 엣지 대기)
  const url = C.mode === 'local' ? 'http://127.0.0.1:9/fake-edge/msgr2-push' : 'https://qbwrlynzvjmphwuqglsx.supabase.co/functions/v1/msgr2-push';
  A(`insert into public.msgr_settings (key, value) values ('msgr2_push_url', '${url}') on conflict (key) do update set value = excluded.value`);
  const o = await person(1);
  const space = A(`select id from public.msgr2_spaces where slug = 'qbwr-org-1'`);
  const otherUid = A(`select user_id from public.msgr2_space_members where space_id = '${space}' and user_id <> '${o.uid}' and removed_at is null order by user_id limit 1`);
  const p = await person(nOf(otherUid), { ...APP, p_push_token: `fake-token-q8-${Date.now()}` });
  const op = await o.rpc('msgr2_dm_open', { p_user: p.uid, p_space: space });
  const room = op.data?.room_id ?? op.data?.id;
  const before = C.mode === 'local' ? Number(A('select count(*) from public._net_calls')) : Number(A('select count(*) from net._http_response'));
  const m = await o.insert('msgr2_messages', { room_id: room, author_kind: 'user', author_user_id: o.uid, body: '푸시 시험' });
  if (C.mode === 'local') {
    const call = A(`select coalesce(jsonb_agg(jsonb_build_object('url', url, 'body', body)), '[]') from public._net_calls where body->>'message_id' = '${m.data?.id}'`);
    const calls = JSON.parse(call);
    cell('Q8', '글 1개 → 엣지 호출 1번(가짜 엣지, 경로만)', `1번·${url}·{message_id}`, `${calls.length}번·${calls[0]?.url ?? '-'}`, calls.length === 1 && calls[0].url === url && String(calls[0].body.message_id) === String(m.data?.id));
  } else {
    let after = before; for (let i = 0; i < 30 && after === before; i++) { await sleep(500); after = Number(A('select count(*) from net._http_response')); }
    const st = A('select status_code from net._http_response order by id desc limit 1');
    cell('Q8', '글 1개 → pg_net 응답 1건(qbwr 엣지 주소)', '응답 행 +1', `+${after - before}·상태 ${st}`, after - before >= 1, { edge: st === '404' ? '엣지 대기(미배포)' : st });
  }
  cell('Q8', '무효 토큰 → 기기 행에서 비우기·장부 1행', '엣지가 처리', '엣지 대기', null, { wait: '엣지 msgr2-push 배포(맥 one, 2026-10-19 13:00 KST 뒤)' });
}

if (want('q9')) {
  // 보존·pg_net(#1092): 판, cron 등록, realtime.messages 파티션별 행 수, net 응답 보존, 큐 행 수, 처리 지연(앞 요청이 느릴 때 뒤 요청이 얼마나 기다리나)
  cell('Q9', 'pg_net 판', '기록', A(`select coalesce((select extversion from pg_extension where extname = 'pg_net'), '없음')`), null);
  if (has('cron.job')) {
    const jobs = A(`select coalesce(string_agg(jobname || ' ' || schedule, ', ' order by jobname), '') from cron.job where jobname in ('msgr2-retention-prune', 'msgr2-push-prune', 'cron-run-details-retention') or jobname like 'msgr2%'`);
    cell('Q9', 'cron 등록(msgr2-retention-prune·msgr2-push-prune)', '둘 다 있음', jobs || '없음', /msgr2-retention-prune/.test(jobs) && /msgr2-push-prune/.test(jobs));
  } else cell('Q9', 'cron 등록', '둘 다 있음', 'pg_cron 없음(로컬)', null);
  const parts = A(`select coalesce(string_agg(c.relname, ',' order by c.relname), '') from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'realtime.messages'::regclass`);
  const hasAt = A(`select count(*) from information_schema.columns where table_schema = 'realtime' and table_name = 'messages' and column_name = 'inserted_at'`) === '1';
  const rtRows = hasAt ? A(`select coalesce(jsonb_agg(jsonb_build_object('day', d, 'rows', n) order by d), '[]') from (select date_trunc('day', inserted_at)::date d, count(*) n from realtime.messages group by 1) x`).replace(/\s/g, '') : '"로컬 대역(inserted_at 없음)"';
  cell('Q9', 'realtime.messages 파티션·날짜별 행 수(보존 주기 — 하루 뒤 다시 재서 지워졌는지 본다)', '기록', `파티션 ${parts ? parts.split(',').length : 0}개`, null, { partitions: parts ? parts.split(',') : [], by_day: (() => { try { return JSON.parse(rtRows); } catch { return rtRows; } })(), recheck: '24~48시간 뒤 같은 칸을 다시 돌려 오래된 날짜가 빠졌는지 확인(발행 전 조건)' });
  if (has('net.http_request_queue') && has('net._http_response')) {
    cell('Q9', 'pg_net 큐 행 수(지금)', '기록', A('select count(*) from net.http_request_queue'), null);
    cell('Q9', 'net._http_response 보존(가장 오래된 응답)', '기록', A(`select coalesce(min(created)::text, '-') || ' / ' || count(*) from net._http_response`), null);
    // 앞 요청이 느릴 때: 응답 없는 문서용 주소 192.0.2.1(RFC 5737, 연결 대기 5초)를 먼저 넣고, 곧바로 qbwr REST 요청 3개를 넣어 뒤 요청의 처리 지연을 잰다
    const t0 = Date.now();
    const slow = A(`select net.http_get(url := 'http://192.0.2.1/', timeout_milliseconds := 5000)`);
    const fast = [1, 2, 3].map(() => A(`select net.http_get(url := 'https://qbwrlynzvjmphwuqglsx.supabase.co/rest/v1/', timeout_milliseconds := 5000)`));
    const lat = {};
    for (let i = 0; i < 60 && Object.keys(lat).length < fast.length; i++) {
      await sleep(250);
      for (const id of fast) if (!(id in lat) && A(`select count(*) from net._http_response where id = ${id}`) === '1') lat[id] = Date.now() - t0;
    }
    const slowDone = A(`select count(*) from net._http_response where id = ${slow}`) === '1';
    const worst = Math.max(...fast.map((id) => lat[id] ?? Infinity));
    cell('Q9', '앞 요청이 5초 걸릴 때 뒤 요청 처리 지연', '기록(5초 가까우면 한 묶음씩 처리 — #1092 20초 상한이 다른 호출을 붙잡는다)', Number.isFinite(worst) ? `${worst}ms` : '15초 안에 응답 없음', null, { fast_ms: lat, slow_done: slowDone });
  } else cell('Q9', 'pg_net 큐·처리 지연', '기록', 'pg_net 없음(로컬)', null);
}

if (want('q10')) {
  // 옛 신고 고유 색인(message_id, reporter, open): 백필 뒤 identity = 최댓값+1이라 새 v2 글 id가 옛 글 id와 겹치지 않는다
  const o = await person(1);
  const room = big();
  const maxOld = Number(A('select max(id) from public.msgr_messages'));
  const m = await o.insert('msgr2_messages', { room_id: room, author_kind: 'user', author_user_id: o.uid, body: '신고 시험' });
  const newId = Number(m.data?.id);
  cell('Q10', '새 v2 글 id > 옛 글 최댓값', `> ${maxOld}`, m.error?.message ?? newId, !m.error && newId > maxOld && A(`select count(*) from public.msgr_messages where id = ${newId}`) === '0');
  const rep = A(`select m.member_id from public.msgr2_room_members m where m.room_id = '${room}' and m.member_kind = 'user' and m.member_id <> '${o.uid}' and m.removed_at is null order by m.member_id limit 1`);
  const r = await person(nOf(rep));
  const oldMsg = A(`select id from public.msgr_messages where channel_id = '${room}' and author_kind = 'user' and author_user_id <> '${rep}' and deleted_at is null order by id limit 1`);
  const a1 = await r.rpc('msgr2_report_message', { p_message: newId, p_reason: 'qbwr Q10' });
  const a2 = await r.rpc('msgr2_report_message', { p_message: Number(oldMsg), p_reason: 'qbwr Q10' });
  cell('Q10', '새 글·옛 글 신고 둘 다 들어감(색인 충돌 없음)', '서로 다른 신고 2건', `${a1.error?.message ?? 'ok'} / ${a2.error?.message ?? 'ok'}`, !a1.error && !a2.error && a1.data !== a2.data);
}

if (want('q11')) {
  // 작업 창 표지(#1087): 창 동안 계정 삭제 거부, 닫은 뒤 정상 — 친구만 있는 합성 계정 p059를 실제로 지운다(마지막).
  // 창은 운영 전 계정의 계정 삭제·옛 표 수정을 막으므로, 로그인·기기 등록을 창을 열기 전에 끝내고 창 열기부터 되살리기까지 try/finally로 묶는다(#1100 검수).
  // p059가 이미 없으면(이전 실행에서 지움) 창을 건드리지 않고 건너뛴다.
  if (A(`select count(*) from auth.users where email = 'p059@example.test'`) !== '1') {
    cell('Q11', '작업 창 계정 삭제 시험', 'p059@example.test 있음', '건너뜀(이미 실행됨 — p059 없음)', null);
  } else {
    const p = await person(59);
    const prev = A(`select coalesce((select value from public.msgr_settings where key = 'msgr2_migration_window'), '')`);
    try {
      A(`insert into public.msgr_settings (key, value) values ('msgr2_migration_window', now()::text) on conflict (key) do update set value = excluded.value`);
      if (process.env.QBWR_FAULT === 'q11-after-open') throw new Error('주입한 실패(시험용 — 창이 되살아나는지 본다)');
      const d1 = await p.rpc('msgr_delete_me');
      cell('Q11', '창 동안 계정 삭제 거부', '오류', d1.error?.message ?? JSON.stringify(d1.data), !!d1.error);
      A(`delete from public.msgr_settings where key = 'msgr2_migration_window'`);
      const d2 = await p.rpc('msgr_delete_me');
      const gone = A(`select count(*) from auth.users where email = 'p059@example.test'`) === '0';
      cell('Q11', '창을 닫은 뒤 계정 삭제 정상(p059 실제로 없어짐)', '성공·계정 0', `${d2.error?.message ?? 'ok'}·계정 ${gone ? 0 : 1}`, !d2.error && gone);
    } finally {
      // 원래 값으로 되살린다: 열려 있었으면 그 값, 아니었으면 지운다
      if (prev) A(`insert into public.msgr_settings (key, value) values ('msgr2_migration_window', '${prev.replace(/'/g, "''")}') on conflict (key) do update set value = excluded.value`);
      else A(`delete from public.msgr_settings where key = 'msgr2_migration_window'`);
    }
  }
}

// 끝날 때 작업 창 상태(열려 있으면 운영 전 계정의 계정 삭제·옛 표 수정이 막힌다 — 런북 6단계에서 닫는다)
{
  const w = A(`select coalesce((select value from public.msgr_settings where key = 'msgr2_migration_window'), '')`);
  cell('끝', '작업 창 표지 상태', '기록(열림이면 런북 6단계로 닫기)', w ? `열림(${w})` : '닫힘', null);
}

const fail = results.filter((r) => r.pass === false);
console.log(`# ${C.mode} 칸 ${results.length}, 통과 ${results.filter((r) => r.pass).length}, 실패 ${fail.length}, 기록 ${results.filter((r) => r.pass === null).length}`);
process.exit(fail.length ? 1 : 0);
