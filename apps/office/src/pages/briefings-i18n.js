// 브리핑 화면 사전 — 화면과 함께 지연 로드된다(첫 화면 150KB 상한). 메뉴·홈 모듈 이름(nav.briefings·mod.briefing)만 core/i18n.js에 있다
export const BRIEFINGS_DICT = {
  'brief.sub': ['에이전트가 나에게 보낸 브리핑과 조직 전체 브리핑이 여기 모입니다', 'Briefings your agents sent you and briefings for your whole organization'],
  'brief.search': ['제목·내용으로 찾기', 'Search title and content'],
  'brief.empty': ['아직 받은 브리핑이 없습니다. 에이전트에게 "오늘 브리핑 써 줘"라고 요청해 보세요.', 'No briefings yet. Ask an agent to "write today\'s briefing".'],
  'brief.noMatch': ['맞는 브리핑이 없습니다', 'No matching briefings'],
  'brief.more': ['더 보기', 'Show more'], 'brief.loading': ['불러오는 중…', 'Loading…'],
  'brief.orgWide': ['조직 전체', 'Whole organization'], 'brief.personal': ['내 공간', 'My space'],
  'brief.kind.daily': ['일간', 'Daily'], 'brief.kind.weekly': ['주간', 'Weekly'], 'brief.kind.custom': ['맞춤', 'Custom'],
  'brief.delete': ['지우기', 'Delete'], 'brief.deleteTitle': ['브리핑을 지울까요?', 'Delete this briefing?'],
  'brief.deleteBody': ['지운 브리핑은 되살릴 수 없습니다.', 'A deleted briefing cannot be restored.'],
  'brief.deleteOrgBody': ['조직 전체 브리핑이라 구성원 모두의 목록에서 사라집니다. 지운 브리핑은 되살릴 수 없습니다.', 'This is an organization-wide briefing, so it disappears for every member. It cannot be restored.'],
  'brief.deleted': ['브리핑을 지웠습니다', 'Briefing deleted'],
  'brief.err.missing': ['없거나 볼 수 없는 브리핑입니다', 'This briefing does not exist or is not visible to you'],
  'brief.err.forbidden': ['조직 전체 브리핑은 그 조직 관리자만 지울 수 있습니다', 'Only an admin of that organization can delete an organization-wide briefing'],
  'brief.err.load': ['브리핑을 불러오지 못했습니다', 'Could not load briefings'],
};
