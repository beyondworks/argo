// 메신저 v2 U6d — 방·공간·초대·안 읽음·검색·1:1 목록·방 설정(msgr2만 적용한 판 + 적용/되돌림 비교). 본문은 helpers/msgr2-rooms-cases.mjs.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-rooms-pg.test.mjs
import { run } from './helpers/msgr2-rooms-cases.mjs';
run('msgr2');
