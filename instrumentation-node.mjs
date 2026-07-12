// nodejs 런타임 전용 부팅 코드 — instrumentation.js의 NEXT_RUNTIME 분기 안에서만 로드된다.
// (별도 파일인 이유: 엣지 번들(미들웨어 존재 시)이 node: 빌트인을 끌고 가지 않도록 정적 분리)
import { ensureScheduler } from './src/scheduler.mjs';
import { ensureGateway } from './src/gateway.mjs';
import { ensureSync } from './src/sync.mjs';

ensureScheduler();
ensureGateway();
ensureSync(); // C-1 기기 간 동기화 — env(서비스 키) 있을 때만 켜진다
