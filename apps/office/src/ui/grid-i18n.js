// 모듈 옮기기 알림 사전 — 옮기기 코드(module-move.js)와 함께 지연 로드된다(첫 화면 150KB 상한)
export const GRID_DICT = {
  'grid.pick': ['{name} 옮기는 중입니다. 화살표로 자리를 고르고 Enter로 놓으세요. Esc를 누르면 취소됩니다.', 'Moving {name}. Use the arrow keys to choose a spot, Enter to drop, Esc to cancel.'],
  'grid.at': ['{col}번째 열, 위에서 {n}번째 자리', 'Column {col}, position {n} from the top'],
  'grid.drop': ['{name} 자리를 옮겼습니다.', 'Moved {name}.'],
  'grid.cancel': ['옮기기를 취소했습니다.', 'Move cancelled.'],
};
// 모듈 맞춤 알림(유건 10/1 밤 6차) — 맞춤 코드(module-fit.js)와 함께 지연 로드된다
export const FIT_DICT = {
  'home.fitDone': ['모듈 높이를 맞췄습니다', 'Module heights fitted'],
  'home.fitSame': ['이미 맞춰져 있습니다', 'Already fitted'],
};
