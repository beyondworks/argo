// qbwr 실전 시험 Q1·Q2·Q3·Q5 — 합성 계정으로 실 GoTrue 로그인 → 기기 등록 → Realtime 구독 판정 → 첨부 서명(볼트 2026-10-18-msgr2-u9-qbwr-plan 4절).
// scripts/qbwr-q.sh가 부른다(접속·키는 환경 변수로만: C·QBWR_URL·QBWR_ANON_KEY·QBWR_SEED_PASSWORD, 값은 출력하지 않는다).
// 결과는 칸마다 { 칸, 기대, 실제, 통과 } JSON 한 줄. 경로·토큰·세션 id는 남기지 않고 해시 앞 8자만 남긴다.
import { createHash } from 'node:crypto';
import { userEnv } from './qbwr-lib.mjs';

const { sql, client, email, login, loginUid, reg } = userEnv(); // 검문한 접속·qbwr anon 키가 아니면 exit 5
const which = process.argv.slice(2);
const h8 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const results = [];
const cell = (q, name, expect, actual, pass) => { const r = { q, name, expect, actual, pass: !!pass }; results.push(r); console.log(JSON.stringify(r)); };
const RUNNER = { p_kind: 'runner', p_app: 'desktop', p_app_version: '0.1.113', p_link_min: 1, p_link_max: 1, p_runners: ['claude'] };
// Realtime private 채널 구독 판정: SUBSCRIBED면 허용, CHANNEL_ERROR·TIMED_OUT이면 거부
function listen(c, topic, { ms = 10_000, onEvent } = {}) {
  return new Promise((res) => {
    const ch = c.channel(topic, { config: { private: true } });
    if (onEvent) ch.on('broadcast', { event: '*' }, (m) => onEvent(m));
    const t = setTimeout(() => res({ status: 'TIMEOUT', ch }), ms);
    ch.subscribe((st, err) => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(st)) { clearTimeout(t); res({ status: st, err: err?.message ?? null, ch }); } });
  });
}
const drop = async (c, ch) => { try { await c.removeChannel(ch); } catch { /* 닫기 실패 무시 */ } };

async function q1() {
  const a = await login(1);
  cell('Q1', 'JWT에 session_id', 'uuid', a.sid ? 'uuid' : 'null', !!a.sid);
  const d = await reg(a);
  cell('Q1', '앱 기기 등록', '기기 id', d.id ? '기기 id' : d.err, !!d.id);
  if (d.id) cell('Q1', '기기 행 session_id = 로그인 세션', 'true', sql(`select (session_id = '${a.sid}')::text from public.msgr2_devices where id = '${d.id}'`), sql(`select (session_id = '${a.sid}')::text from public.msgr2_devices where id = '${d.id}'`) === 'true');
  // 10분 창 밖 세션: 합성 계정의 세션 시각만 11분 전으로 돌린다(qbwr 한정)
  const b = await login(2);
  sql(`update auth.sessions set created_at = now() - interval '11 minutes' where id = '${b.sid}'`);
  const old = await reg(b);
  cell('Q1', '10분 창 밖 세션 등록 거부', 'device_login_required', old.err ?? '등록됨', /device_login_required/.test(old.err ?? ''));
}

async function q2() {
  const a1 = await login(3), a2 = await login(3);
  const d1 = await reg(a1), d2 = await reg(a2);
  cell('Q2', '같은 계정 두 번째 기기', '서로 다른 기기 2개', d1.id && d2.id && d1.id !== d2.id ? '2개' : `${d1.err ?? ''} ${d2.err ?? ''}`, d1.id && d2.id && d1.id !== d2.id);
  const got = [];
  const sub = await listen(a1.c, `v2:u:${a1.uid}`, { onEvent: (m) => got.push(m.event) });
  cell('Q2', '내 v2:u 구독', 'SUBSCRIBED', sub.status, sub.status === 'SUBSCRIBED');
  const rv = await a2.c.rpc('msgr2_device_revoke', { p_device: d1.id });
  cell('Q2', '다른 기기에서 폐기', 'true', JSON.stringify(rv.data ?? rv.error?.message), rv.data === true);
  for (let i = 0; i < 50 && !got.includes('device_revoked'); i++) await new Promise((r) => setTimeout(r, 200));
  cell('Q2', "폐기된 기기가 v2:u 'device_revoked' 받음", 'device_revoked', got.join(',') || '없음', got.includes('device_revoked'));
  await drop(a1.c, sub.ch);
  const after = await a1.c.rpc('msgr2_devices_list');
  cell('Q2', '폐기 즉시 RPC 거부', '오류', after.error ? after.error.message : '허용됨', !!after.error);
  const rereg = await reg(a1);
  cell('Q2', '폐기된 세션 다시 등록 거부', 'device_revoked', rereg.err ?? '등록됨', /device_revoked/.test(rereg.err ?? ''));
  await a2.c.auth.signOut();
  const lo = await reg(a2);
  cell('Q2', '로그아웃한 세션 등록 거부', '오류', lo.err ?? '등록됨', !!lo.err);
  return { revoked: a1 };
}

async function q3(revoked) {
  const owner = await login(1); await reg(owner); // 조직1 주인(앱 기기, Q1과 같은 계정이면 기존 기기를 다시 씀 — 새 세션이라 새 기기)
  const space = sql(`select id from public.msgr2_spaces where slug = 'qbwr-org-1'`);
  const other = sql(`select id from public.msgr2_spaces where slug = 'qbwr-org-2' and not exists (select 1 from public.msgr2_space_members m where m.space_id = msgr2_spaces.id and m.user_id = '${owner.uid}' and m.removed_at is null)`) || null;
  const stranger = sql(`select id from auth.users where email = '${email(60)}'`);
  const cases = [
    ['내 v2:u', owner.c, `v2:u:${owner.uid}`, true],
    ['남의 v2:u', owner.c, `v2:u:${stranger}`, false],
    ['내 팀 v2:s', owner.c, `v2:s:${space}`, true],
    ...(other ? [['남의 팀 v2:s', owner.c, `v2:s:${other}`, false]] : []),
    ['앱 기기의 v2:w', owner.c, `v2:w:${owner.uid}`, false],
  ];
  const runner = await login(1); const rd = await reg(runner, RUNNER);
  cell('Q3', 'runner 기기 등록', '기기 id', rd.id ? '기기 id' : rd.err, !!rd.id);
  cases.push(['runner 기기의 v2:w', runner.c, `v2:w:${runner.uid}`, true]);
  const anon = client();
  cases.push(['anon의 v2:u', anon, `v2:u:${owner.uid}`, false]);
  if (revoked) cases.push(['폐기된 기기의 v2:u', revoked.c, `v2:u:${revoked.uid}`, false]);
  for (const [name, c, topic, allow] of cases) {
    const r = await listen(c, topic);
    cell('Q3', name, allow ? 'SUBSCRIBED' : '거부', r.status, allow ? r.status === 'SUBSCRIBED' : r.status !== 'SUBSCRIBED');
    await drop(c, r.ch);
  }
  if (space) cell('Q3', '토픽 확인용 공간 id', '있음', space ? `h:${h8(space)}` : '없음', !!space);
}

async function q5() {
  // 방 멤버 사람(앱 기기)이 조직·개인 첨부 서명을 받는다. 방 밖 사람은 거부(경로는 해시로만 남긴다)
  const rows = (k) => sql(`select a.storage_path || '|' || m.member_id from public.msgr2_attachments a
     join public.msgr2_room_members m on m.room_id = a.room_id and m.member_kind = 'user' and m.removed_at is null
     where a.storage_path ${k === 'org' ? "not like 'msgr/p/%'" : "like 'msgr/p/%'"} and a.storage_path like 'msgr/%' order by a.storage_path limit 10`).split('\n').filter(Boolean);
  const sess = new Map();
  const asUser = async (uid) => {
    if (!sess.has(uid)) { const s = await loginUid(uid); await reg(s); sess.set(uid, s); }
    return sess.get(uid);
  };
  for (const kind of ['org', 'personal']) for (const row of rows(kind)) {
    const [full, uid] = row.split('|'); const path = full.replace(/^msgr\//, '');
    const s = await asUser(uid);
    const { data, error } = await s.c.storage.from('msgr').createSignedUrl(path, 60);
    let code = error ? `오류 ${error.message}` : (await fetch(data.signedUrl)).status;
    cell('Q5', `${kind === 'org' ? '조직' : '개인'} 첨부 서명 h:${h8(path)}`, 200, code, code === 200);
  }
  // 방 밖: 친구만 있는 사람(60번)이 조직 첨부 2개를 요청
  const outsider = await login(60); await reg(outsider);
  for (const row of rows('org').slice(0, 2)) {
    const path = row.split('|')[0].replace(/^msgr\//, '');
    const { data, error } = await outsider.c.storage.from('msgr').createSignedUrl(path, 60);
    const code = error ? '거부' : (await fetch(data.signedUrl)).status;
    cell('Q5', `방 밖 서명 거부 h:${h8(path)}`, '거부', code, code === '거부' || (typeof code === 'number' && code >= 400));
  }
}

let revoked = null;
if (!which.length || which.includes('q1')) await q1();
if (!which.length || which.includes('q2')) revoked = (await q2()).revoked;
if (!which.length || which.includes('q3')) await q3(revoked);
if (which.includes('q5')) await q5();
const fail = results.filter((r) => !r.pass);
console.log(`# 칸 ${results.length}, 통과 ${results.length - fail.length}, 실패 ${fail.length}`);
process.exit(fail.length ? 1 : 0);
