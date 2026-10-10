// 게이트 B(#943, 유건 10/11 "어떤 경우에도 지금보다 답이 늦으면 안 된다") — 글 종류 8 × 상태 6마다 "생긴 때 → 게이트웨이가 처음 읽은 때"를 가짜 시계로 잰다.
// 종전(main) 게이트웨이는 15초마다 조회하므로 방송이 닿지 않는 칸도 최대 15초(새 조직·재개는 미러·목록 두 틱이라 더 길다 — PR 본문 비교표).
// 잠그는 것: 방송이 닿는 칸은 즉시(0ms), 닿지 않는 칸(토큰 회전·끊김)도 15초 이내 — 쉬는 주기(2분)로 밀리는 칸이 하나도 없다.
// 같은 시나리오를 main 사본에 돌린 나란히 비교는 PR 본문(test/helpers/msgr-latency.mjs의 latencyCell을 두 모듈에).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-latency-')); // 격리 루트 — 실데이터 미접촉
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { latencyCell, KINDS, STATES } = await import('./helpers/msgr-latency.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { createAgentCard } = await import('../src/persona.mjs');

afterEach(() => { mock.timers.reset(); M.wakeProtocolCache.at = -Infinity; });
let n = 0;
const fresh = async () => { const ws = `lat-${++n}`; await createCompany(ws, '회사', 'x', '11111111-1111-4111-8111-111111111111'); await createAgentCard(ws, { name: 'c1', role: '', prompt: '시험' }); return ws; };
const BROADCAST_REACHES = new Set(['정상 연결', '새 조직 직후', '재개 직후']); // 서버 방송(crew_sync 포함)이 닿는 상태 — 즉시여야 한다

for (const state of STATES) {
  test(`${state}: 글 종류 8가지 모두 ${BROADCAST_REACHES.has(state) ? '즉시' : '15초 이내'}(종전보다 늦지 않다)`, async () => {
    const quiet = [console.error, console.warn, console.log]; console.error = console.warn = console.log = () => {};
    const got = {};
    try {
      for (const kind of KINDS) {
        if (kind === '중단' && !BROADCAST_REACHES.has(state)) continue; // 아래 주석 — 돌리지 않는다(못 받은 방송을 200초 기다릴 뿐)
        const ws = await fresh();
        mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
        try { got[kind] = await latencyCell(M, { kind, state, offset: 7_500, mock, ws }); } finally { mock.timers.reset(); M.wakeProtocolCache.at = -Infinity; }
      }
    } finally { [console.error, console.warn, console.log] = quiet; }
    for (const kind of KINDS) {
      // 중단은 방송 처리기 직행이다(조회로 대신하지 않는 경로 — 이 PR이 바꾸지 않았다). 구독이 안 붙은 순간의 중단 방송은 종전·이번 모두 못 받는다 → 그 칸은 비교표에서 '둘 다 못 받음'
      if (kind === '중단' && !BROADCAST_REACHES.has(state)) continue;
      const limit = BROADCAST_REACHES.has(state) ? 0 : 15_000;
      assert.ok(got[kind] <= limit, `${state}/${kind}: ${got[kind]}ms(한도 ${limit}ms) — ${JSON.stringify(got)}`);
    }
  });
}

test('옛 서버(깨우기 방송 표지 없음)에서는 쉬지 않는다 — 재개 직후 공개 채널 글도 15초 이내(종전과 같은 조회)', async () => {
  const ws = await fresh();
  const quiet = [console.error, console.warn, console.log]; console.error = console.warn = console.log = () => {};
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  try {
    const ms = await latencyCell(M, { kind: '공개 채널', state: '재개 직후', offset: 7_500, mock, ws, serverWakes: false });
    assert.ok(ms <= 15_000, `${ms}ms`);
  } finally { mock.timers.reset(); [console.error, console.warn, console.log] = quiet; }
});
