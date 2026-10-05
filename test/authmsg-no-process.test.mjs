// rc-0195 회귀(T3 발견): app/ui.jsx가 AUTH_MSG를 쓰려고 app/authmsg.mjs를 열고(4b642752), 메신저(vite)는 ui.jsx를
// @argo/ui로 그대로 가져온다. 브라우저에는 process가 없어 authmsg.mjs 맨 위 `process.env…`가 ReferenceError를 던졌고,
// 메신저 dev 서버·픽스처가 "앱을 불러오지 못했습니다"에서 멈췄다. 행동으로 잠근다: process를 지운 자식 프로세스에서 실제로 import한다.
// 서버 쪽 AUTH_ON·TENANT 판정(env가 있을 때)은 auth-guard-lang.test.mjs가 그대로 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const url = new URL('../app/authmsg.mjs', import.meta.url).href;

test('authmsg.mjs — process가 없는 환경(브라우저)에서 import해도 멈추지 않고, 인증 꺼짐·테넌트 없음으로 본다', () => {
  const probe = `
    delete globalThis.process;
    const log = console.log;
    if (typeof process !== 'undefined') throw new Error('process가 아직 있다 — 프로브가 무효');
    try {
      const m = await import(${JSON.stringify(url)});
      log(JSON.stringify({ ok: true, authOn: m.AUTH_ON, tenant: m.TENANT, codes: Object.keys(m.AUTH_MSG).length, msg: m.AUTH_MSG.auth_required.en }));
    } catch (e) { log(JSON.stringify({ ok: false, error: String(e && e.message) })); }
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }).trim();
  const r = JSON.parse(out.split('\n').at(-1));
  assert.equal(r.ok, true, `import가 던졌다: ${r.error}`);
  assert.equal(r.authOn, false);
  assert.equal(r.tenant, null);
  assert.equal(r.codes, 6);
  assert.equal(r.msg, 'Sign in to continue');
});

test('authmsg.mjs — process가 있으면 종전대로 env로 판정한다(서버·엣지)', () => {
  const probe = `
    const m = await import(${JSON.stringify(url)});
    console.log(JSON.stringify({ authOn: m.AUTH_ON, tenant: m.TENANT }));
  `;
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).trim());
  assert.deepEqual(run({}), { authOn: false, tenant: null });
  assert.deepEqual(run({ NEXT_PUBLIC_SUPABASE_URL: 'https://fake.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon', ARGO_TENANT_OWNER: ' uid-1 ' }), { authOn: true, tenant: 'uid-1' });
  assert.deepEqual(run({ NEXT_PUBLIC_SUPABASE_URL: 'https://fake.supabase.co' }), { authOn: false, tenant: null }, '키 하나만 있으면 꺼짐');
});
