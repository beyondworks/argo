// 설정·휴지통·공유받은 항목 화면 사전 — 그 화면과 함께 지연 로드된다(첫 화면 150KB 상한, 7차 bundle.md ①). 원래 core/i18n.js에 있던 값을 그대로 옮겼다
export const MISC_DICT = {
  'settings.title': ['설정', 'Settings'], 'settings.theme': ['테마', 'Theme'], 'settings.lang': ['언어', 'Language'],
  'settings.mail': ['메일 계정', 'Mail accounts'], 'settings.reset': ['초안 예시 데이터 되돌리기', 'Reset sample data'],
  'settings.shortcuts': ['단축키', 'Keyboard shortcuts'], 'settings.mode': ['모드', 'Mode'], 'settings.shell': ['앱 셸', 'App shell'],
  'settings.color': ['색상', 'Color'], 'trash.title': ['휴지통', 'Trash'], 'trash.note': ['30일이 지나면 영구 삭제됩니다', 'Items are deleted permanently after 30 days'],
  'trash.restore': ['복원', 'Restore'], 'trash.empty': ['휴지통이 비어 있습니다', 'Trash is empty'], 'shared.title': ['공유받은 항목', 'Shared with me'],
  'shared.empty': ['공유받은 페이지가 없습니다', 'Nothing shared with you yet'], 'lang.ko': ['한국어', '한국어'], 'lang.en': ['English', 'English'],
  'public.missing': ['게시되지 않았거나 없는 페이지입니다', 'This page is not published or does not exist'],
  'public.madeWith': ['Argo Office로 만듦', 'Made with Argo Office'], 'settings.account': ['계정', 'Account'], 'settings.signOut': ['로그아웃', 'Sign out'],
};
