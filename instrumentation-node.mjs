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
