// 업무 사전 등록 — 업무 화면(BusinessPage·HomeChart·HomeModules·ModuleLibrary)이 이 파일을 가져오는 순간
// biz.*/bizui.*/mkt.* 전체가 core/i18n.js의 DICT에 합류한다. core/i18n.js는 이 셋을 정적으로 갖지 않는다
// (첫 화면 150KB 상한, 유건 9/26) — 홈 보드에도 꼭 필요한 몇 개(biz.loading 등)는 core/i18n.js에 그대로 있다.
import { registerDict } from '../core/i18n.js';
import { BUSINESS_DICT } from './i18n.js';
import { BUSINESS_UI_DICT } from './ui-i18n.js';
import { MARKETING_DICT } from './marketing-i18n.js';

registerDict({ ...BUSINESS_DICT, ...BUSINESS_UI_DICT, ...MARKETING_DICT });
