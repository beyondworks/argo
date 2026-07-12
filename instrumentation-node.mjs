// nodejs 런타임 전용 부팅 코드 — instrumentation.js의 NEXT_RUNTIME 분기 안에서만 로드된다.
// (별도 파일인 이유: 엣지 번들(미들웨어 존재 시)이 node: 빌트인을 끌고 가지 않도록 정적 분리)
import { ensureScheduler } from './src/scheduler.mjs';
import { ensureGateway } from './src/gateway.mjs';

ensureScheduler();
ensureGateway();
