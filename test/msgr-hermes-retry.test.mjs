// 헤르메스 어댑터 재시도 대기 — 일시 오류(5xx·네트워크)는 3초 상한, 연속 12회 넘거나 429면 느린 30초 사다리.
// 2026-09-23 카맥 실측: 실패하는 getUpdates는 3.3초에 끝나는데 30초를 자서 무응답 시간의 76%가 그 대기였다(슈리 검수).
// 같은 날 VPS 서버 연결이 저장소 번들 어댑터로 교체하며 이 패치를 지웠다 — 저장소 원본에 넣어 재연결에도 남게 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('재시도 대기 — 일시 오류는 3초 상한, 12회 초과·429는 30초 사다리', () => {
  const script = String.raw`
import asyncio, importlib.util, sys, types
for name in ['gateway', 'gateway.config', 'gateway.platforms', 'gateway.platforms.base']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['gateway.config'].Platform = str
class Box:
    def __init__(self, **kw): self.__dict__.update(kw)
class Base:
    def __init__(self, **kw): pass
b = sys.modules['gateway.platforms.base']
b.BasePlatformAdapter = Base; b.MessageEvent = b.SendResult = Box; b.MessageType = Box(TEXT='text')
spec = importlib.util.spec_from_file_location('argo_adapter', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
slept = []
async def fake_sleep(s): slept.append(s)
m.asyncio.sleep = fake_sleep
a = m.ArgoMsgrAdapter(Box(extra={}))
async def run(transient, n):
    slept.clear(); backoff = 1.0
    for streak in range(1, n + 1): backoff = await a._retry_wait(backoff, streak, transient, 'x')
    return list(slept)
short = asyncio.run(run(True, 12))
assert max(short) <= 3.0, short
slow = asyncio.run(run(True, 16))
assert max(slow[12:]) > 3.0, slow
rl = asyncio.run(run(False, 8))
assert max(rl) > 3.0, rl
print('ok')
`;
  const r = spawnSync('python3', ['-c', script, fileURLToPath(new URL('../integrations/hermes-argo-msgr/adapter.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});
