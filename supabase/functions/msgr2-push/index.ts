// msgr2-push — 메신저 v2 휴대폰 알림(APNs·FCM). 트리거 msgr2_push_enqueue(pg_net)가 {message_id} 하나를 보낸다(20261018030000_msgr2_push.sql).
// 받는 사람은 여기서 DB 함수(msgr2_push_recipients)로 다시 계산하고 msgr2_push_sent로 글당 한 번만 보낸다 → 재생·위조 호출이 추가 알림을 만들지 못한다.
// 배포(맥 one): `supabase functions deploy msgr2-push --no-verify-jwt` — pg_net 호출에는 사용자 JWT가 없다(옛 msgr-push와 같이 아래 비밀로 막는다). 배포 뒤 msgr_settings 'msgr2_push_url'에 함수 주소를 넣는다.
// 인증: 트리거가 msgr_settings.push_secret을 Authorization: Bearer로 싣고 여기서 PUSH_FN_SECRET과 상수시간 비교(옛 msgr-push와 같다).
// 비밀은 전부 엣지 시크릿(값은 어디에도 적지 않는다): APNS_KEY_P8·APNS_KEY_ID·APNS_TEAM_ID·APNS_TOPIC·APNS_SANDBOX('1'이면 개발 서버)·FCM_SERVICE_ACCOUNT·PUSH_FN_SECRET.
// 없는 플랫폼은 건너뛴다. 무효 토큰은 기기 행에서 지운다(push_token = null). 일시 오류는 기기마다 MAX_ATTEMPTS번까지, 1초 → 3초 간격.
import { apnsJwt, apnsPayload, DEADLINE_MS, fcmMessage, googleAssertion, MAX_ATTEMPTS, personName, platformOf, pushText, retryable, retryDelay, shouldDropToken } from './core.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const rest = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`rest ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let apnsTok: { jwt: string; at: number } | null = null;
let apnsPending: Promise<string> | null = null;
async function apnsAuth() {
  const p8 = Deno.env.get('APNS_KEY_P8'); const kid = Deno.env.get('APNS_KEY_ID'); const team = Deno.env.get('APNS_TEAM_ID');
  if (!p8 || !kid || !team) return null;
  if (!apnsTok || Date.now() - apnsTok.at >= 45 * 60_000) {
    if (!apnsPending) { // 같은 실행의 동시 발송이 서명을 나눠 쓴다(APNs는 잦은 공급자 토큰 교체를 거부한다)
      const at = Date.now();
      apnsPending = apnsJwt({ p8: p8.replace(/\\n/g, '\n'), keyId: kid, teamId: team, now: Math.floor(at / 1000) })
        .then((jwt: string) => { apnsTok = { jwt, at }; return jwt; })
        .finally(() => { apnsPending = null; });
    }
    return apnsPending;
  }
  return apnsTok.jwt;
}
let fcmTok: { token: string; at: number; project: string } | null = null;
async function fcmAuth() {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT'); if (!raw) return null;
  if (fcmTok && Date.now() - fcmTok.at < 50 * 60_000) return fcmTok;
  const sa = JSON.parse(raw);
  const assertion = await googleAssertion({ clientEmail: sa.client_email, privateKey: sa.private_key, scope: 'https://www.googleapis.com/auth/firebase.messaging', tokenUri: sa.token_uri });
  const r = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!r.ok) throw new Error(`fcm oauth ${r.status}`);
  const j = await r.json();
  fcmTok = { token: j.access_token, at: Date.now(), project: sa.project_id };
  return fcmTok;
}

// 무효 토큰 → 그 기기 행의 push_token만 비운다(행·세션은 그대로 — 앱이 다음 등록 때 새 토큰을 싣는다)
const dropToken = (raw: string) => rest(`msgr2_devices?push_token=eq.${encodeURIComponent(raw)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ push_token: null }) }).catch(() => null);

async function sendOne(raw: string, text: { title: string; body: string }, roomId: string, messageId: number) {
  const p = platformOf(raw); if (!p) return 'skip';
  if (p.platform === 'ios') {
    const jwt = await apnsAuth(); if (!jwt) return 'skip';
    const host = Deno.env.get('APNS_SANDBOX') === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const r = await fetch(`${host}/3/device/${p.token}`, { method: 'POST', headers: { authorization: `bearer ${jwt}`, 'apns-topic': Deno.env.get('APNS_TOPIC') ?? 'com.beyondworks.argo.messenger', 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': `room-${roomId}`.slice(0, 64) },
      body: JSON.stringify(apnsPayload({ ...text, channelId: roomId, messageId })) });
    const txt = r.ok ? '' : await r.text();
    if (!r.ok && shouldDropToken('ios', r.status, txt)) await dropToken(raw);
    return r.ok ? 'ok' : `apns ${r.status} ${txt.slice(0, 120)}`;
  }
  const f = await fcmAuth(); if (!f) return 'skip';
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${f.project}/messages:send`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fcmMessage({ token: p.token, ...text, channelId: roomId, messageId, tag: `room-${roomId}` })) });
  const txt = r.ok ? '' : await r.text();
  if (!r.ok && shouldDropToken('android', r.status, txt)) await dropToken(raw);
  return r.ok ? 'ok' : `fcm ${r.status} ${txt.slice(0, 120)}`;
}

// 사람 작성자 이름: 팀 공간 멤버 이름 → 계정 프로필 이름 → 이메일 앞부분(옛 personName 순서). 에이전트는 표시 이름.
async function authorName(m: { author_kind: string; author_user_id: string | null; author_agent_id: string | null }, spaceId: string | null) {
  if (m.author_kind === 'agent') return (await rest(`msgr2_agents?id=eq.${m.author_agent_id}&select=display_name`))?.[0]?.display_name ?? null;
  const uid = m.author_user_id; if (!uid) return null;
  const memberName = spaceId ? (await rest(`msgr2_space_members?space_id=eq.${spaceId}&user_id=eq.${uid}&select=display_name`))?.[0]?.display_name : null;
  const profileName = personName({ memberName }) ? null : (await rest(`msgr_profiles?user_id=eq.${uid}&select=display_name`))?.[0]?.display_name;
  const known = personName({ memberName, profileName });
  if (known) return known;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).catch(() => null);
  return personName({ email: r?.ok ? (await r.json().catch(() => null))?.email : null });
}

const enc = new TextEncoder();
async function sameSecret(a: string, b: string) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });
  const secret = Deno.env.get('PUSH_FN_SECRET');
  if (secret && !(await sameSecret(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) return new Response('unauthorized', { status: 401 });
  let body: { message_id?: unknown };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const id = Number(body?.message_id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response('bad message_id', { status: 400 });
  // 글당 한 번 — 먼저 장부를 잡는다(경합·재생 방지). 이미 있으면 보내지 않는다
  const claim = await fetch(`${SUPABASE_URL}/rest/v1/msgr2_push_sent`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ message_id: id }) });
  if (claim.status === 409) return Response.json({ ok: true, dup: true });
  if (!claim.ok) return new Response(`claim ${claim.status}`, { status: 500 });
  const [m] = await rest(`msgr2_messages?id=eq.${id}&select=id,room_id,author_kind,author_user_id,author_agent_id,kind,body,meta,deleted_at`);
  if (!m || m.deleted_at) return Response.json({ ok: true, sent: 0 });
  const rows: { user_id: string; push_token: string }[] = (await rest(`rpc/msgr2_push_recipients`, { method: 'POST', body: JSON.stringify({ p_message: id }) })) ?? [];
  const tokens = [...new Set(rows.map((r) => r.push_token).filter(Boolean))];
  if (!tokens.length) return Response.json({ ok: true, sent: 0 });
  const [room] = await rest(`msgr2_rooms?id=eq.${m.room_id}&select=name,kind,space_id`);
  const text = pushText({ body: m.body, authorName: await authorName(m, room?.space_id ?? null), roomName: room?.name, roomKind: room?.kind, card: m.kind === 'card' });
  const started = Date.now();
  const results = await Promise.all(tokens.map(async (raw) => {
    let attempt = 0; let r = '';
    do {
      if (attempt && Date.now() - started > DEADLINE_MS) break;
      attempt++;
      r = await sendOne(raw, text, m.room_id, id).catch((e) => `err ${String(e?.message ?? e).slice(0, 120)}`);
      if (r === 'ok' || !retryable(r, attempt)) break;
      await sleep(retryDelay(attempt));
    } while (attempt < MAX_ATTEMPTS);
    return r;
  }));
  const sent = results.filter((x) => x === 'ok').length;
  const failed = results.filter((x) => x !== 'ok' && x !== 'skip').length;
  await rest(`msgr2_push_sent?message_id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ tokens: tokens.length, sent, failed, finished_at: new Date(Date.now()).toISOString() }) }).catch(() => null);
  console.log(`[msgr2-push] message ${id} → ${tokens.length} tokens, sent ${sent}, failed ${failed}`); // 토큰·본문은 로그에 남기지 않는다
  // 받은 기기에 같은 알림이 두 번 가지 않게, 실패해도 이 글을 다시 처리하지 않는다(장부가 이미 잡혀 있다)
  return Response.json({ ok: failed === 0, sent, failed });
});
