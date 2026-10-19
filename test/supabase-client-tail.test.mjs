// 본체(Node)의 모든 Supabase 클라이언트가 X-Client-Info 끝에 ' argo/<앱 버전>'을 단다(2026-10-19, #1107 엄격 검수 H1).
// 옛 앱 사용 중지 장치(20261018130000)는 꼬리 없는 옛 서명(supabase-js 2.110.2, runtime=node) 요청을 옛 앱으로 의심한다 — 새 앱의 요청 하나라도
// 꼬리가 빠지면 0.1.113에서 그대로 업데이트한 세션이 오인될 수 있었다. 잠그는 것 두 가지:
//  ① src/·app/·lib/의 서버 코드는 '@supabase/supabase-js'를 직접 가져오지 않는다 — src/supabase-client.mjs(argoCreateClient) 하나만.
//     브라우저 코드('use client' 파일)는 대상이 아니다. 새 createClient 사용처가 생기면 이 시험이 빨갛게 된다.
//  ② argoCreateClient는 기본 X-Client-Info를 보존한 채 꼬리를 붙인다(사용자 fetch를 넘겨도).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|jsx|ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

test('① 서버 코드는 @supabase/supabase-js를 직접 가져오지 않는다 — src/supabase-client.mjs 하나(브라우저 파일 제외)', () => {
  const bad = [];
  for (const top of ['src', 'app', 'lib']) {
    let files = [];
    try { files = walk(join(ROOT, top)); } catch { continue; }
    for (const f of files) {
      const rel = relative(ROOT, f).split('\\').join('/');
      if (rel === 'src/supabase-client.mjs') continue;
      const src = readFileSync(f, 'utf8');
      if (!src.includes('@supabase/supabase-js')) continue;
      if (/^\s*['"]use client['"]/.test(src)) continue; // 브라우저 — 꼬리를 달지 않는다
      bad.push(rel);
    }
  }
  assert.deepEqual(bad, [], `꼬리 없는 Supabase 클라이언트가 생길 수 있다 — src/supabase-client.mjs의 argoCreateClient를 쓸 것: ${bad.join(', ')}`);
});

test('② argoCreateClient 요청은 기본 X-Client-Info 뒤에 argo/<버전>을 단다 — 넘긴 fetch를 감싸고, 이미 붙었으면 한 번만', async () => {
  const { argoCreateClient } = await import('../src/supabase-client.mjs');
  const { ARGO_CLIENT_INFO } = await import('../src/app-version.mjs');
  assert.ok(ARGO_CLIENT_INFO, '시험 환경에서 앱 버전을 읽지 못했다');
  const seen = [];
  const fake = async (u, init = {}) => { seen.push(new Headers(init.headers).get('x-client-info')); return new Response('{"plan":"free"}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const sb = argoCreateClient('http://127.0.0.1:9', 'anon', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fake } });
  await sb.rpc('my_plan', { p_uid: null });
  const twice = argoCreateClient('http://127.0.0.1:9', 'anon', { auth: { persistSession: false }, global: { fetch: (await import('../src/app-version.mjs')).withArgoClientInfo(fake) } });
  await twice.rpc('my_plan', { p_uid: null });
  for (const v of seen) {
    assert.match(v ?? '', /^supabase-js\/[^ ]+; runtime=node/, '기본 X-Client-Info 보존');
    assert.equal((v ?? '').split(' ').filter((x) => x === ARGO_CLIENT_INFO).length, 1, `꼬리 한 번: ${v}`);
  }
  assert.equal(seen.length, 2);
});
