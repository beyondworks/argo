// 페이지 보기 사전 — 그 화면과 함께 지연 로드된다(첫 화면 150KB 상한, 7차 bundle.md ①). 원래 core/i18n.js에 있던 값을 그대로 옮겼다
export const PAGEVIEW_DICT = {
  'page.missing': ['페이지를 찾을 수 없습니다', 'Page not found'], 'page.edited': ['{when} 수정', 'Edited {when}'], 'tpl.start': ['템플릿에서 시작', 'Start from a template'],
  'tpl.basic': ['기본', 'Basics'], 'tpl.intranet': ['업무 기록', 'Work records'], 'tpl.org': ['조직', 'Organization'], 'tpl.mine': ['내 것', 'Mine'],
  'tpl.edit': ['템플릿 편집', 'Edit template'], 'tpl.readOnly': ['조직 템플릿은 관리자가 고칩니다', 'Admins edit org templates'],
  'tpl.editing': ['템플릿입니다. 여기서 고친 내용은 이 템플릿으로 새로 만드는 페이지에 들어갑니다', 'This is a template. Changes apply to new pages made from it'],
  'page.dropFiles': ['놓으면 문서함에 저장하고 이 자리에 넣습니다', 'Drop to save in Files and place it here'],
  'page.uploaded': ['{n}개 파일을 문서함에 저장하고 페이지에 넣었습니다', 'Saved {n} files to Files and added them to this page'], 'page.uploading': ['올리는 중…', 'Uploading…'],
  'page.notPlaced': ['문서함에 저장했지만 페이지에 넣지 못했습니다 — 문서함에서 찾을 수 있습니다', 'Saved to Files but couldn’t add it to this page — find it in Files'],
  'page.restrictedNote': ['관리자와 지정한 사람만 볼 수 있습니다', 'Only admins and invited people can see this'],
  'page.conflictHint': ['새로 불러오면 내 변경은 사라집니다. 내 변경을 지키려면 사본으로 저장하세요.', 'Reloading discards your changes. Save them as a copy to keep them.'],
  'page.conflictGone': ['그사이 서버에서 지워졌거나 볼 수 없게 된 페이지입니다. 내 변경은 이 기기에 남아 있습니다 — 내 공간에 사본으로 저장하거나 버리세요.', 'This page was deleted on the server or you can no longer see it. Your changes are still on this device — save them as a copy in My space or discard them.'],
  'page.conflictDrop': ['내 변경 버리기', 'Discard my changes'],
  'page.conflictCopy': ['내 변경을 사본으로 저장', 'Save my changes as a copy'], 'page.copySaved': ['사본으로 저장했습니다', 'Saved as a copy'],
};
