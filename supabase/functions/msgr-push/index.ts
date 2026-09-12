// msgr-push — 모바일 푸시 발송(APNs·FCM). 트리거 msgr_push_enqueue(pg_net)가 {message_id} 하나를 보낸다.
// 수신자는 여기서 DB 함수(msgr_push_recipients)로 다시 계산하고 msgr_push_sent 로 메시지당 한 번만 보낸다 → 공유 비밀 없이도
// 재생·위조 호출이 추가 알림을 만들지 못한다(verify_jwt=false, 배포: config.toml [functions.msgr-push]).
// 비밀은 전부 엣지 시크릿: APNS_KEY_P8(.p8 PEM 본문)·APNS_KEY_ID·APNS_TEAM_ID·APNS_TOPIC(번들 id)·APNS_SANDBOX('1'이면 개발 서버)
//   ·FCM_SERVICE_ACCOUNT(서비스 계정 JSON 문자열). 없는 플랫폼은 건너뛴다.
import { apnsJwt, apnsPayload, fcmMessage, googleAssertion, pushText, shouldDropToken } from './core.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const rest = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`rest ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};

let apnsTok: { jwt: string; at: number } | null = null;
async function apnsAuth() {
  const p8 = Deno.env.get('APNS_KEY_P8'); const kid = Deno.env.get('APNS_KEY_ID'); const team = Deno.env.get('APNS_TEAM_ID');
  if (!p8 || !kid || !team) return null;
  if (!apnsTok || Date.now() - apnsTok.at > 45 * 60_000) apnsTok = { jwt: await apnsJwt({ p8: p8.replace(/\\n/g, '\n'), keyId: kid, teamId: team }), at: Date.now() };
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
  if (!r.ok) throw new Error(`fcm oauth ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  fcmTok = { token: j.access_token, at: Date.now(), project: sa.project_id };
  return fcmTok;
}

async function sendOne(t: { token: string; platform: string }, text: { title: string; body: string }, channelId: string, messageId: number) {
  if (t.platform === 'ios') {
    const jwt = await apnsAuth(); if (!jwt) return 'skip';
    const host = Deno.env.get('APNS_SANDBOX') === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const r = await fetch(`${host}/3/device/${t.token}`, { method: 'POST', headers: { authorization: `bearer ${jwt}`, 'apns-topic': Deno.env.get('APNS_TOPIC') ?? 'com.beyondworks.argo.messenger', 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': `ch-${channelId}`.slice(0, 64) },
      body: JSON.stringify(apnsPayload({ ...text, channelId, messageId })) });
    const txt = r.ok ? '' : await r.text();
    if (!r.ok && shouldDropToken('ios', r.status, txt)) await rest(`msgr_push_tokens?token=eq.${encodeURIComponent(t.token)}`, { method: 'DELETE' });
    return r.ok ? 'ok' : `apns ${r.status} ${txt.slice(0, 120)}`;
  }
  const f = await fcmAuth(); if (!f) return 'skip';
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${f.project}/messages:send`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fcmMessage({ token: t.token, ...text, channelId, messageId })) });
  const txt = r.ok ? '' : await r.text();
  if (!r.ok && shouldDropToken('android', r.status, txt)) await rest(`msgr_push_tokens?token=eq.${encodeURIComponent(t.token)}`, { method: 'DELETE' });
  return r.ok ? 'ok' : `fcm ${r.status} ${txt.slice(0, 120)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });
  let id: number;
  try { id = Number((await req.json())?.message_id); } catch { return new Response('bad json', { status: 400 }); }
  if (!Number.isInteger(id) || id <= 0) return new Response('bad message_id', { status: 400 });
  // 메시지당 한 번 — 먼저 표를 잡는다(경합·재생 방지)
  const claim = await fetch(`${SUPABASE_URL}/rest/v1/msgr_push_sent`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ message_id: id }) });
  if (claim.status === 409) return Response.json({ ok: true, dup: true });
  if (!claim.ok) return new Response(`claim ${claim.status}`, { status: 500 });
  const [m] = await rest(`msgr_messages?id=eq.${id}&select=id,channel_id,author_kind,author_user_id,crew_id,body,kind,deleted_at`);
  if (!m || m.kind !== 'text' || m.deleted_at) return Response.json({ ok: true, sent: 0 });
  const rcpt: string[] = (await rest(`rpc/msgr_push_recipients_of`, { method: 'POST', body: JSON.stringify({ mid: id }) })) ?? [];
  if (!rcpt.length) return Response.json({ ok: true, sent: 0 });
  const toks: { token: string; platform: string; user_id: string }[] = await rest(`msgr_push_tokens?user_id=in.(${rcpt.join(',')})&select=token,platform,user_id`);
  if (!toks.length) return Response.json({ ok: true, sent: 0 });
  const [ch] = await rest(`msgr_channels?id=eq.${m.channel_id}&select=name,kind,org_id`);
  const authorName = m.author_kind === 'crew'
    ? (await rest(`msgr_crews?id=eq.${m.crew_id}&select=display_name`))?.[0]?.display_name
    : (await rest(`msgr_org_members?org_id=eq.${ch?.org_id}&user_id=eq.${m.author_user_id}&select=display_name`))?.[0]?.display_name;
  const text = pushText({ body: m.body, authorName, channelName: ch?.name, channelKind: ch?.kind });
  const results = await Promise.all(toks.map((t) => sendOne(t, text, m.channel_id, id).catch((e) => `err ${String(e?.message ?? e).slice(0, 120)}`)));
  const sent = results.filter((x) => x === 'ok').length;
  await rest(`msgr_push_sent?message_id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sent }) }).catch(() => null);
  console.log(`[msgr-push] message ${id} → ${toks.length} tokens, sent ${sent}`, results.filter((x) => x !== 'ok'));
  return Response.json({ ok: true, sent, results });
});
