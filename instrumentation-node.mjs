// nodejs 런타임 전용 부팅 코드 — instrumentation.js의 NEXT_RUNTIME 분기 안에서만 로드된다.
// (별도 파일인 이유: 엣지 번들(미들웨어 존재 시)이 node: 빌트인을 끌고 가지 않도록 정적 분리)
import { ensureScheduler } from './src/scheduler.mjs';
import { ensureGateway } from './src/gateway.mjs';
import { ensureSync } from './src/sync.mjs';

// 부모(데스크톱 셸) 감시 — 앱이 넘긴 ARGO_PARENT_PID가 사라지면 서버도 종료한다.
// Tauri 사이드카는 부모가 죽어도 자동 종료되지 않아(실측: macOS·Windows 공통) 고아 node가
// 3001을 계속 점유 → 다음 실행이 죽은/구버전 서버에 붙는 원인. Rust 종료 훅보다 확실한 크로스플랫폼 보험.
const parentPid = Number(process.env.ARGO_PARENT_PID);
if (parentPid > 0) {
  setInterval(() => {
    try { process.kill(parentPid, 0); } // signal 0 = 존재 확인만
    catch { process.exit(0); }          // 부모 없음 → 스스로 종료
  }, 2000).unref();
}

ensureScheduler();
ensureGateway();
ensureSync(); // C-1 기기 간 동기화 — env(서비스 키) 있을 때만 켜진다

// 고아 턴 스위퍼 — 이전 프로세스가 턴 도중 죽었으면(재배포·크래시) awaiting 지시를 정직한 실패
// 표시로 전환한다(무언 소멸 금지 — 실사고 2026-08-28). 몇 초 늦춰 부팅 경로를 막지 않는다.
setTimeout(() => { import('./src/orphan-turns.mjs').then((m) => m.sweepOrphanTurns()).catch(() => {}); }, 5000);

// 러너 감지 예열 — 이건 CLI 4종을 **프로세스로 띄워** 버전을 묻는 작업이라 콜드가 2.7초다(실측
// 2026-08-01). 화면은 페이지마다 러너 상태를 묻는데, 캐시가 비어 있으면 그 2.7초를 사용자가
// 그대로 기다린다("앱이 한 박자 느리다" 실사용 신고). 부팅 직후 한 번 데워두면 첫 진입부터 캐시가
// 산다. 실패는 무시한다 — 다음 요청이 어차피 다시 잰다.
import('./src/runners.mjs').then((m) => m.detectRunners()).catch(() => {});
