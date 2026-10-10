// 결제 먼저, 가입 나중(2026-10-10 실사고) — 실제 Postgres 드릴.
// 운영 수신자(supabase/functions/ls-webhook/index.ts)를 node vm에서 그대로 실행해 결제 이벤트를 넣고(test/helpers/ls-pg-sb.mjs),
// 마이그레이션 20261010150000의 record_ls_unmatched·ls_link_late_signups를 실제로 부른다.
// 사고: 결제 시각에 같은 이메일 계정이 없어 billing_unmatched(no-user)에 남았고, 6시간 뒤 같은 이메일로 가입·인증했지만 다시 보는
// 장치가 없어 계속 Free였다. 이 파일은 "나중에 생긴 계정이 크론 한 번으로 Pro가 되고, 연결하면 안 되는 경우는 그대로"를 잠근다.
// ARGO_PG_TEST_URL 미설정이면 전부 skip — 실행: bash scripts/billing-pg-drill.sh test/billing-late-signup-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { psqlSpawn } from './helpers/pg.mjs';
import { prepareBillingSchema, pgSb } from './helpers/ls-pg-sb.mjs';
import { loadLsWebhook } from './helpers/ls-webhook-edge.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh로 실행';

function psql(args) {
  const r = psqlSpawn(DB, args);
  if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();

before(() => { if (DB) prepareBillingSchema(DB); });

// 계정 id는 이 파일 상수 — 실제 계정·구독 번호를 쓰지 않는다. 구독 번호는 'LL-'로 시작.
let seq = 0;
const newId = () => `d2000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
function signUp(email, { verified = true } = {}) {
  const id = newId();
  sql(`insert into auth.users (id, email, email_confirmed_at) values ('${id}', '${email}', ${verified ? 'now()' : 'null'})`);
  return id;
}
const pay = (overrides = {}, env = {}) => {
  const { name = 'subscription_created', sub, email, status = 'active', updatedAt = '2026-10-09T21:00:17Z', endsAt = null, testMode = false, userId } = overrides;
  const payload = {
    meta: { event_name: name, ...(userId ? { custom_data: { user_id: userId } } : {}) },
    data: { id: sub, attributes: { status, customer_id: 8001, user_email: email, updated_at: updatedAt, ends_at: endsAt,
      test_mode: testMode, urls: { customer_portal: `https://argo.lemonsqueezy.example/billing/${sub}` } } },
  };
  return loadLsWebhook({ sb: pgSb(DB), env }).post(payload);
};
const link = () => Number(sql('select public.ls_link_late_signups()'));
const ent = (uid) => sql(`select coalesce((select plan || '|' || ls_subscription_id || '|' || ls_status from public.entitlements where user_id = '${uid}'), 'none')`);
const isPro = (uid) => sql(`select public.is_pro_for('${uid}')`);
const rec = (sub) => sql(`select coalesce((select reason || '|' || coalesce(plan, '-') || '|' || coalesce(ls_status, '-') || '|' ||
  coalesce(to_char(ls_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), '-') || '|' || (resolved_at is not null) || '|' || coalesce(linked_user_id::text, '-')
  from public.billing_unmatched where ls_subscription_id = '${sub}' and reason = 'no-user'), 'none')`);
// 행 버전 — xmin(마지막으로 쓴 트랜잭션)·xmax(잠금·삭제 표시). 둘 다 같으면 그 사이 쓰지도 잠그지도 않았다.
const versions = () => sql(`select coalesce(string_agg(t, ',' order by t), '') from (
  select 'u' || id || ':' || xmin || '/' || xmax as t from public.billing_unmatched
  union all select 'e' || user_id || ':' || xmin || '/' || xmax from public.entitlements) v`);
// 크론 한 번을 한 문장(= 한 트랜잭션)으로 돌리고, 그 트랜잭션이 트랜잭션 번호를 받았는지(= 무엇이든 썼는지·잠갔는지) 함께 본다.
// 하위 질의에 휘발 함수가 있어 펼쳐지지 않는다 — 함수가 먼저 돈 뒤 번호를 읽는다. (begin; …; commit;을 -c 하나로 보내면
// psql이 마지막 결과(COMMIT)만 돌려줘 값을 못 읽는다.)
const linkTx = () => {
  const out = sql(`select n || '|' || coalesce(txid_current_if_assigned()::text, 'none') from (select public.ls_link_late_signups() n) s`);
  const [n, txid] = out.split('|');
  if (txid === undefined) throw new Error(`판정 줄을 못 읽었다: ${out}`);
  return { n: Number(n), wrote: txid !== 'none' };
};

test('나중 가입: 결제 먼저(no-user 기록) → 같은 이메일로 가입·인증 → 크론 한 번에 Pro 연결·기록 해결, 두 번째 실행은 아무것도 쓰지 않는다', { skip }, async () => {
  const r = await pay({ sub: 'LL-LATE', email: 'Late.Payer@Example.test' });
  assert.deepEqual(r.json, { ok: true, unmatched: 'no-user' }, '결제 시각에는 계정이 없다');
  assert.equal(rec('LL-LATE'), 'no-user|pro|active|2026-10-09T21:00:17|false|-', '적용에 필요한 값이 기록에 남는다');
  const uid = signUp('late.payer@example.test'); // 6시간 뒤 가입(대소문자만 다름)
  assert.equal(isPro(uid), 'f', '가입 직후에는 아직 Free');
  assert.equal(link(), 1);
  assert.equal(ent(uid), 'pro|LL-LATE|active');
  assert.equal(isPro(uid), 't', '앱의 Pro 판정까지');
  assert.equal(sql(`select ls_updated_at = '2026-10-09T21:00:17Z' and ls_customer_id = '8001' and portal_url like '%/LL-LATE'
    from public.entitlements where user_id = '${uid}'`), 't', '기록에 남은 값 그대로 apply_ls_event');
  assert.equal(rec('LL-LATE'), `no-user|pro|active|2026-10-09T21:00:17|true|${uid}`, '해결 표시와 연결한 계정');
  const before = versions();
  const again = linkTx();
  assert.deepEqual(again, { n: 0, wrote: false }, '멱등 — 두 번째 실행은 쓰지 않는다');
  assert.equal(versions(), before);
  // 다음 이벤트는 웹훅이 구독 연결(②)로 그 계정에 바로 적용한다
  const next = await pay({ name: 'subscription_cancelled', sub: 'LL-LATE', email: 'late.payer@example.test', status: 'cancelled', updatedAt: '2026-10-20T00:00:00Z', endsAt: '2026-11-09T21:00:17Z' });
  assert.deepEqual(next.json, { ok: true, plan: 'pro', status: 'cancelled' });
  assert.equal(ent(uid), 'pro|LL-LATE|cancelled');
});

test('연결하지 않는 경우: 인증 안 된 계정·같은 이메일 계정 둘·그 계정이 다른 유효 구독·그 구독이 이미 다른 계정 — 크론은 쓰지도 잠그지도 않는다', { skip }, async () => {
  // ① 인증 안 된 계정 — 남의 결제 이메일로 만들어 두고 인증하지 않은 계정이 결제를 가져가지 못하게
  await pay({ sub: 'LL-UNV', email: 'unv@example.test' });
  const unv = signUp('unv@example.test', { verified: false });
  // ② 같은 이메일(대소문자만 다름)의 인증 계정 둘 — 누구 결제인지 정할 수 없다
  await pay({ sub: 'LL-TWIN', email: 'twin@example.test' });
  const twinA = signUp('Twin@example.test');
  const twinB = signUp('twin@example.test');
  // ③ 그 계정이 지금 다른 구독으로 유효한 Pro(해지 예약·기간 남음 포함)
  await pay({ sub: 'LL-HELD-NEW', email: 'held@example.test' });
  const held = signUp('held@example.test');
  sql(`select public.apply_ls_event('${held}'::uuid, 'pro', 'LL-HELD-OLD', '8001', 'cancelled', '2026-10-01T00:00:00Z', now() + interval '5 days', null)`);
  // ④ 그 구독이 이미 다른 계정에 연결(결제 이메일과 다른 계정에 운영자가 손으로 연결)
  await pay({ sub: 'LL-TAKEN', email: 'taken@example.test' });
  const manual = signUp('someone-else@example.test');
  sql(`select public.apply_ls_event('${manual}'::uuid, 'pro', 'LL-TAKEN', '8001', 'active', '2026-10-09T22:00:00Z', null, null)`);
  const payer = signUp('taken@example.test');

  const before = versions();
  assert.deepEqual(linkTx(), { n: 0, wrote: false }, '막힌 후보만 있으면 트랜잭션 번호도 받지 않는다(쓰기 0)');
  assert.equal(versions(), before, '기록·권한 행 어느 것도 쓰거나 잠그지 않았다');
  assert.deepEqual(linkTx(), { n: 0, wrote: false }, '다시 돌려도 같다');
  for (const [sub, uid] of [['LL-UNV', unv], ['LL-TWIN', twinA], ['LL-TWIN', twinB], ['LL-TAKEN', payer]]) {
    assert.equal(ent(uid), 'none', `${sub}: 연결하지 않았다`);
    assert.match(rec(sub), /\|false\|-$/, `${sub}: 미해결로 남는다(수동 판단 대상)`);
  }
  assert.equal(ent(held), 'pro|LL-HELD-OLD|cancelled', '③ 지금 쓰는 구독 연결을 덮지 않는다');
  assert.equal(ent(manual), 'pro|LL-TAKEN|active', '④ 원래 연결 그대로');
  assert.equal(sql(`select count(*) from public.entitlements where ls_subscription_id = 'LL-TAKEN'`), '1', '④ 한 구독은 한 계정에만');
  // 인증하면 그때 연결된다(①)
  sql(`update auth.users set email_confirmed_at = now() where id = '${unv}'`);
  assert.equal(link(), 1);
  assert.equal(ent(unv), 'pro|LL-UNV|active');
});

test('옛 기록(새 열이 빈 행)·시험 결제·다른 사유·이벤트 이름·기간 끝난 해지는 자동 연결하지 않는다', { skip }, async () => {
  // 옛 기록 — 마이그레이션 전 엣지가 남긴 모양(2026-10-09 21:00 UTC 사고 행과 같다). 무엇을 적용할지 몰라 그대로 둔다.
  sql(`insert into public.billing_unmatched (event_name, reason, ls_subscription_id, ls_customer_id, user_email)
       values ('subscription_created', 'no-user', 'LL-LEGACY', '8001', 'legacy@example.test')`);
  const legacy = signUp('legacy@example.test');
  // 시험 결제 — 스테이징(LS_ALLOW_TEST=1)에서만 기록까지 온다
  const t = await pay({ sub: 'LL-TEST', email: 'testmode@example.test', testMode: true }, { LS_ALLOW_TEST: '1' });
  assert.deepEqual(t.json, { ok: true, unmatched: 'no-user' });
  assert.equal(sql(`select test_mode from public.billing_unmatched where ls_subscription_id = 'LL-TEST'`), 't');
  const tester = signUp('testmode@example.test');
  // 같은 모양이지만 사유·이벤트 이름이 다른 기록(점검용 probe·대사) — no-user 라이프사이클 기록만 본다
  for (const [sub, ev, reason, email] of [['LL-PROBE', 'probe', 'no-user', 'probe@example.test'], ['LL-RECON', 'reconcile', 'duplicate-attribution', 'recon@example.test']]) {
    sql(`select public.record_ls_unmatched('${ev}', '${reason}', '${sub}', '8001', '${email}', 'pro', 'active', now(), null, null, false)`);
  }
  const prober = signUp('probe@example.test');
  const reconciler = signUp('recon@example.test');
  // 해지 예약이었는데 기간이 이미 끝남 — 연결해도 Pro가 아니다
  await pay({ name: 'subscription_cancelled', sub: 'LL-LAPSED', email: 'lapsed@example.test', status: 'cancelled', endsAt: '2026-10-01T00:00:00Z' });
  const lapsed = signUp('lapsed@example.test');
  // 기록된 최신 상태가 만료(free)
  await pay({ name: 'subscription_expired', sub: 'LL-EXPIRED', email: 'expired@example.test', status: 'expired', endsAt: '2026-10-01T00:00:00Z' });
  const expired = signUp('expired@example.test');

  const before = versions();
  assert.deepEqual(linkTx(), { n: 0, wrote: false });
  assert.equal(versions(), before);
  for (const uid of [legacy, tester, prober, reconciler, lapsed, expired]) assert.equal(ent(uid), 'none');
  assert.equal(rec('LL-LEGACY'), 'no-user|-|-|-|false|-', '옛 기록은 손대지 않는다 — 수동 연결 대상');
});

test('옛 기록이라도 그 구독의 다음 이벤트가 오면 값이 채워진다 — 계정이 이미 있으면 웹훅이 바로 연결한다', { skip }, async () => {
  sql(`insert into public.billing_unmatched (event_name, reason, ls_subscription_id, ls_customer_id, user_email)
       values ('subscription_created', 'no-user', 'LL-LEGACY2', '8001', 'legacy2-payer@example.test')`);
  // 계정이 아직 없을 때 다음 이벤트 — 기록이 최신 상태로 채워진다(옛 행의 시각이 비어 있어 순서 역전으로 보지 않는다)
  const r = await pay({ name: 'subscription_updated', sub: 'LL-LEGACY2', email: 'legacy2-payer@example.test', updatedAt: '2026-11-09T21:00:00Z' });
  assert.deepEqual(r.json, { ok: true, unmatched: 'no-user' });
  assert.equal(rec('LL-LEGACY2'), 'no-user|pro|active|2026-11-09T21:00:00|false|-');
  const uid = signUp('legacy2-payer@example.test');
  assert.equal(link(), 1);
  assert.equal(ent(uid), 'pro|LL-LEGACY2|active');
});

test('기록은 LS updated_at이 가장 최근인 상태 — 늦게 온 옛 이벤트·같은 값 재전송은 쓰지 않고, 만료가 최신이면 연결하지 않는다', { skip }, async () => {
  const email = 'order@example.test';
  await pay({ name: 'subscription_updated', sub: 'LL-ORDER', email, status: 'past_due', updatedAt: '2026-10-12T00:00:00Z' });
  const v1 = sql(`select xmin || '/' || xmax from public.billing_unmatched where ls_subscription_id = 'LL-ORDER'`);
  // 늦게 도착한 옛 이벤트(created, 더 이른 시각) — 덮지 않는다
  await pay({ sub: 'LL-ORDER', email, updatedAt: '2026-10-09T21:00:17Z' });
  assert.equal(rec('LL-ORDER'), 'no-user|pro|past_due|2026-10-12T00:00:00|false|-');
  assert.equal(sql(`select public.record_ls_unmatched('subscription_created', 'no-user', 'LL-ORDER', '8001', '${email}', 'pro', 'active', '2026-10-09T21:00:17Z', null, null, false)`), 'kept');
  // 같은 페이로드 재전송 — 쓰지 않는다
  const same = ['subscription_updated', 'no-user', 'LL-ORDER', '8001', email, 'pro', 'past_due', '2026-10-12T00:00:00Z'];
  assert.equal(sql(`select public.record_ls_unmatched(${same.map((v) => `'${v}'`).join(', ')}, null, 'https://argo.lemonsqueezy.example/billing/LL-ORDER', false)`), 'kept');
  // (늦은 이벤트·재전송은 on conflict가 행을 잠가 xmax만 바뀔 수 있다 — 내용 버전 xmin이 그대로인지 본다)
  assert.equal(sql(`select xmin from public.billing_unmatched where ls_subscription_id = 'LL-ORDER'`), v1.split('/')[0], '내용을 다시 쓰지 않았다');
  // 더 최근 만료 — 최신 상태가 free가 된다
  await pay({ name: 'subscription_expired', sub: 'LL-ORDER', email, status: 'expired', updatedAt: '2026-10-20T00:00:00Z', endsAt: '2026-10-20T00:00:00Z' });
  assert.equal(rec('LL-ORDER'), 'no-user|free|expired|2026-10-20T00:00:00|false|-');
  const uid = signUp(email);
  assert.equal(link(), 0, '결제가 끝난 구독은 연결하지 않는다');
  assert.equal(ent(uid), 'none');
});

// 분리 검수 MEDIUM-1: 같은 구독의 다음 이벤트가 다른 사유(email-account-has-subscription 등)로 남으면 no-user 행은 처음 상태에 머문다.
// 그 상태로 연결하면 이미 해지·만료된 구독이 기한 없는 Pro가 된다 — 다른 사유 행이 더 최신이거나 시각을 모르면 연결하지 않는다.
test('같은 구독의 다른 사유 기록이 더 최신이거나 시각을 모르면 no-user 행이 낡았을 수 있어 연결하지 않는다', { skip }, async () => {
  for (const [sub, email, otherAt] of [['LL-STALE-NEWER', 'stale1@example.test', "'2026-10-20T00:00:00Z'"], ['LL-STALE-NULL', 'stale2@example.test', 'null']]) {
    await pay({ sub, email }); // no-user, active, 10-09
    sql(`select public.record_ls_unmatched('subscription_expired', 'email-account-has-subscription', '${sub}', '8001', '${email}', 'free', 'expired', ${otherAt}, '2026-10-20T00:00:00Z', null, false)`);
  }
  // 대조: 다른 사유 행이 더 오래됐으면 no-user 행이 최신이다 — 연결한다
  await pay({ sub: 'LL-STALE-OLDER', email: 'stale3@example.test' });
  sql(`select public.record_ls_unmatched('subscription_created', 'email-account-has-subscription', 'LL-STALE-OLDER', '8001', 'stale3@example.test', 'pro', 'active', '2026-10-01T00:00:00Z', null, null, false)`);
  const u1 = signUp('stale1@example.test');
  const u2 = signUp('stale2@example.test');
  const u3 = signUp('stale3@example.test');
  assert.equal(link(), 1);
  assert.equal(ent(u1), 'none', '더 최신인 만료가 다른 사유 행에 있다');
  assert.equal(ent(u2), 'none', '다른 사유 행의 시각을 모른다');
  assert.equal(ent(u3), 'pro|LL-STALE-OLDER|active');
  assert.deepEqual(linkTx(), { n: 0, wrote: false }, '막힌 두 건은 다시 돌려도 쓰지 않는다');
});

test('구독 번호가 빈 기록은 예전처럼 첫 기록을 유지한다(수동 처리 근거) — 크론 대상도 아니다', { skip }, () => {
  const first = sql(`select public.record_ls_unmatched('subscription_created', 'no-user', '', '1', 'first@example.test', 'pro', 'active', '2026-10-01T00:00:00Z', null, null, false)`);
  assert.ok(['inserted', 'kept'].includes(first), first);
  assert.equal(sql(`select public.record_ls_unmatched('subscription_updated', 'no-user', '', '2', 'second@example.test', 'pro', 'active', '2026-10-05T00:00:00Z', null, null, false)`), 'kept');
  assert.equal(sql(`select user_email from public.billing_unmatched where ls_subscription_id = '' and reason = 'no-user'`), 'first@example.test');
});

test('해결된 기록은 이후 이벤트가 와도 바꾸지 않는다', { skip }, async () => {
  await pay({ sub: 'LL-DONE', email: 'done@example.test' });
  sql(`update public.billing_unmatched set resolved_at = now() where ls_subscription_id = 'LL-DONE'`); // 운영자가 처리 끝
  const r = await pay({ name: 'subscription_updated', sub: 'LL-DONE', email: 'done@example.test', status: 'past_due', updatedAt: '2026-10-30T00:00:00Z' });
  assert.deepEqual(r.json, { ok: true, unmatched: 'no-user' });
  assert.equal(rec('LL-DONE'), 'no-user|pro|active|2026-10-09T21:00:17|true|-');
});

test('이미 같은 계정에 연결된 구독의 남은 기록 — 다시 적용하지 않고 해결 표시만(기록이 연결된 행보다 오래됐을 수 있다)', { skip }, async () => {
  await pay({ sub: 'LL-SELF', email: 'self@example.test' }); // 기록: active, 10-09
  const uid = signUp('self@example.test');
  // 크론보다 먼저 다음 이벤트가 와서 웹훅이 이메일로 바로 연결 — 더 최신 상태
  const r = await pay({ name: 'subscription_cancelled', sub: 'LL-SELF', email: 'self@example.test', status: 'cancelled', updatedAt: '2026-10-15T00:00:00Z', endsAt: '2026-11-09T21:00:17Z' });
  assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'cancelled' });
  assert.equal(link(), 1);
  assert.equal(ent(uid), 'pro|LL-SELF|cancelled', '기록의 옛 상태(active)로 되돌리지 않는다');
  assert.match(rec('LL-SELF'), new RegExp(`\\|true\\|${uid}$`));
});

test('권한: 기록·연결 함수는 anon·authenticated·PUBLIC 실행 불가, service_role만', { skip }, () => {
  const fns = [
    ['public.ls_link_late_signups()', 'select public.ls_link_late_signups()'],
    ['public.record_ls_unmatched(text, text, text, text, text, text, text, timestamptz, timestamptz, text, boolean)',
      `select public.record_ls_unmatched('subscription_created', 'no-user', 'LL-PERM', '1', 'perm@example.test', 'pro', 'active', now(), null, null, false)`],
  ];
  for (const [sig, call] of fns) {
    for (const role of ['anon', 'authenticated']) {
      const r = psqlSpawn(DB, ['-c', `set role ${role}; ${call}`]);
      assert.notEqual(r.status, 0, `${role}이 ${sig} 실행 — 남의 결제를 자기 계정에 붙이거나 기록을 바꾸는 통로`);
      assert.match(r.stderr, /permission denied/i, `${role} ${sig}`);
    }
    assert.equal(sql(`select exists (select 1 from pg_proc p, aclexplode(p.proacl) a
      where p.oid = '${sig}'::regprocedure and a.grantee = 0::oid and a.privilege_type = 'EXECUTE')`), 'f', `${sig}: PUBLIC 실행권`);
    assert.equal(sql(`select prosecdef and proconfig::text like '%search_path=public, pg_temp%' from pg_proc where oid = '${sig}'::regprocedure`), 't', `${sig}: security definer·search_path 고정`);
    psql(['-A', '-t', '-c', `set role service_role; ${call}`]);
  }
});
