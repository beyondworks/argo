// 슬랙 읽기 메서드 요청 모양 — 실제 폴러(startSlack)를 가짜 fetch로 한 바퀴 돌린다. Slack Web API는 JSON 본문을 "JSON을 지원하는 쓰기 메서드"만
// 받는다. 읽기(auth.test·conversations.history)를 JSON POST로 보내면 인자(channel 등)를 못 읽어 매 폴링이 실패하고 슬랙 수신 전체가 멈출 수 있다.
// 실제 슬랙 워크스페이스로는 검증하지 못했다(자격 없음) — 요청 모양을 이 테스트로 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-slack-read-'));
process.env.ARGO_ENC_VAULT = '0';
const { createCompany } = await import('../src/workspace.mjs');
const { _slackForTest: S, queueDir } = await import('../src/gateway.mjs');

test('슬랙 폴러: auth.test·conversations.history는 쿼리 문자열 GET + Bearer로 부르고, 받은 주인 메시지를 큐에 적재한다', async () => {
  const ws = 'slack-read'; await createCompany(ws, '슬랙', 'owner', null, 'ko');
  const reqs = []; let served = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== 'slack.com') return origFetch(url, opts);
    const method = u.pathname.replace('/api/', '');
    reqs.push({ method, http: opts.method ?? 'GET', query: Object.fromEntries(u.searchParams), auth: opts.headers?.authorization, body: opts.body });
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    if (method === 'auth.test') return json({ ok: true, user_id: 'UBOT' });
    if (method === 'conversations.history') {
      // 실제 슬랙처럼 쿼리의 channel이 없으면 거절한다(JSON 본문으로 보내면 여기서 실패 — 판정이 아니라 동작을 본다)
      if (!u.searchParams.get('channel')) return json({ ok: false, error: 'channel_not_found' });
      if (served) return json({ ok: true, messages: [] });
      served = true;
      return json({ ok: true, messages: [{ ts: '9999999999.000100', user: 'U1', text: '오늘 일정 정리해 줘' }] });
    }
    return json({ ok: true });
  };
  const cfg = { enabled: true, token: 'xoxb-fake', channel: 'C1', ownerId: 'U1' };
  const stop = S.startSlack(ws, () => cfg);
  try {
    const deadline = Date.now() + 8000; // 고정 대기 대신 조건 대기 — 적재 파일이 생기면 곧바로 통과
    while (Date.now() < deadline) {
      if ((await readdir(queueDir(ws, 'slack')).catch(() => [])).some((n) => n.endsWith('.json'))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally { stop(); globalThis.fetch = origFetch; }
  const auth = reqs.find((r) => r.method === 'auth.test');
  assert.deepEqual({ http: auth.http, auth: auth.auth, body: auth.body }, { http: 'GET', auth: 'Bearer xoxb-fake', body: undefined }, 'auth.test = GET + Bearer, 본문 없음');
  const hist = reqs.find((r) => r.method === 'conversations.history');
  assert.equal(hist.http, 'GET'); assert.equal(hist.body, undefined, 'JSON 본문이 아니다'); assert.equal(hist.auth, 'Bearer xoxb-fake');
  assert.equal(hist.query.channel, 'C1'); assert.equal(hist.query.limit, '100'); assert.ok(Number(hist.query.oldest) > 0, 'oldest 커서가 쿼리로 간다');
  assert.ok((await readdir(queueDir(ws, 'slack'))).some((n) => n.endsWith('.json')), '받은 주인 메시지가 큐에 적재됐다(수신 전체가 동작)');
});
