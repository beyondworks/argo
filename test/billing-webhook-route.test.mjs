// 웹훅 라우트 계약(분리 검수 F11) — POST 핸들러를 직접 호출해 경계를 잠근다:
//  ① 위조·미설정은 401(fail-closed, 설정 상태 비노출) ② 과대 본문 413 ③ 손상 JSON 400
//  ④ 미귀속 적재는 서명 검증 이후에만(무서명 스팸으로 테이블을 채울 수 없다)
//  ⑤ DB 실패는 5xx — LS 재시도를 유도해야 한다(200을 주면 이벤트가 조용히 유실된다)
// supabase 호출은 도달 불가 주소(127.0.0.1:9)로 향한다 — 네트워크 실패가 곧 "DB 실패" 재현이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { POST } from '../app/api/billing/webhook/route.js';

const SECRET = 'route-test-secret';
const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');
// 라우트는 req.headers.get / req.text만 쓴다 — Request의 금지 헤더(content-length) 제약을 피해 스텁으로.
const reqOf = (body, headers = {}) => ({
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});

const env = (on) => {
  if (on) {
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET = SECRET;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9'; // 도달 불가 — DB 실패 재현
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  } else {
    delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  }
};

const evt = (status, custom = { user_id: '11111111-2222-3333-4444-555555555555' }) => JSON.stringify({
  meta: { event_name: 'subscription_updated', ...(custom ? { custom_data: custom } : {}) },
  data: { id: 'sub_rt', attributes: { status, customer_id: 7, user_email: 'pay@example.com', updated_at: '2026-07-28T01:00:00Z' } },
});

test('웹훅: 시크릿 미설정·서명 불일치·무서명 전부 401 — 동일 응답(설정 상태 비노출)', async () => {
  env(false);
  const bodyText = async (res) => JSON.stringify(await res.json());
  const r1 = await POST(reqOf(evt('active'), { 'x-signature': sign(evt('active')) }));
  assert.equal(r1.status, 401);
  env(true);
  const r2 = await POST(reqOf(evt('active'), { 'x-signature': sign(evt('active'), 'wrong-secret') }));
  const r3 = await POST(reqOf(evt('active')));
  assert.equal(r2.status, 401);
  assert.equal(r3.status, 401);
  assert.equal(await bodyText(r2), await bodyText(r3)); // 위조와 무서명의 응답 본문도 동일
});

test('웹훅: content-length 1MB 초과는 413 (서명 검증 전 차단)', async () => {
  env(true);
  const r = await POST(reqOf('x', { 'content-length': '2000000' }));
  assert.equal(r.status, 413);
});

test('웹훅: 서명은 맞지만 JSON 손상은 400', async () => {
  env(true);
  const raw = '{broken';
  const r = await POST(reqOf(raw, { 'x-signature': sign(raw) }));
  assert.equal(r.status, 400);
});

test('웹훅: 관련 없는 이벤트는 200 ignored — LS 무한 재시도 방지', async () => {
  env(true);
  const raw = JSON.stringify({ meta: { event_name: 'order_created' }, data: { attributes: { status: 'paid' } } });
  const r = await POST(reqOf(raw, { 'x-signature': sign(raw) }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ignored, 'order_created');
});

test('웹훅: 귀속 실패(no-user)는 200 + unmatched — 적재 실패(DB 도달 불가)여도 흐름을 깨지 않는다', async () => {
  env(true);
  const raw = evt('active', null); // custom_data 없음 → no-user
  const r = await POST(reqOf(raw, { 'x-signature': sign(raw) }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).unmatched, 'no-user');
});

test('웹훅: 정상 매핑인데 DB 실패면 500 — LS 재시도를 유도한다(200이면 조용한 유실)', async () => {
  env(true);
  const raw = evt('active');
  const r = await POST(reqOf(raw, { 'x-signature': sign(raw) }));
  assert.equal(r.status, 500);
});
