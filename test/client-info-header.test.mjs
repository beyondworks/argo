// Supabase edge_logs에서 앱 버전을 가른다(2026-10-17 총괄 지시) — edge_logs는 x-argo-app-version(#1050)을 남기지 않고 user_agent·x_client_info만 남긴다(맥 one 실측).
// 그래서 본체 Node 클라이언트(동기화·메신저 게이트웨이)가 보내는 X-Client-Info 끝에 `argo/<앱 버전>`을 붙인다 — supabase-js 기본값(supabase-js/<v>; runtime=node; …)은 지우지 않는다.
// supabase-js 2.x는 기본 헤더 객체 위에 global.headers를 펼친다: 키를 소문자로 주면 두 값이 함께 실리고(쉼표로 합쳐짐), 같은 키로 주면 기본값이 사라진다 → 나가는 fetch에서 덧붙인다.
// 실제 supabase-js 클라이언트를 같은 옵션으로 만들고, 로컬 HTTP 서버가 받은 요청 헤더를 그대로 본다(PostgREST·RPC·Storage·Auth).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-client-info-')); // import보다 먼저(레포 관례)
const { APP_VERSION } = await import('../src/app-version.mjs');
const { msgrClientOptions } = await import('../src/gateway/msgr.mjs');
const { syncClientOptions } = await import('../src/sync.mjs');

const seen = [];
const srv = http.createServer((req, res) => {
  seen.push({ url: req.url, info: req.headers['x-client-info'], raw: req.rawHeaders, ver: req.headers['x-argo-app-version'], auth: req.headers.authorization });
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url.startsWith('/auth/') ? JSON.stringify({ id: 'u1', aud: 'authenticated' }) : '[]');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const DEFAULT_RE = /^supabase-js\/\d+\.\d+\.\d+; runtime=node; runtime-version=[\d.]+/; // supabase-js 기본값(설치본 dist/index.mjs DEFAULT_HEADERS)

async function drive(client) {
  seen.length = 0;
  await client.from('msgr_crews').select('id').limit(1);
  await client.rpc('msgr_device_beat', { p_ws: 'w' });
  await client.storage.from('sync').list('x');
  await client.auth.getUser('tok');
  return [...seen];
}

for (const [name, opts] of [['메신저 게이트웨이(msgrClientOptions)', () => msgrClientOptions('tok')], ['동기화 세션(syncClientOptions)', () => syncClientOptions('tok2')], ['동기화 서비스 모드', () => syncClientOptions()]]) {
  test(`${name} — X-Client-Info = supabase-js 기본값 + " argo/<앱 버전>", 한 줄·한 번, x-argo-app-version 그대로`, async () => {
    assert.ok(APP_VERSION, '시험 환경에서 앱 버전을 읽는다');
    const hits = await drive(createClient(URL_, 'anon-key', opts()));
    assert.ok(hits.length >= 4, `요청 ${hits.length}건(PostgREST·RPC·Storage·Auth)`);
    for (const h of hits) {
      assert.match(h.info ?? '', DEFAULT_RE, `${h.url}: 기본값이 남아 있다(${h.info})`);
      assert.ok(h.info.endsWith(` argo/${APP_VERSION}`), `${h.url}: 끝에 argo/${APP_VERSION}(${h.info})`);
      assert.equal(h.info.split('argo/').length - 1, 1, `${h.url}: argo/는 한 번만(${h.info})`);
      assert.doesNotMatch(h.info, /,/, `${h.url}: 두 값이 쉼표로 합쳐지지 않는다(${h.info})`);
      assert.equal(h.raw.filter((x, i) => i % 2 === 0 && x.toLowerCase() === 'x-client-info').length, 1, `${h.url}: 헤더 한 개`);
      assert.equal(h.ver, APP_VERSION, `${h.url}: x-argo-app-version은 그대로`);
    }
  });
}
