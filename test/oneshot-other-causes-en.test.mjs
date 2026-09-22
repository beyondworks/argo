// K62 — 원샷 최종 안내의 "다른 러너도 실패" 꼬리가 영어 사용자에게도 붙는다(`cond ? en : ko + otherCauses()` 결합 순서 결함).
// 실벤더 호출 0: GLM·OpenRouter base URL을 가짜 Messages 서버로 돌린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-os-k62-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-os-k62-'));
process.env.ARGO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'argo-os-k62-cache-'));
process.env.ARGO_MODEL_CATALOG = 'off';
delete process.env.ARGO_NATIVE_RUNNERS;

async function fakeMessages(status, message) {
  let hits = 0;
  const srv = createServer((req, res) => {
    req.resume(); req.on('end', () => { hits += 1; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message, code: status } })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, hits: () => hits, close: () => new Promise((r) => srv.close(r)) };
}

const { createCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { runOneShot } = await import('../src/oneshot.mjs');

test('K62. 앞 러너가 실패한 뒤 OpenRouter 잔액 부족으로 끝나면 영어 안내에도 앞 러너 원인이 붙는다(한국어와 대칭)', async () => {
  const ws = 'k62'; await createCompany(ws, 'K62', 'owner');
  await saveRunnerCred(ws, 'glm', 'apikey', 'fake-glm-key-1234567890');
  await saveRunnerCred(ws, 'openrouter', 'apikey', 'fake-or-key-1234567890');
  const glm = await fakeMessages(401, 'invalid glm key');
  const or = await fakeMessages(402, 'Insufficient credits. Add more using https://openrouter.ai/settings/credits');
  process.env.GLM_BASE_URL = glm.base; process.env.OPENROUTER_BASE_URL = or.base;
  try {
    for (const [lang, credit, tail] of [['ko', /크레딧 잔액이 부족/, /다른 러너도 실패 — .*401/], ['en', /credit balance is too low/, /Other runners also failed — .*401/]]) {
      await assert.rejects(runOneShot(ws, 'x', { timeoutMs: 20_000, lang }), (e) => {
        assert.match(e.message, credit, `${lang} 잔액 안내: ${e.message}`);
        assert.match(e.message, tail, `${lang} 앞 러너 원인 꼬리: ${e.message}`);
        return true;
      });
    }
    assert.ok(glm.hits() >= 1 && or.hits() >= 1, '두 러너 모두 실제로 시도됐다');
  } finally { await glm.close(); await or.close(); delete process.env.GLM_BASE_URL; delete process.env.OPENROUTER_BASE_URL; }
});
