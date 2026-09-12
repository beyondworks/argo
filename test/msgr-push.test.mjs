// 모바일 푸시 엣지 펑션의 순수 부분(supabase/functions/msgr-push/core.js) — 문구·페이로드·JWT 서명·토큰 폐기 판정.
// JWT는 임시 키를 만들어 서명하고 같은 공개키로 검증한다(Web Crypto만 사용하므로 Deno와 Node 양쪽에서 같은 코드가 돈다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { apnsJwt, apnsPayload, fcmMessage, googleAssertion, pushText, shouldDropToken, b64url } from '../supabase/functions/msgr-push/core.js';

const toPem = (buf, label) => `-----BEGIN ${label}-----\n${Buffer.from(buf).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const dec = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const parts = (jwt) => { const [h, p, s] = jwt.split('.'); return { header: JSON.parse(dec(h)), payload: JSON.parse(dec(p)), sig: dec(s), input: `${h}.${p}` }; };

test('pushText — 데스크톱 알림과 같은 모양(이름 · #채널, 140자 발췌), DM은 채널 없이', () => {
  assert.deepEqual(pushText({ body: '1\n\n@Ogilvy', authorName: 'Edna', channelName: 'Lean-VPS', channelKind: 'private' }), { title: 'Edna · #Lean-VPS', body: '1 @Ogilvy' });
  assert.equal(pushText({ body: 'x'.repeat(300), authorName: 'A', channelName: 'c', channelKind: 'dm' }).body.length, 140);
  assert.equal(pushText({ body: 'hi', authorName: 'A', channelName: 'c', channelKind: 'dm' }).title, 'A');
  assert.equal(pushText({ body: null, authorName: '', channelName: '' }).title, '?');
});

test('페이로드 — APNs 스레드/충돌 키·FCM 데이터에 채널·메시지 id가 문자열로 실린다', () => {
  const a = apnsPayload({ title: 't', body: 'b', channelId: 'c1', messageId: 7 });
  assert.equal(a.aps.alert.title, 't'); assert.equal(a.aps['thread-id'], 'c1'); assert.equal(a.message_id, '7'); assert.equal(a.aps.sound, 'seatbelt-single.caf', '기본 소리');
  assert.equal(apnsPayload({ title: 't', body: 'b', channelId: 'c', messageId: 1, sound: 'wood-knock' }).aps.sound, 'wood-knock.caf');
  assert.equal(apnsPayload({ title: 't', body: 'b', channelId: 'c', messageId: 1, sound: '../x.caf' }).aps.sound, 'xcaf.caf', '경로 문자는 걷어낸다');
  assert.equal(apnsPayload({ title: 't', body: 'b', channelId: 'c', messageId: 1, badge: 7 }).aps.badge, 7, '아이콘 배지');
  assert.equal('badge' in apnsPayload({ title: 't', body: 'b', channelId: 'c', messageId: 1 }).aps, false, '배지 모르면 안 싣는다(기존 숫자 유지)');
  const f = fcmMessage({ token: 'tok', title: 't', body: 'b', channelId: 'c1', messageId: 7 });
  assert.equal(f.message.token, 'tok'); assert.deepEqual(f.message.data, { channel_id: 'c1', message_id: '7' }); assert.equal(f.message.android.priority, 'high');
});

test('apnsJwt — ES256(P-256, .p8 PKCS8) 서명이 같은 키로 검증된다, kid·iss·iat', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const p8 = toPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
  const jwt = await apnsJwt({ p8, keyId: 'KEY123', teamId: 'TEAM1', now: 1700000000 });
  const { header, payload, sig, input } = parts(jwt);
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEY123' }); assert.deepEqual(payload, { iss: 'TEAM1', iat: 1700000000 });
  assert.equal(sig.length, 64, 'JWS ES256 = r||s 64바이트(DER 아님)');
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, new TextEncoder().encode(input)), true);
});

test('googleAssertion — RS256 서명·scope·aud·exp(1시간)', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pem = toPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
  const jwt = await googleAssertion({ clientEmail: 'sa@x.iam', privateKey: pem, scope: 'https://www.googleapis.com/auth/firebase.messaging', now: 1700000000 });
  const { header, payload, sig, input } = parts(jwt);
  assert.equal(header.alg, 'RS256'); assert.equal(payload.iss, 'sa@x.iam'); assert.equal(payload.aud, 'https://oauth2.googleapis.com/token'); assert.equal(payload.exp - payload.iat, 3600);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, sig, new TextEncoder().encode(input)), true);
});

test('shouldDropToken — 죽은 토큰만 지운다(일시 오류·서버 오류는 유지)', () => {
  assert.equal(shouldDropToken('ios', 410, '{"reason":"Unregistered"}'), true);
  assert.equal(shouldDropToken('ios', 400, '{"reason":"BadDeviceToken"}'), true);
  assert.equal(shouldDropToken('ios', 500, ''), false); assert.equal(shouldDropToken('ios', 429, 'TooManyRequests'), false);
  assert.equal(shouldDropToken('android', 404, '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}'), true);
  assert.equal(shouldDropToken('android', 503, 'UNAVAILABLE'), false);
  assert.equal(b64url(new Uint8Array([251, 255]).buffer), '-_8');
});
