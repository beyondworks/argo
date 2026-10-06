// 페이지 트리 '이름 바꾸기'·'옮기기' 사전 — 누를 때 창 코드와 함께 받는다(첫 화면 150KB 상한). 메뉴 이름(page.rename·page.move)만 core/i18n.js에 있다(메뉴는 첫 화면).
export const TREE_DICT = {
  'tree.renameLabel': ['페이지 이름', 'Page name'], 'tree.renameTitle': ['이름 바꾸기', 'Rename'], 'tree.renameSave': ['바꾸기', 'Rename'], 'tree.cancel': ['취소', 'Cancel'],
  'tree.renameFail': ['페이지를 불러오지 못해 이름을 바꾸지 못했습니다. 다시 시도해 주세요', 'Could not load the page to rename it. Please try again'],
  'tree.moveTitle': ['"{title}" 옮기기', 'Move "{title}"'], 'tree.moveSearch': ['옮길 곳 찾기', 'Find a place'], 'tree.top': ['맨 위로(상위 없음)', 'Top level (no parent)'],
  'tree.here': ['지금 위치', 'Current'], 'tree.none': ['옮길 수 있는 곳이 없습니다', 'No place to move to'], 'tree.noMatch': ['맞는 페이지가 없습니다', 'No matching pages'],
  'tree.moved': ['"{title}" 아래로 옮겼습니다', 'Moved under "{title}"'], 'tree.movedTop': ['맨 위로 옮겼습니다', 'Moved to the top level'],
  'tree.moveHint': ['자기 자신과 하위 페이지로는 옮길 수 없습니다', "A page can't move into itself or its subpages"],
};
