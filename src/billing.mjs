// 금액 표면의 단일 게이트 — 모든 "돈" 집계는 이 모듈을 통해서만 쓴다 (2026-07-27 확정).
//
// 판정(usage.mjs rowBilled — 우선순위 순):
//   ① 행에 billed 각인이 있으면 그대로 (턴 시점 사실 — 자격 전환에도 과거 지출·구독 기록 불변)
//   ② 각인 없는 레거시 행: 그 행 러너의 **현재 자격이 apikey**(또는 호스트 env 키 폴백)일 때만 청구
// v0.1.29의 "표지 없는 옛 행 = 청구" 소급 보수가 구독 전용 회사에 잔존 금액을 계속 표시하는
// 신고를 낳았다(재발 2026-07-27). ①의 양방향 각인으로 신규 행은 불변 사실이 되고,
// ②의 휴리스틱은 레거시 행에만 적용돼 시간이 갈수록 0으로 수렴한다.
//
// 배선 규칙(트립와이어가 잠근다): 프로덕션 소비자(라우트·chat·compete)는 usage.mjs의 금액
// 집계를 직접 import하지 않는다 — 이 모듈의 동명 함수를 쓴다. 예외는 runners.mjs 하나
// (순환: billing→runners라 역방향 불가): 거기서는 billedRunnerMap(같은 함수)을 직접 쓴다.
// 자격 파일 손상은 조용히 0으로 누르지 않고 throw로 드러난다(billedRunnerMap 주석 참조).
import { billedRunnerMap } from './runners.mjs';
import * as usage from './usage.mjs';

export async function readUsageSummary(wsId) { return usage.readUsageSummary(wsId, await billedRunnerMap(wsId)); }
export async function agentStats(wsId, slug) { return usage.agentStats(wsId, slug, await billedRunnerMap(wsId)); }
export async function monthCostByCrew(wsId) { return usage.monthCostByCrew(wsId, await billedRunnerMap(wsId)); }
export async function monthCost(wsId) { return usage.monthCost(wsId, await billedRunnerMap(wsId)); }
