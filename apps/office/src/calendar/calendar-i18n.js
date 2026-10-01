// 일정 화면 사전 — 달력 화면·홈 '다가오는 일정' 모듈(여러 보기)과 함께 지연 로드된다(첫 화면 150KB 상한). 메뉴 이름(nav.calendar)·모듈 제목(mod.calendar)만 core/i18n.js에 있다.
export const CAL_DICT = {
  'cal.rail': ['캘린더 목록', 'Calendars panel'], 'cal.create': ['만들기', 'Create'], 'cal.today': ['오늘', 'Today'], 'cal.prev': ['이전', 'Previous'], 'cal.next': ['다음', 'Next'],
  'cal.prevMonth': ['이전 달', 'Previous month'], 'cal.nextMonth': ['다음 달', 'Next month'], 'cal.loading': ['불러오는 중…', 'Loading…'],
  'cal.colorBy': ['색', 'Color'], 'cal.c.category': ['분류', 'Category'], 'cal.c.person': ['사람', 'Person'], 'cal.c.agent': ['에이전트', 'Agent'],
  'cal.calendars': ['캘린더', 'Calendars'], 'cal.overlays': ['함께 보기', 'Also show'], 'cal.cal.me': ['내 일정', 'My calendar'], 'cal.cal.org': ['조직 일정', 'Team calendar'], 'cal.cal.mine': ['내 일정(주인·참석)', 'Mine (owner or attending)'],
  'cal.tasks': ['할 일 기한', 'To-do due dates'], 'cal.holidays': ['공휴일', 'Holidays'],
  'cal.allDay': ['종일', 'All day'], 'cal.more': ['+{n}개 더', '+{n} more'], 'cal.nItems': ['{n}건', '{n} items'],
  'cal.taskDue': ['할 일 기한: {title}', 'To-do due: {title}'], 'cal.taskRow': ['할 일 기한 — 눌러서 할 일 보기', 'To-do due date — open the to-do'], 'cal.due': ['기한', 'Due'],
  'cal.dayEmpty': ['이날 일정이 없습니다', 'Nothing on this day'],
  'cal.custUnknown': ['거래처', 'Customer'],
  'cal.quick': ['새 일정', 'New event'], 'cal.new': ['새 일정', 'New event'], 'cal.edit': ['일정 수정', 'Edit event'], 'cal.view.title': ['일정', 'Event'],
  'cal.details': ['자세히', 'More options'], 'cal.save': ['저장', 'Save'], 'cal.cancel': ['취소', 'Cancel'], 'cal.close': ['닫기', 'Close'], 'cal.delete': ['삭제', 'Delete'],
  'cal.saved': ['일정을 저장했습니다', 'Event saved'], 'cal.deleted': ['일정을 삭제했습니다', 'Event deleted'],
  'cal.titleHint': ['제목 추가', 'Add title'], 'cal.categoryHint': ['예: 회의·영업·출장', 'e.g. Meeting, Sales, Trip'],
  'cal.f.title': ['제목', 'Title'], 'cal.f.start': ['시작', 'Starts'], 'cal.f.end': ['끝', 'Ends'], 'cal.f.repeat': ['반복', 'Repeat'], 'cal.f.interval': ['간격', 'Every'], 'cal.f.until': ['끝나는 날(비우면 계속)', 'Ends on (blank = never)'],
  'cal.f.calendar': ['캘린더', 'Calendar'], 'cal.f.visibility': ['공개 범위', 'Visibility'], 'cal.f.attendees': ['참석자', 'Attendees'], 'cal.f.category': ['분류', 'Category'], 'cal.f.customer': ['거래처', 'Customer'], 'cal.f.location': ['장소', 'Location'], 'cal.f.note': ['메모', 'Notes'],
  'cal.r.none': ['반복 안 함', 'Does not repeat'], 'cal.r.DAILY': ['매일', 'Daily'], 'cal.r.WEEKLY': ['매주 {w}', 'Weekly on {w}'], 'cal.r.MONTHLY': ['매월 {n}일(없는 달은 건너뜀)', 'Monthly on day {n} (skips short months)'],
  'cal.unit.DAILY': ['일마다', 'day(s)'], 'cal.unit.WEEKLY': ['주마다', 'week(s)'], 'cal.unit.MONTHLY': ['개월마다', 'month(s)'],
  'cal.vis.org': ['조직 전체', 'Whole team'], 'cal.vis.private': ['나만', 'Only me'], 'cal.noCustomer': ['연결 안 함', 'None'], 'cal.me': ['나', 'Me'],
  'cal.byAgent': ['{name}(에이전트)가 만들었거나 고친 일정', 'Created or edited by agent {name}'], 'cal.agent': ['에이전트', 'Agent'], 'cal.owner': ['주인: {name}', 'Owner: {name}'],
  'cal.readOnly': ['일정 주인과 조직 관리자만 고칠 수 있습니다. 보기만 할 수 있어요.', 'Only the owner and team admins can edit this event.'],
  'cal.saveRepeat': ['반복 일정 수정', 'Edit recurring event'], 'cal.deleteRepeat': ['반복 일정 삭제', 'Delete recurring event'], 'cal.deleteOne': ['일정 삭제', 'Delete event'],
  'cal.deleteBody': ['삭제하면 되돌릴 수 없습니다.', 'This can’t be undone.'],
  'cal.scope.one': ['이 일정만', 'This event'], 'cal.scope.following': ['이 일정 및 이후 일정', 'This and following events'], 'cal.scope.all': ['모든 일정', 'All events'],
  'cal.error.title': ['제목을 입력하세요', 'Add a title'], 'cal.error.time': ['끝이 시작보다 뒤여야 합니다', 'End must be after start'], 'cal.error.until': ['반복이 끝나는 날은 시작일 뒤여야 합니다', 'Repeat end must be after the start'],
  'cal.error.forbidden': ['이 일정을 고칠 권한이 없습니다', 'You can’t change this event'], 'cal.error.invalid': ['입력값을 확인해 주세요', 'Check the details and try again'],
  'cal.error.missing': ['일정을 찾을 수 없습니다. 이미 지워졌을 수 있습니다', 'Event not found — it may have been deleted'], 'cal.error.limit': ['올해 만들 수 있는 일정 수를 넘었습니다', 'You’ve reached this year’s event limit'],
  'cal.error.signin': ['다시 로그인한 뒤 시도해 주세요', 'Sign in again and retry'], 'cal.error.request': ['일정을 불러오거나 저장하지 못했습니다. 잠시 뒤 다시 해 주세요', 'Couldn’t load or save events. Try again shortly'],
  'cal.holi.sub': ['쉬는 날 {name}', 'Substitute holiday: {name}'],
  'holi.새해첫날': ['새해첫날', 'New Year’s Day'], 'holi.설날': ['설날', 'Seollal'], 'holi.설날 연휴': ['설날 연휴', 'Seollal holiday'], 'holi.삼일절': ['삼일절', 'Independence Movement Day'],
  'holi.식목일': ['식목일', 'Arbor Day'], 'holi.노동절': ['노동절', 'Labor Day'], 'holi.부처님오신날': ['부처님오신날', 'Buddha’s Birthday'], 'holi.어린이날': ['어린이날', 'Children’s Day'],
  'holi.어버이날': ['어버이날', 'Parents’ Day'], 'holi.스승의날': ['스승의날', 'Teachers’ Day'], 'holi.대통령 선거': ['대통령 선거', 'Presidential election'], 'holi.지방선거일': ['지방선거일', 'Local elections'],
  'holi.현충일': ['현충일', 'Memorial Day'], 'holi.제헌절': ['제헌절', 'Constitution Day'], 'holi.광복절': ['광복절', 'Liberation Day'], 'holi.국군의날': ['국군의날', 'Armed Forces Day'],
  'holi.추석': ['추석', 'Chuseok'], 'holi.추석 연휴': ['추석 연휴', 'Chuseok holiday'], 'holi.개천절': ['개천절', 'National Foundation Day'], 'holi.한글날': ['한글날', 'Hangul Day'],
  'holi.크리스마스 이브': ['크리스마스 이브', 'Christmas Eve'], 'holi.크리스마스': ['크리스마스', 'Christmas'], 'holi.섣달 그믐날': ['섣달 그믐날', 'New Year’s Eve'],
};

const SUB = '쉬는 날 ';
/** 공휴일 표의 이름(한국어 원본) → 지금 언어. 대체공휴일은 '쉬는 날 ○○' 모양. 사전에 없는 새 이름은 원본 그대로 */
export function holidayName(name, t) {
  const tr = (n) => { const k = `holi.${n}`, v = t(k); return v === k ? n : v; };
  return name.startsWith(SUB) ? t('cal.holi.sub', { name: tr(name.slice(SUB.length)) }) : tr(name);
}
