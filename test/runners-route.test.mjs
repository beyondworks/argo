// /api/runners의 autoRunnerId 판정 계약 — 분리 검수(PR #209)가 실증한 갭: "값은 계산하되 응답에
// null 고정"류 변이를 소스문자열 테스트가 침묵 통과했다. 라우트 GET 실호출은 auth 계층의
// next/headers(런타임 전용) 정적 import 때문에 Next 밖에서 원리적으로 불가 — 판정을 순수 함수
// (autoRunnerOf)로 추출해 실 회사 상태(runnerStatus)로 잠근다. 함수→응답 배선은 여기서 못 잠근다
// (라우트가 autoRunnerOf를 안 쓰게 되돌리면 이 테스트는 침묵한다) — 그 마지막 구간은 분리 검수의
// 라이브 확인 영역으로 남는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉).
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-runroute-'));

const { runnerStatus, pickRunner, autoRunnerOf } = await import('../src/runners.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');

const WS = 'demo';
await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
await writeFile(
  join(process.env.ARGO_ROOT, WS, 'company.json'),
  JSON.stringify({ id: WS, name: '데모', created: '2026-07-31T00:00:00Z' }),
);

test('autoRunnerOf: 연결 0(호스트 감지만) → null — 스캐빈징 금지와 동일 판정', async () => {
  assert.equal(autoRunnerOf(await runnerStatus(WS)), null);
  assert.equal(autoRunnerOf(null), null, '회사 상태 자체가 없으면(ws 미지정) null');
});

test('autoRunnerOf: 러너 연결 → 턴이 실제로 집는 그 러너(pickRunner 동일 소스)', async () => {
  // glm apikey — saveRunnerCred 경로 중 프로비저닝·격리 홈 부작용이 없는 러너.
  await saveRunnerCred(WS, 'glm', 'apikey', 'test-glm-key');
  const company = await runnerStatus(WS);
  const direct = pickRunner(company, null);
  assert.equal(direct.available, true, '시드 전제: apikey 연결은 가용이어야 한다');
  assert.equal(autoRunnerOf(company), direct.runner, '판정은 pickRunner 그 자체여야 한다');
  assert.notEqual(autoRunnerOf(company), null);
});
