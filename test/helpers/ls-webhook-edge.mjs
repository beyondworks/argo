// supabase/functions/ls-webhook/index.ts를 node에서 실행한다. Deno 전용 파일(Deno.serve·Deno.env·npm: import)이라
// import할 수 없어서, 타입만 지우고(node:module stripTypeScriptTypes) vm에서 돌리며 Deno·createClient만 바꿔 끼운다
// (test/msgr-push-handler.test.mjs와 같은 방식). 배포되는 진입점 파일 그대로를 실행하므로 테스트용 사본 로직이 아니다.
// sb: 엣지 함수가 쓰는 supabase-js 호출(rpc·from().select().eq().neq().limit()·from().upsert())을 흉내 내는 객체.
//     ls-webhook-edge.test.mjs는 메모리 가짜를, billing-pg-integration.test.mjs는 실제 Postgres에 붙는 가짜를 넣는다.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';

const raw = readFileSync(new URL('../../supabase/functions/ls-webhook/index.ts', import.meta.url), 'utf8');
const imports = raw.match(/^import .* from .*;$/gm) ?? [];
// 바꿔 끼우는 import는 createClient 하나뿐이어야 한다 — 다른 import가 생기면 vm 안에서 정의되지 않아 조용히 다른 코드가 돈다.
if (imports.length !== 1 || !/\{ createClient \} from 'npm:@supabase\/supabase-js@2'/.test(imports[0])) {
  throw new Error(`ls-webhook import가 예상과 다르다 — 이 도구에 새 의존을 넣어 주세요: ${imports.join(' | ')}`);
}
const SRC = stripTypeScriptTypes(raw).replace(/^import .* from .*;$/gm, '');

export const SECRET = 'test-ls-webhook-secret';
export const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');

/** 함수를 한 번 띄운다. env는 Deno.env 값(기본: 시크릿·DB 주소·서비스 키), sb는 createClient가 돌려줄 객체. */
export function loadLsWebhook({ env = {}, sb = null } = {}) {
  let handler = null;
  const logs = [];
  const clients = [];
  const config = { LS_WEBHOOK_SECRET: SECRET, SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role', ...env };
  const capture = (level) => (...args) => logs.push(`${level}: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`);
  vm.runInNewContext(SRC, {
    Deno: { env: { get: (k) => config[k] }, serve: (fn) => { handler = fn; } },
    createClient: (url, key, opts) => { clients.push({ url, key, opts }); return sb; },
    Response, Request, TextEncoder, crypto,
    console: { log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error') },
  });
  if (!handler) throw new Error('Deno.serve가 불리지 않았다');

  /** 서명한 POST 하나를 보낸다. signature를 주면 그 값을, rawBody를 주면 JSON 대신 그 본문을 쓴다. */
  async function post(payload, { signature, rawBody, method = 'POST' } = {}) {
    const body = rawBody ?? JSON.stringify(payload);
    const init = { method, headers: { 'x-signature': signature ?? sign(body) } };
    if (method !== 'GET' && method !== 'HEAD') init.body = body;
    const res = await handler(new Request('https://edge.test/functions/v1/ls-webhook', init));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 글자 응답 */ }
    return { status: res.status, text, json };
  }
  return { post, logs, clients };
}
