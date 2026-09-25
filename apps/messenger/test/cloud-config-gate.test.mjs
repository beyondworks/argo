// 유건 제보 2026-09-25: TestFlight 0.1.39가 "서버 설정이 없습니다" 화면만 — 발행 워크트리에 로컬 설정 파일이 없어 서버 주소 없이 빌드됐다.
// Tauri 발행 빌드(모든 플랫폼)는 서버 주소·공개 키가 없으면 빌드 자체를 실패시킨다. 개발 서버·Tauri 밖 빌드는 그대로(셀프호스트 설정 화면).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudConfigProblem } from '../scripts/cloud-config-gate.mjs';

const full = { VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' };

test('Tauri 발행 빌드에 서버 설정이 없으면 막는다 — iOS·Android·데스크톱', () => {
  for (const platform of ['ios', 'android', 'darwin', 'windows']) {
    assert.match(cloudConfigProblem({ command: 'build', platform, env: {} }), /VITE_SUPABASE_URL.*VITE_SUPABASE_ANON_KEY/);
    assert.match(cloudConfigProblem({ command: 'build', platform, env: { VITE_SUPABASE_URL: 'https://x.supabase.co' } }), /VITE_SUPABASE_ANON_KEY/);
    assert.match(cloudConfigProblem({ command: 'build', platform, env: { ...full, VITE_SUPABASE_URL: '  ' } }), /VITE_SUPABASE_URL/);
    assert.equal(cloudConfigProblem({ command: 'build', platform, env: full }), null);
  }
});

test('개발 서버와 Tauri 밖 빌드는 막지 않는다', () => {
  assert.equal(cloudConfigProblem({ command: 'serve', platform: 'ios', env: {} }), null);
  assert.equal(cloudConfigProblem({ command: 'build', platform: undefined, env: {} }), null);
  assert.equal(cloudConfigProblem({ command: 'build', platform: '', env: {} }), null);
});

test('vite 설정이 이 검사를 실제로 부른다', async () => {
  const { default: config } = await import('../vite.config.js');
  assert.equal(typeof config, 'function', 'defineConfig에 함수를 넘겨 command를 받아야 한다');
  const saved = { ...process.env };
  try {
    process.env.TAURI_ENV_PLATFORM = 'ios'; delete process.env.VITE_SUPABASE_URL; delete process.env.VITE_SUPABASE_ANON_KEY;
    assert.throws(() => config({ command: 'build', mode: 'gate-test-no-env' }), /VITE_SUPABASE_URL/);
    Object.assign(process.env, full);
    assert.doesNotThrow(() => config({ command: 'build', mode: 'gate-test-no-env' }));
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
