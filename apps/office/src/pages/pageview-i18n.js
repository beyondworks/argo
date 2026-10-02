// 페이지 보기 사전 — 그 화면과 함께 지연 로드된다(첫 화면 150KB 상한, 7차 bundle.md ①). 원래 core/i18n.js에 있던 값을 그대로 옮겼다
export const PAGEVIEW_DICT = {
  'page.missing': ['페이지를 찾을 수 없습니다', 'Page not found'], 'page.edited': ['{when} 수정', 'Edited {when}'], 'tpl.start': ['템플릿에서 시작', 'Start from a template'],
  'tpl.basic': ['기본', 'Basics'], 'tpl.intranet': ['업무 기록', 'Work records'], 'tpl.org': ['조직', 'Organization'], 'tpl.mine': ['내 것', 'Mine'],
  'tpl.edit': ['템플릿 편집', 'Edit template'], 'tpl.readOnly': ['조직 템플릿은 관리자가 고칩니다', 'Admins edit org templates'],
  'tpl.editing': ['템플릿입니다. 여기서 고친 내용은 이 템플릿으로 새로 만드는 페이지에 들어갑니다', 'This is a template. Changes apply to new pages made from it'],
  'page.dropFiles': ['파일을 놓으면 이 페이지에 올립니다(최대 50MB)', 'Drop files to upload to this page (max 50MB)'],
  'page.uploaded': ['{n}개 파일을 올렸습니다', 'Uploaded {n} files'],
  'page.restrictedNote': ['관리자와 지정한 사람만 볼 수 있습니다', 'Only admins and invited people can see this'],
  'page.conflictHint': ['새로 불러오면 내 변경은 사라집니다. 내 변경을 지키려면 사본으로 저장하세요.', 'Reloading discards your changes. Save them as a copy to keep them.'],
  'page.conflictCopy': ['내 변경을 사본으로 저장', 'Save my changes as a copy'], 'page.copySaved': ['사본으로 저장했습니다', 'Saved as a copy'],
};
