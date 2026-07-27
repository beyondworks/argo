// 금액 표면의 단일 게이트 — 모든 "돈" 집계는 이 모듈을 통해서만 쓴다 (2026-07-27 확정).
//
// 왜 — v0.1.29는 구독 턴에 billed:false 표지를 심어 금액에서 뺐지만, 표지가 없는 과거 행은
// "청구로 본다"로 남겨 구독 전용 회사 상단에 잔존 금액이 계속 표시됐다(실사용 신고 재발).
// 표지(과거 기록)에 기대는 한 이 계열은 못 죽는다. 그래서 판정을 뒤집는다:
//   행이 청구다 ⇔ (billed !== false) && (그 행 러너의 **현재 자격이 apikey**)
// 자격이 구독(oauth)·호스트 로그인·미연결이면 그 러너로는 돈이 나갈 경로 자체가 없다 —
// 과거 행이 무슨 표지든 금액이 아니다. 혼합 회사(claude 구독 + codex 키)도 러너별로 정확하다.
//
// 배선 규칙(트립와이어가 잠근다): 프로덕션 소비자(라우트·chat·compete)는 usage.mjs의 금액
// 집계를 직접 import하지 않는다 — 이 모듈의 동명 함수를 쓴다. 예외는 runners.mjs 하나
// (순환: billing→runners라 역방향 불가): 거기서는 isBilledRunner로 map을 직접 만들어 넘긴다.
import { RUNNERS, isBilledRunner } from './runners.mjs';
import * as usage from './usage.mjs';

/** { 러너id: 현재 자격이 apikey인가 } — rowBilled의 두 번째 인자. 실패는 false(금액 억제 방향). */
export async function billedRunnerMap(wsId) {
  const map = {};
  await Promise.all(Object.keys(RUNNERS).map(async (id) => {
    map[id] = await isBilledRunner(wsId, id).catch(() => false);
  }));
  return map;
}

export async function readUsageSummary(wsId) { return usage.readUsageSummary(wsId, await billedRunnerMap(wsId)); }
export async function agentStats(wsId, slug) { return usage.agentStats(wsId, slug, await billedRunnerMap(wsId)); }
export async function monthCostByCrew(wsId) { return usage.monthCostByCrew(wsId, await billedRunnerMap(wsId)); }
export async function monthCost(wsId) { return usage.monthCost(wsId, await billedRunnerMap(wsId)); }
