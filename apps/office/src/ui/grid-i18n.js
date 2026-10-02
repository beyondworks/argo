// 모듈 옮기기 알림 사전(9차 블록 배치) — 옮기기 코드(module-move.js)와 함께 지연 로드된다(첫 화면 150KB 상한)
export const GRID_DICT = {
  'grid.pick': ['{name} 옮기는 중입니다. 위아래 화살표로 위아래, 좌우 화살표로 옆 열로 옮기고 Enter로 놓으세요. Esc를 누르면 취소됩니다.', 'Moving {name}. Use Up/Down to move up or down, Left/Right to move to a side column, Enter to drop, Esc to cancel.'],
  'grid.at': ['{row}번째 줄, {cols}열 중 {col}번째 열, 위에서 {n}번째', 'Row {row}, column {col} of {cols}, position {n} from the top'],
  'grid.row': ['{row}번째 줄, 전체 폭', 'Row {row}, full width'],
  'grid.edge': ['더 옮길 수 없습니다.', 'Cannot move further.'],
  'grid.drop': ['{name} 자리를 옮겼습니다.', 'Moved {name}.'],
  'grid.cancel': ['옮기기를 취소했습니다.', 'Move cancelled.'],
  // 고른 모듈 한꺼번에 옮기기(11차)
  'grid.pickN': ['모듈 {n}개를 들었습니다. 위아래 화살표로 위아래, 좌우 화살표로 옆 열로 옮기고 Enter로 놓으세요. Esc를 누르면 취소됩니다.', 'Picked up {n} modules. Use Up/Down to move up or down, Left/Right to move to a side column, Enter to drop, Esc to cancel.'],
  'grid.dropN': ['모듈 {n}개를 옮겼습니다.', 'Moved {n} modules.'],
};
// 모듈 맞춤 알림(유건 10/1 밤 6차) — 맞춤 코드(module-fit.js)와 함께 지연 로드된다
export const FIT_DICT = {
  'home.fitDone': ['모듈 높이를 맞췄습니다', 'Module heights fitted'],
  'home.fitSame': ['이미 맞춰져 있습니다', 'Already fitted'],
};
// 배치 되돌리기 알림(유건 10/2 7차 4) — 되돌리기 코드(layout-undo.js)와 함께 지연 로드된다
export const UNDO_DICT = {
  'layout.undone': ['배치를 되돌렸습니다', 'Layout change undone'],
  'layout.redone': ['배치를 다시 적용했습니다', 'Layout change redone'],
};
