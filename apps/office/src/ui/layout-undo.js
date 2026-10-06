// 배치 되돌리기·다시 하기 알림(유건 10/2 7차 4) — 처음 되돌릴 때 받는다(첫 화면 150KB 상한). 기록·키 판정·적용은 core/history.js.
import { t, registerDict } from '../core/i18n.js';
import { showToast } from './Overlay.jsx';
import { UNDO_DICT } from './grid-i18n.js';

registerDict(UNDO_DICT);
/** 되돌렸다(다시 했다) — 토스트가 role=status라 스크린리더에도 읽힌다 */
export const done = (redo) => showToast(t(redo ? 'layout.redone' : 'layout.undone'));
