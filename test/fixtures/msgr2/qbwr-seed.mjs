// 메신저 v2 U9 qbwr 실전 시험용 합성 옛 메신저 데이터 — 볼트 2026-10-18-msgr2-u9-qbwr-plan 3절 모양을 SQL로 낸다(운영 데이터를 쓰지 않는다, 설계 6절).
// 사용: node test/fixtures/msgr2/qbwr-seed.mjs [--scale 1] [--manifest 첨부목록.json] > seed.sql
//       psql은 scripts/qbwr-seed.sh가 부른다(비밀번호는 표준 입력의 set argo.seed_pw로만 넣고 파일·인자에 남기지 않는다).
// 계정은 전부 p001@example.test 식 합성 계정이다 — 유건님 체험 계정(qbwr에 따로 가입)은 만들지도 건드리지도 않는다.
// id는 고정 접두(c9…)라 다시 만들어도 같고, 지울 때 접두로 고를 수 있다. 같은 씨앗이면 같은 SQL이 나온다.
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCALE = Number(arg('--scale', '1'));
const MANIFEST = arg('--manifest', null);
let seed = 0x9a7e1;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pickN = (arr, n) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
const sc = (n) => Math.max(1, Math.round(n * SCALE));

// 고정 접두 id: c9 + 종류 두 자리 + 일련번호
const uid = (kind, n) => `c9${kind}0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const K = { user: '01', org: '02', agent: '03', crew: '04', chan: '05', att: '06', appr: '07', ident: '08' };
const q = (s) => (s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const arr = (xs) => `'{${xs.join(',')}}'`;
const ago = (d) => `now() - interval '${d} days'`;
const out = [];
const sql = (s) => out.push(s);

// ── 사람 60 ────────────────────────────────────────────────
const NU = 60;
const users = Array.from({ length: NU }, (_, i) => uid(K.user, i + 1));
const email = (i) => `p${String(i + 1).padStart(3, '0')}@example.test`;
sql(`-- qbwr 합성 데이터(scale ${SCALE}). 옛 트리거(서버 시각·좌석·봇·푸시·중단 스위치)는 끄고 넣는다 — 운영의 "이미 쌓인 데이터" 모양
set session_replication_role = replica;
set statement_timeout = 0;`);
// GoTrue로 로그인할 수 있는 계정(Q1~Q3): 토큰 열을 빈 문자열로 둬야 GoTrue가 읽는다. 비밀번호는 argo.seed_pw(세션 설정)에서만 온다
sql(`insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change) values
${users.map((u, i) => `  ('00000000-0000-0000-0000-000000000000', '${u}', 'authenticated', 'authenticated', '${email(i)}', crypt(current_setting('argo.seed_pw'), gen_salt('bf')), ${ago(60)},
   '{"provider":"email","providers":["email"]}', '{"name":"사람${String(i + 1).padStart(3, '0')}"}', ${ago(60)}, ${ago(60)}, '', '', '', '')`).join(',\n')}
on conflict (id) do nothing;`);
sql(`insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at) values
${users.map((u, i) => `  ('${uid(K.ident, i + 1)}', '${u}', '${u}', 'email', '{"sub":"${u}","email":"${email(i)}","email_verified":true}', ${ago(60)}, ${ago(60)}, ${ago(60)})`).join(',\n')}
on conflict do nothing;`);
sql(`insert into public.msgr_profiles (user_id, display_name) values ${users.map((u, i) => `('${u}', '사람${String(i + 1).padStart(3, '0')}')`).join(', ')} on conflict do nothing;`);

// 친구만 있는 사람(51~60)과 조직 사람 사이의 친구 20쌍
const friendPairs = [];
for (let i = 0; friendPairs.length < 20; i++) {
  const a = users[50 + (i % 10)], b = users[i % 50];
  const [x, y] = a < b ? [a, b] : [b, a];
  if (!friendPairs.some((p) => p[0] === x && p[1] === y)) friendPairs.push([x, y]);
}
sql(`insert into public.msgr_friends (a, b, status, requested_by) values ${friendPairs.map(([a, b]) => `('${a}', '${b}', 'accepted', '${a}')`).join(', ')} on conflict do nothing;`);

// ── 조직 6(6번은 지운 조직) ─────────────────────────────────
const ORG_SIZES = [40, 20, 10, 5, 3, 2];
const orgs = ORG_SIZES.map((size, i) => ({ id: uid(K.org, i + 1), owner: users[i], size, deleted: i === 5 }));
sql(`insert into public.msgr_orgs (id, name, slug, owner_user_id, created_at, deleted_at) values
${orgs.map((o, i) => `  ('${o.id}', '조직${i + 1}', 'qbwr-org-${i + 1}', '${o.owner}', ${ago(50)}, ${o.deleted ? ago(2) : 'null'})`).join(',\n')}
on conflict do nothing;`);
const memRows = [];
for (const o of orgs) {
  // 1~50번 사람에서 고른다(51~60은 친구만 있는 사람). 주인은 항상 포함
  const pool = users.slice(0, 50).filter((u) => u !== o.owner);
  o.members = [o.owner, ...pickN(pool, o.size - 1)];
  o.active = [];
  o.members.forEach((u, j) => {
    let role = j === 0 ? 'owner' : j === 1 ? 'admin' : 'member', removed = 'null', expires = 'null';
    if (j > 1 && j % 9 === 0) role = 'guest', expires = `now() + interval '5 days'`; // 손님
    if (j > 1 && j % 13 === 0) removed = ago(3); // 탈퇴자
    if (j > 1 && j % 17 === 0) expires = ago(1); // 만료 멤버
    if (removed === 'null' && !(j % 17 === 0 && j > 1)) o.active.push(u);
    memRows.push(`('${o.id}', '${u}', '${role}', ${j < 3 ? q(`멤버${j}`) : 'null'}, ${ago(45)}, ${removed}, ${expires})`);
  });
}
sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name, joined_at, removed_at, expires_at) values\n  ${memRows.join(',\n  ')}\non conflict do nothing;`);

// ── 에이전트 120 + 자리(개인·조직, bot 일부, 자리 0개 2) ────────────
const NA = 120;
const agents = Array.from({ length: NA }, (_, i) => ({ id: uid(K.agent, i + 1), owner: users[(i * 7) % 50], ws: `w${(i * 7) % 50}`, slug: `a${i + 1}` }));
sql(`insert into public.msgr_agents (id, owner_user_id, ws_id, slug, created_at) values
${agents.map((a) => `  ('${a.id}', '${a.owner}', '${a.ws}', '${a.slug}', ${ago(40)})`).join(',\n')}
on conflict do nothing;`);
const crews = [];
agents.forEach((a, i) => {
  if (i >= NA - 2) return; // 자리가 하나도 없는 에이전트 2
  crews.push({ id: uid(K.crew, crews.length + 1), org: null, agent: a, hosting: 'local', status: 'active', allow: 'owner' });
  for (const o of orgs) if (o.active.includes(a.owner) && (i + orgs.indexOf(o)) % 3 === 0) {
    const bot = i % 11 === 0;
    crews.push({ id: uid(K.crew, crews.length + 1), org: o, agent: a, hosting: bot ? 'bot' : 'local', status: bot ? 'paused' : 'active', allow: i % 2 ? 'all' : 'list' });
  }
});
sql(`insert into public.msgr_crews (id, org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow, allow_users, registered_at, created_at, agent_id) values
${crews.map((c, i) => `  ('${c.id}', ${c.org ? `'${c.org.id}'` : 'null'}, '${c.agent.owner}', '${c.agent.ws}', '${c.agent.slug}', '에이전트${i + 1}', '조사', '${c.hosting}', '${c.status}', '${c.allow}', '{}', ${ago(1)}, ${ago(40)}, '${c.agent.id}')`).join(',\n')}
on conflict do nothing;`);

// ── 채널 300 ───────────────────────────────────────────────
const chans = [];
const addChan = (c) => { c.id = uid(K.chan, chans.length + 1); chans.push(c); return c; };
const liveOrgs = orgs.filter((o) => !o.deleted);
const orgCrews = (o) => crews.filter((c) => c.org === o && c.status === 'active');
for (let i = 0; i < 120; i++) { // public 120(제외 목록 5)
  const o = orgs[i % 6];
  const members = pickN(o.active, Math.max(1, Math.round(o.active.length * 0.6)));
  const ex = i < 5 ? [o.active[o.active.length - 1]] : [];
  addChan({ org: o, kind: 'public', name: `공개${i + 1}`, members, crewsIn: pickN(orgCrews(o), 2), excluded: ex, archived: false });
}
for (let i = 0; i < 60; i++) { const o = liveOrgs[i % 5]; addChan({ org: o, kind: 'private', name: `비공개${i + 1}`, members: pickN(o.active, Math.min(o.active.length, 2 + (i % 5))), crewsIn: [], archived: i % 12 === 0 }); }
for (let i = 0; i < 30; i++) { const o = liveOrgs[i % 5]; addChan({ org: o, kind: 'dm', name: 'dm', members: pickN(o.active, 2), crewsIn: [], archived: false }); } // 사람 둘
for (let i = 0; i < 20; i++) { // 사람 + 조직 에이전트
  const o = liveOrgs[i % 5]; const cr = orgCrews(o)[i % Math.max(1, orgCrews(o).length)];
  if (!cr) continue;
  addChan({ org: o, kind: 'dm', name: 'dm', members: [cr.agent.owner], crewsIn: [cr], archived: false, agentDm: true });
}
for (let i = 0; i < 10; i++) { const o = liveOrgs[i % 5]; addChan({ org: o, kind: 'dm', name: 'group', members: pickN(o.active, Math.min(o.active.length, 3)), crewsIn: [], archived: false }); }
friendPairs.forEach(([a, b]) => addChan({ org: null, kind: 'dm', name: 'dm', members: [a, b], crewsIn: [], pair: `${a}:${b}`, archived: false }));
for (let i = 0; chans.length < 290 && i < 40; i++) { // 개인 에이전트 1:1
  const cr = crews.filter((c) => !c.org)[i]; addChan({ org: null, kind: 'dm', name: 'dm', members: [cr.agent.owner], crewsIn: [cr], pair: `crew:${cr.id}`, archived: false, readOnly: true });
}
while (chans.length < 300) addChan({ org: orgs[5], kind: 'public', name: `지운조직${chans.length}`, members: orgs[5].members.slice(0, 2), crewsIn: [], archived: false }); // 지운 조직의 방
sql(`insert into public.msgr_channels (id, org_id, kind, name, crew_memory, created_by, created_at, archived_at, personal_crews, excluded_user_ids, excluded_crew_ids, personal_pair) values
${chans.map((c) => `  ('${c.id}', ${c.org ? `'${c.org.id}'` : 'null'}, '${c.kind}', ${q(c.name)}, ${c.kind !== 'private'}, '${c.members[0]}', ${ago(35)}, ${c.archived ? ago(3) : 'null'}, '${c.readOnly ? 'read_only' : 'allowed'}', ${arr(c.excluded ?? [])}, '{}', ${q(c.pair ?? null)})`).join(',\n')}
on conflict do nothing;`);
const cm = [];
for (const c of chans) {
  for (const u of c.members) cm.push(`('${c.id}', 'user', '${u}', ${c.kind === 'dm' ? 'null' : `'${c.members[0]}'`}, ${ago(35)})`);
  for (const cr of c.crewsIn) cm.push(`('${c.id}', 'crew', '${cr.id}', null, ${ago(35)})`);
}
sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by, added_at) values\n  ${cm.join(',\n  ')}\non conflict do nothing;`);

// ── 글 200,000(큰 방 하나에 100,000) — 서버에서 generate_series로 만든다(SQL 파일을 작게) ──
const TOTAL = sc(200000), BIG = sc(100000);
const big = chans[0]; // 조직1 공개1
const rest = chans.slice(1);
const per = Math.floor((TOTAL - BIG) / rest.length);
let next = 1;
const msgRange = new Map(); // 방 id → [첫 id, 끝 id]
const authorsOf = (c) => (c.members.length ? c.members : [users[0]]);
const emitBulk = (c, n) => {
  const a = authorsOf(c), lo = next, hi = next + n - 1;
  msgRange.set(c.id, [lo, hi]);
  // client_msg_id: 큰 방에서 997번째마다 앞 글과 같은 값(겹침), 나머지는 null
  sql(`insert into public.msgr_messages (id, org_id, channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id, created_at, meta) overriding system value
  select g, ${c.org ? `'${c.org.id}'` : 'null'}::uuid, '${c.id}', 'user', (${arr(a)}::uuid[])[1 + (g % ${a.length})], 'text', '합성 글 ' || g, '[]',
    ${c === big ? `case when g % 997 = 0 then 'dup-' || (g - 1) when g % 997 = 996 then 'dup-' || g end` : 'null'}, now() - interval '30 days' + (g - ${lo}) * interval '1 second', '{}'
  from generate_series(${lo}, ${hi}) g;`);
  next = hi + 1;
};
emitBulk(big, BIG);
for (const c of rest) emitBulk(c, per);
// 갈래별 글(큰 방): 멘션·답글·스레드·수정·지운 글·지운 작성자·에이전트 글·결재 카드·시스템
const special = [];
const bigCrew = big.crewsIn[0];
for (let i = 0; i < 200; i++) {
  const id = next++, kind = i % 8;
  const author = big.members[i % big.members.length];
  const base = { id, author, crew: null, ak: 'user', mk: 'text', body: `갈래 글 ${i}`, mentions: '[]', reply: 'null', root: 'null', edited: 'null', deleted: 'null', meta: '{}' };
  if (kind === 0) base.mentions = `[{"kind":"user","id":"${big.members[(i + 1) % big.members.length]}"}${bigCrew ? `,{"kind":"crew","id":"${bigCrew.id}","role":"to"}` : ''}]`;
  if (kind === 1) base.reply = String(id - 1);
  if (kind === 2) base.root = '1';
  if (kind === 3) base.edited = ago(1);
  if (kind === 4) base.deleted = ago(1);
  if (kind === 5) base.author = null; // 작성자가 지워진 사람 글
  if (kind === 6 && bigCrew) Object.assign(base, { ak: 'crew', author: null, crew: bigCrew.id, body: '에이전트 답' });
  if (kind === 7) Object.assign(base, { ak: 'system', author: null, mk: 'system', meta: '{"code":"x"}' });
  special.push(base);
}
sql(`insert into public.msgr_messages (id, org_id, channel_id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, thread_root, created_at, edited_at, deleted_at, meta) overriding system value values
${special.map((m) => `  (${m.id}, '${big.org.id}', '${big.id}', '${m.ak}', ${q(m.author)}, ${q(m.crew)}, '${m.mk}', ${q(m.body)}, '${m.mentions}', ${m.reply}, ${m.root}, ${ago(5)}, ${m.edited}, ${m.deleted}, '${m.meta}')`).join(',\n')};`);
// 결재 대기 30·결정 100 — 조직 에이전트 1:1 방에 카드 글을 하나씩
const apprChans = chans.filter((c) => c.agentDm);
const approvals = [];
for (let i = 0; i < sc(130) && apprChans.length; i++) {
  const c = apprChans[i % apprChans.length], cr = c.crewsIn[0];
  const card = next++;
  sql(`insert into public.msgr_messages (id, org_id, channel_id, author_kind, crew_id, kind, body, mentions, created_at, meta) overriding system value values (${card}, '${c.org.id}', '${c.id}', 'crew', '${cr.id}', 'approval_card', '승인 요청 ${i}', '[]', ${ago(4)}, '{"approval":"q${i}"}');`);
  approvals.push(`('${uid(K.appr, i + 1)}', '${c.org.id}', '${c.id}', '${cr.id}', 'q${i}', 'rm -rf build', '빌드 폴더 정리', '${i < 30 ? 'pending' : i % 2 ? 'approved' : 'rejected'}', ${card}, null, ${ago(4)}, '${i % 3 ? 'low' : 'high'}', 'action')`);
}
if (approvals.length) sql(`insert into public.msgr_crew_approvals (id, org_id, channel_id, crew_id, approval_id, action, reason, status, message_id, source_msg_id, created_at, risk, kind) values\n  ${approvals.join(',\n  ')}\non conflict do nothing;`);
sql(`select setval(pg_get_serial_sequence('public.msgr_messages', 'id'), (select max(id) from public.msgr_messages));`);

// ── 첨부 1,000(Storage에 실제로 올릴 목록은 --manifest로) ───────────
const atts = [];
const attChans = chans.filter((c) => msgRange.has(c.id) && (c.org ? !c.org.deleted : true));
for (let i = 0; i < sc(1000); i++) {
  const c = attChans[i % attChans.length], [lo, hi] = msgRange.get(c.id);
  const mid = lo + Math.floor(rnd() * (hi - lo + 1));
  const name = `f${i + 1}.txt`, bytes = 1024 + Math.floor(rnd() * 49 * 1024);
  const path = c.org ? `${c.org.id}/${c.id}/${name}` : `p/${c.id}/${name}`;
  atts.push({ id: uid(K.att, i + 1), mid, org: c.org?.id ?? null, path, name, bytes });
}
sql(`insert into public.msgr_attachments (id, message_id, org_id, storage_path, name, mime, bytes, created_at) values
${atts.map((a) => `  ('${a.id}', ${a.mid}, ${q(a.org)}, '${a.path}', '${a.name}', 'text/plain', ${a.bytes}, ${ago(3)})`).join(',\n')}
on conflict do nothing;`);
if (MANIFEST) writeFileSync(MANIFEST, JSON.stringify(atts.map(({ path, bytes }) => ({ bucket: 'msgr', path, bytes }))));

// ── 읽음·반응·설정·고정 각 2,000 내외 ──────────────────────────
const reads = new Map(), reacts = new Set(), prefs = new Map();
const EMO = ['👍', '❤️', 'a,b', '🎉', '😂'];
for (let i = 0; reads.size < sc(2000) && i < sc(20000); i++) {
  const c = chans[i % chans.length]; if (!msgRange.has(c.id)) continue;
  const u = c.members[Math.floor(rnd() * c.members.length)]; const [lo, hi] = msgRange.get(c.id);
  reads.set(`${c.id}|${u}`, `('${c.id}', '${u}', ${lo + Math.floor(rnd() * (hi - lo + 1))}, ${ago(1)})`);
  if (prefs.size < sc(2000)) prefs.set(`${c.id}|${u}`, `('${c.id}', '${u}', ${i % 4 === 0}, ${i % 7 === 0}, ${ago(1)})`);
}
for (let i = 0; reacts.size < sc(2000) && i < sc(20000); i++) {
  const c = chans[i % chans.length]; if (!msgRange.has(c.id)) continue;
  const u = c.members[Math.floor(rnd() * c.members.length)]; const [lo, hi] = msgRange.get(c.id);
  reacts.add(`(${lo + Math.floor(rnd() * (hi - lo + 1))}, '${u}', '${EMO[i % EMO.length]}', ${ago(1)})`);
}
sql(`insert into public.msgr_reads (channel_id, user_id, last_read_id, updated_at) values\n  ${[...reads.values()].join(',\n  ')}\non conflict do nothing;`);
sql(`insert into public.msgr_reactions (message_id, user_id, emoji, created_at) values\n  ${[...reacts].join(',\n  ')}\non conflict do nothing;`);
sql(`insert into public.msgr_channel_prefs (channel_id, user_id, muted, pinned, updated_at) values\n  ${[...prefs.values()].join(',\n  ')}\non conflict do nothing;`);
const tp = [];
for (const o of liveOrgs) for (const u of o.active.slice(0, 10)) {
  const other = o.active.find((x) => x !== u); if (other) tp.push(`('${u}', '${o.id}', 'user', '${other}', true)`);
  const cr = orgCrews(o)[0]; if (cr) tp.push(`('${u}', '${o.id}', 'crew', '${cr.id}', true)`);
}
sql(`insert into public.msgr_target_prefs (user_id, org_id, target_kind, target_id, pinned) values\n  ${tp.join(',\n  ')}\non conflict do nothing;`);
sql(`set session_replication_role = origin;
-- 요약(넣은 뒤 확인용)
select 'users', count(*) from auth.users where email like '%@example.test'
union all select 'orgs', count(*) from public.msgr_orgs where slug like 'qbwr-org-%'
union all select 'agents', count(*) from public.msgr_agents where id::text like 'c903%'
union all select 'crews', count(*) from public.msgr_crews where id::text like 'c904%'
union all select 'channels', count(*) from public.msgr_channels where id::text like 'c905%'
union all select 'messages', count(*) from public.msgr_messages m where m.channel_id::text like 'c905%'
union all select 'attachments', count(*) from public.msgr_attachments where id::text like 'c906%'
union all select 'approvals', count(*) from public.msgr_crew_approvals where id::text like 'c907%';`);
process.stdout.write(out.join('\n\n') + '\n');
