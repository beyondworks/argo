// C1 회귀 — 신규 기기(~/.argo 전무)에서 codex 조달이 락 부재로 120초 헛돌다 거짓 문구로 죽던 것.
// v0.1.46(#297)의 withCodexLock가 자기 부모 디렉터리를 락 안에서 만들어 자가복구 불가였다.
// 문맥 행렬 교훈: "기기 상태(신규/기존)" 축이 기존 테스트에 없어(개발 기기엔 ~/.argo/tools 존재) 못 잡았다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('신규 기기(~/.argo 전무) + 네트워크 차단: 120초 대기 없이 진짜 원인에 즉시 도달', async () => {
  const HOME = await mkdtemp(join(tmpdir(), 'codex-fresh-'));
  const realHome = process.env.HOME;
  const realFetch = globalThis.fetch;
  process.env.HOME = HOME;
  globalThis.fetch = async () => { throw new Error('network disabled (test)'); };
  try {
    assert.equal(existsSync(join(HOME, '.argo', 'tools')), false, '전제: ~/.argo/tools 없음(신규 기기)');
    const { provisionCodexCli } = await import('../src/runners/codex.mjs');
    const t0 = Date.now();
    let msg = '';
    try { await provisionCodexCli(); } catch (e) { msg = String(e.message); }
    const dt = Date.now() - t0;
    assert.ok(dt < 30_000, `조달이 ${dt}ms 걸렸다 — 락 부재 120초 헛돎 회귀(30초 미만이어야)`);
    assert.doesNotMatch(msg, /다른 프로세스에서 진행 중/, '거짓 "다른 프로세스" 문구가 나오면 안 된다');
    assert.match(msg, /network disabled|다운로드/, `진짜 원인(네트워크)이 표면화돼야: ${msg.slice(0, 80)}`);
  } finally {
    process.env.HOME = realHome; globalThis.fetch = realFetch;
  }
});
