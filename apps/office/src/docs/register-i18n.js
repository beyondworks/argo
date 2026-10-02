// 견적·계약·전자서명 사전 등록 — 이 화면(지연 로드)이 가져오는 순간 core/i18n.js에 합류한다(첫 화면 150KB 상한).
import { registerDict } from '../core/i18n.js';
import { DOCS_DICT } from './docs-i18n.js';
registerDict(DOCS_DICT);
