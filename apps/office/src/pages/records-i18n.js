// 기록 화면(문서·진행 중인 일·일지) 사전 — 그 화면과 함께 지연 로드된다(첫 화면 150KB 상한, 7차 bundle.md ①). 원래 core/i18n.js에 있던 값을 그대로 옮겼다
export const RECORDS_DICT = {
  'docs.sub': ['에이전트가 함께 쓰는 규칙·용어·프로젝트 문서', 'Rules, glossary and project docs your agents share'], 'docs.rules': ['규칙', 'Rules'],
  'docs.glossary': ['용어', 'Glossary'], 'docs.projects': ['프로젝트', 'Projects'], 'docs.sharedEmpty': ['아직 공용 문서가 없습니다', 'No shared docs yet'], 'docs.bodyEmpty': ['내용이 없는 문서입니다', 'This doc is empty'], // docs.empty는 견적·계약 화면(docs/docs-i18n.js) 것 — 같은 키로 두면 나중에 연 화면 문구가 덮었다
  'docs.readOnly': ['공용 문서는 메신저에서 고칩니다(바꿀 때 결재를 거칩니다)', 'Edit shared docs in the messenger (changes go through approval)'],
  'docs.search': ['제목으로 찾기', 'Search by title'], 'docs.noMatch': ['맞는 문서가 없습니다', 'No matching docs'], 'docs.found': ['{n}개 / {total}개', '{n} of {total}'],
  'risk.medium': ['확인', 'Review'], 'risk.low': ['가벼운 일', 'Light task'], 'col.goal': ['목표', 'Goal'], 'col.lead': ['맡은 에이전트', 'Lead'],
  'col.status': ['상태', 'Status'], 'col.progress': ['단계', 'Steps'], 'col.started': ['시작', 'Started'], 'col.channel': ['채널', 'Channel'],
  'col.result': ['결과', 'Result'], 'col.by': ['결정한 사람', 'Decided by'],
  'file.noPreview': ['여기서 미리 볼 수 없는 파일입니다. 다운로드해서 열어 주세요.', "This file can't be previewed here. Download it to open."],
  'file.tooBig': ['파일이 커서 미리 보지 않습니다. 다운로드해서 열어 주세요.', 'This file is too large to preview. Download it to open.'],
  'file.fail': ['파일을 불러오지 못했습니다.', 'Could not load the file.'], 'file.sample': ['예시 데이터라 실제 파일이 없습니다.', 'This is sample data, so there is no real file.'],
  'file.openNew': ['새 창에서 열기', 'Open in a new window'], 'work.done': ['끝나는 기준', 'Done when'], 'journal.more': ['{n}건 더 보기', 'Show {n} more'],
  'work.crewDetail': ['{crew} 자세히 보기', 'View {crew}'], // 에이전트 작업 폴더에서 에이전트 상세로(17차)
};
