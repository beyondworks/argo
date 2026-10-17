// 메신저 v2 U6d — 옛 msgr 전체 + msgr2를 운영 순서로 적용하고 옛 중단 장치를 켠 판(운영과 같은 상태). 옛 표 접점(중단 통과·FK·신고)은 이 판에서만 본다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-rooms-legacy-combo-pg.test.mjs
import { run } from './helpers/msgr2-rooms-cases.mjs';
run('full');
