// 다국어 — 모든 화면 문자열은 이 사전으로만(프로젝트 규칙). [ko, en] 쌍, 언어는 argo-lang(메신저와 같은 키).
// 업무(business) 사전(biz.*/bizui.*/mkt.*의 대부분)은 업무 화면과 함께 지연 로드된다(registerDict, 첫 화면 150KB 상한 —
// 유건 9/26). 아래 biz.loading·biz.metric.*·biz.chart.*·bizui.{customers..analytics}는 홈 보드의 모듈 카드 제목·
// 지연 로드 중 안내문에 쓰여 업무 화면이 뜨기 전에도 필요하므로 여기 그대로 둔다(정본은 여기 하나뿐).
import { useSyncExternalStore } from 'react';

let EXTRA = {};
/** 업무 화면(HomeChart·BusinessPage·HomeModules·ModuleLibrary)이 뜰 때 업무 사전을 등록한다 — src/business/register-i18n.js */
export function registerDict(extra) { EXTRA = { ...EXTRA, ...extra }; }

const DICT = {
  'biz.loading': ['불러오는 중…', 'Loading…'],
  'biz.metric.sales': ['매출', 'Sales'], 'biz.metric.invoiced': ['청구한 돈', 'Invoiced'], 'biz.metric.paid': ['받은 돈', 'Received'], 'biz.metric.receivable': ['받을 돈', 'To collect'],
  'biz.chart.kpi': ['현황 숫자', 'Metric'], 'biz.chart.line': ['추이', 'Line'], 'biz.chart.bar': ['막대', 'Bar'], 'biz.chart.donut': ['서비스·상품 구성', 'Service/product mix'], 'biz.chart.table': ['거래 목록', 'Transactions'],
  'bizui.customers': ['거래처', 'Customers'], 'bizui.catalog': ['상품·서비스', 'Products & services'],
  'bizui.orders': ['거래', 'Transactions'], 'bizui.inventory': ['재고', 'Inventory'],
  'bizui.payments': ['청구·입금', 'Billing & payments'], 'bizui.analytics': ['분석', 'Analytics'],
  'home.layoutBlocked': ['홈 배치를 저장하지 못했습니다. 홈에서 최신 배치를 불러온 뒤 다시 시도하세요.', 'Could not save the home layout. Reload the latest layout on Home and try again.'],
  'home.layoutConflict': ['다른 곳에서 배치가 변경되었습니다. 내 변경은 이 기기에 보관되어 있으며, 최신 배치를 불러오면 다시 편집할 수 있습니다.', 'This layout changed elsewhere. Your changes are preserved on this device. Reload the latest layout to resume editing.'],
  'home.layoutLoading': ['최신 홈 배치를 불러온 뒤 편집할 수 있습니다.', 'Load the latest home layout before editing.'],
  'home.reloadFailed': ['홈 배치를 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.', 'Could not load the home layout. Check your connection and try again.'],
  'recovery.preserved': ['이전 버전의 작업을 이 기기에 보관했습니다.', 'Work from the previous version is preserved on this device.'],
  'recovery.draft': ['계정을 확인할 수 없는 초안과 미전송 작업 {n}건은 자동으로 전송하지 않습니다.', 'A draft and {n} pending operations with an unknown account will not be sent automatically.'],
  'recovery.pending': ['계정을 확인할 수 없는 미전송 작업 {n}건은 자동으로 전송하지 않습니다.', '{n} pending operations with an unknown account will not be sent automatically.'],
  'library.title': ['모듈 보관함', 'Module library'],
  'library.addModule': ['모듈 추가', 'Add module'],
  'library.browse': ['보관함에서 추가', 'Add from library'],
  'library.permission': ['이 위치에 모듈을 추가할 권한이 없습니다.', 'You cannot add modules at this destination.'],
  'library.sourcePermission': ['이 모듈의 원본 공간에 접근할 권한이 없습니다.', 'You do not have access to this module’s source workspace.'],
  'library.loadFailed': ['페이지를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.', 'Could not load the page. Refresh and try again.'],
  'library.titleRequired': ['새 페이지의 제목을 입력하세요.', 'Enter a title for the new page.'],
  'library.invalid': ['모듈 설정을 확인해 주세요.', 'Check the module settings.'],
  'library.unavailable': ['현재 사용할 수 없는 모듈입니다.', 'This module is unavailable.'],
  'bizui.marketing': ['마케팅', 'Marketing'],
  'bizui.performance': ['마케팅 성과', 'Marketing results'],
  'nav.business': ['업무', 'Business'],
  'info.basis': ['집계 기준', 'How this is counted'],
  'biz.home.utc': ['한국 날짜 기준', 'Korea (KST) dates'],
  'biz.home.balanceThrough': ['받을 돈은 종료일까지 청구한 돈에서 받은 돈을 뺀 금액입니다.', 'To collect is what you invoiced minus what you received, through the end date.'],
  'desktop.returnHint': ['Argo Office 앱에서 메일 연결을 마무리하세요.', 'Finish connecting your mail account in Argo Office.'],
  'desktop.return': ['Argo Office로 돌아가기', 'Return to Argo Office'],
  'desktop.loginWaiting': ['브라우저에서 로그인한 뒤 앱으로 돌아오세요.', 'Sign in in your browser, then return to the app.'],
  'desktop.loginTimeout': ['로그인 대기 시간이 지났습니다. 다시 시도하세요.', 'Sign-in timed out. Please try again.'],
  'desktop.cancel': ['취소', 'Cancel'],
  'desktop.relayFailed': ['연결 결과를 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.', 'Could not retrieve the connection result. Check your internet connection and retry.'],
  'desktop.retry': ['다시 시도', 'Retry'],
  'app.name': ['Argo Office', 'Argo Office'],
  'space.me': ['내 공간', 'My space'],
  'space.switch': ['공간 전환', 'Switch space'],
  'space.members': ['멤버 {n}명', '{n} members'],
  'space.role.owner': ['소유자', 'Owner'], 'space.role.admin': ['관리자', 'Admin'], 'space.role.member': ['멤버', 'Member'],
  'nav.search': ['검색 및 명령', 'Search and commands'],
  'nav.home': ['홈', 'Home'], 'nav.calendar': ['캘린더', 'Calendar'], 'nav.mail': ['메일', 'Mail'], 'nav.shared': ['공유받은 항목', 'Shared with me'],
  'nav.work': ['에이전트 작업', 'Agent work'], 'nav.approvals': ['결재함', 'Approvals'], 'nav.decisions': ['결정 기록', 'Decisions'],
  'nav.outputs': ['산출물', 'Deliverables'], 'nav.journal': ['에이전트 일지', 'Agent journal'], 'nav.docs': ['공용 문서', 'Shared docs'], 'nav.perf': ['성과 기록', 'Performance record'], 'nav.knowhow': ['스킬', 'Skills'],
  'nav.hide': ['메뉴에서 숨기기', 'Hide from menu'], 'nav.homeFixed': ['홈은 숨길 수 없습니다', 'Home can’t be hidden'], 'nav.hiddenN': ['숨긴 메뉴 {n}', '{n} hidden'], 'nav.hiddenHead': ['눌러서 다시 보이기', 'Click to show again'],
  'nav.saveFail': ['순서를 저장하지 못했습니다. 잠시 뒤 다시 해 주세요.', 'Could not save the order. Try again shortly.'],
  'nav.sec.menu': ['메뉴', 'Menu'], 'nav.sec.pages': ['페이지', 'Pages'], 'nav.sec.crews': ['에이전트', 'Agents'], 'nav.secUp': ['칸을 위로', 'Move section up'], 'nav.secDown': ['칸을 아래로', 'Move section down'],
  'nav.pages': ['페이지', 'Pages'], 'nav.wiki': ['조직 위키', 'Wiki'], 'nav.crews': ['에이전트', 'Agents'],
  // 좌측 크루 목록 정리(9/30)
  'crew.group.pinned': ['고정', 'Pinned'], 'crew.group.mine': ['내 에이전트', 'My agents'],
  'fav.title': ['즐겨찾기', 'Favorites'], 'fav.add': ['즐겨찾기에 추가', 'Add to favorites'], 'fav.remove': ['즐겨찾기에서 빼기', 'Remove from favorites'], 'fav.empty': ['☆를 누르거나 우클릭해 추가', 'Click ☆ or right-click to add'],
  'crew.owner.me': ['내 에이전트', 'Mine'], 'crew.owner.company': ['회사', 'Company'], 'crew.owner.unknown': ['이름 없음', 'Unnamed'],
  'crew.tip.job': ['직무: {job}', 'Role: {job}'], 'crew.tip.dept': ['부서: {dept}', 'Department: {dept}'], 'crew.tip.owner': ['주인: {name}', 'Owner: {name}'], 'crew.tip.noJob': ['직무가 적혀 있지 않습니다', 'No role set'],
  'crew.search': ['에이전트 찾기', 'Find agents'],
  'crew.pin': ['고정', 'Pin'], 'crew.unpin': ['고정 풀기', 'Unpin'], 'crew.saveFail': ['저장하지 못했습니다. 잠시 뒤 다시 해 주세요.', "Couldn't save. Try again shortly."],
  'crew.none': ['맞는 에이전트가 없습니다', 'No matching agents'],
  'crew.viaChannel': ['{crew}은(는) 메신저 채널에서 @{crew}로 불러 일을 시킬 수 있습니다. 오피스에서 바로 맡기기는 내 에이전트만 됩니다.', 'Mention @{crew} in a Messenger channel to use this agent. Direct hand-off from Office works with your own agent only.'],
  'nav.trash': ['휴지통', 'Trash'], 'nav.settings': ['설정', 'Settings'], 'nav.newPage': ['새 페이지', 'New page'],
  'nav.collapse': ['사이드바 접기', 'Collapse sidebar'], 'nav.open': ['메뉴 열기', 'Open menu'],
  'width.full': ['전체 너비로 보기', 'Full width'], 'width.center': ['가운데로 보기', 'Centered width'],
  'save.saved': ['저장됨', 'Saved'], 'save.saving': ['저장 중…', 'Saving…'], 'save.unsaved': ['저장 안 됨', 'Not saved'], 'save.offline': ['오프라인 — 연결되면 저장', 'Offline — saves when back online'],
  'home.title': ['오늘', 'Today'], 'home.addModule': ['모듈 추가', 'Add module'], 'home.noHidden': ['추가할 모듈이 없습니다', 'All modules are on the board'], 'home.addCopy': ['{name} 하나 더', 'Another {name}'],
  'home.fit': ['모듈 맞춤', 'Fit modules'],
  'home.presets': ['저장본', 'Presets'],
  'mod.stats': ['현황', 'Overview'], 'stat.pick': ['이 카드에 보일 지표', 'Show on this card'], 'stat.add': ['카드 추가', 'Add card'], 'stat.remove': ['카드 빼기', 'Remove card'],
  'stat.approvals': ['결재 대기', 'Pending approvals'], 'stat.work': ['에이전트 작업', 'Agent work'], 'stat.mail': ['안 읽은 메일', 'Unread mail'], 'stat.crews': ['에이전트 가동', 'Agents working'],
  'stat.todos': ['할 일', 'To-dos'], 'stat.taskMain': ['기한 지남 {late} · 오늘까지 {today}', '{late} overdue · {today} due today'], 'stat.tasksSub': ['내가 맡은 일', 'Assigned to me'], 'stat.b.late': ['기한 지남', 'Overdue'], 'stat.decisions': ['이번 주 결정', 'Decisions this week'], 'stat.outputs': ['이번 주 산출물', 'Outputs this week'], 'stat.pages': ['페이지', 'Pages'],
  'stat.b.waiting': ['대기', 'Waiting'], 'stat.b.none': ['없음', 'None'], 'stat.b.blocked': ['멈춤 있음', 'Blocked'], 'stat.b.normal': ['정상', 'Normal'], 'stat.b.unread': ['미확인', 'Unread'],
  'stat.b.check': ['확인 필요', 'Check'], 'stat.b.open': ['남음', 'Open'], 'stat.b.week': ['7일', '7 days'], 'stat.b.wiki': ['위키', 'Wiki'],
  'stat.highRisk': ['꼭 확인 {n}건', '{n} to review closely'], 'stat.noHighRisk': ['꼭 확인할 것 없음', 'Nothing to review closely'], 'stat.approvalsSub': ['결재함', 'Approvals'],
  'stat.blocked': ['멈춤 {n}건', '{n} blocked'], 'stat.workSub': ['에이전트가 진행 중', 'Agents on it'], 'stat.mailCheck': ['확인 필요', 'Needs a look'], 'stat.mailDone': ['모두 확인', 'All read'], 'stat.mailSub': ['받은 편지함', 'Inbox'],
  'stat.crewWorking': ['일하는 중', 'Working now'], 'stat.crewAsk': ['결재 기다리는 에이전트 {n}명', '{n} waiting on approval'], 'stat.todoDone': ['완료 {done} / {total}', '{done} / {total} done'], 'stat.todosSub': ['메일에서 뽑음', 'From mail'],
  'stat.decided': ['승인 {a} · 반려 {r}', '{a} approved · {r} rejected'], 'stat.weekSub': ['최근 7일', 'Last 7 days'], 'stat.pagesRecent': ['최근 7일 수정 {n}', '{n} edited in 7 days'], 'stat.pagesMe': ['내 페이지', 'My pages'], 'stat.pagesOrg': ['조직 위키', 'Org wiki'],
  'mod.approvals': ['결재 대기', 'Waiting for approval'], 'mod.work': ['에이전트 작업', 'Agent work'], 'mod.mail': ['안 읽은 메일', 'Unread mail'],
  'mod.todos': ['할 일', 'To-dos'], 'mod.calendar': ['캘린더', 'Calendar'], 'mod.pages': ['최근 페이지', 'Recent pages'], 'mod.outputs': ['최근 산출물', 'Recent deliverables'],
  'mod.journal': ['에이전트 일지', 'Agent journal'], 'mod.decisions': ['결정 기록', 'Decisions'],
  'mod.size.reset': ['크기 되돌리기', 'Reset size'], 'mod.resize.w': ['폭 조절 — 끌거나 ←/→', 'Resize width — drag or ←/→'], 'mod.resize.h': ['높이 조절 — 끌거나 ↑/↓', 'Resize height — drag or ↑/↓'],
  'mod.hide': ['숨기기', 'Hide'], 'mod.empty': ['비어 있습니다', 'Nothing here'], 'mod.drag': ['끌어서 옮기기', 'Drag to move'],
  'status.running': ['진행 중', 'Running'], 'status.blocked': ['멈춤', 'Blocked'], 'status.approved': ['승인', 'Approved'], 'status.rejected': ['거절', 'Rejected'],
  'risk.high': ['꼭 확인', 'Review closely'], // 위험도 문구(유건 9/30 #7) — 결재가 보이는 모든 곳이 이 셋만 쓴다
  'ap.noRight': ['이 결재를 결정할 권한이 없습니다', 'You cannot decide this approval'], // 결재함 문구는 folder-i18n.js(기록 화면과 함께 지연 로드)
  'col.name': ['이름', 'Name'], 'col.size': ['크기', 'Size'], 'col.date': ['날짜', 'Date'], 'col.item': ['내용', 'Item'], 'col.crew': ['에이전트', 'Agent'],
  'mail.inbox': ['받은편지함', 'Inbox'], 'mail.drafts': ['임시 보관함', 'Drafts'], 'mail.sent': ['보낸편지함', 'Sent'], 'mail.archive': ['보관함', 'Archive'],
  'mail.reply': ['답장', 'Reply'], 'mail.forward': ['전달', 'Forward'], 'mail.archiveIt': ['보관', 'Archive'],
  'mail.markRead': ['읽음으로 표시', 'Mark as read'], 'mail.markUnread': ['안 읽음으로 표시', 'Mark as unread'],
  'mail.archived': ['보관했습니다', 'Archived'],
  'mailc.expired': ['연결이 만료됐습니다 — 다시 연결해 주세요', 'Connection expired — please reconnect'],
  'mailc.adminNote': ['Argo Office가 회사 Google Workspace 메일에 연결할 수 있도록 신뢰 앱으로 등록해 주세요.\n\n관리 콘솔 → 보안 → 액세스 및 데이터 제어 → API 제어 → 타사 앱 액세스 관리 → 새 앱 구성 → OAuth 앱 이름 또는 클라이언트 ID로 검색\n\n클라이언트 ID: {client}\n요청 권한:\n{scopes}\n\n메일은 본인이 연결한 계정만 읽고, 에이전트는 초안까지만 씁니다. 발송은 사람이 직접 누를 때만 합니다.',
    'Please allow Argo Office as a trusted app so it can connect to our Google Workspace mail.\n\nAdmin console → Security → Access and data control → API controls → Manage Third-Party App Access → Configure new app → search by OAuth app name or client ID\n\nClient ID: {client}\nRequested scopes:\n{scopes}\n\nIt reads only the accounts each person connects; agents write drafts only, and mail is sent only when a person presses Send.'],
  'mailc.err.access_denied': ['승인을 취소했습니다. 회사 계정이라 막혔다면 관리자 안내문을 보내 주세요.', 'Approval was cancelled. If your company blocked it, send the note to your admin.'],
  'mailc.err.admin_policy_enforced': ['회사 관리자가 외부 앱 연결을 막았습니다. 안내문을 복사해 관리자에게 보내 주세요.', 'Your company admin blocks third-party apps. Copy the note and send it to your admin.'],
  'mailc.err.scopes': ['필요한 권한이 빠졌습니다. 승인 화면의 항목을 모두 켜고 다시 연결해 주세요.', 'Some permissions were left off. Turn on every item on the approval screen and reconnect.'],
  'mailc.err.state': ['연결 시간이 지났습니다. 다시 시도해 주세요.', 'The connection timed out. Please try again.'],
  'mailc.err.not_configured': ['서버에 Google 연결 설정이 아직 없습니다', 'Google connection is not configured on the server yet'],
  'mailc.err.other': ['연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 'Could not connect. Please try again shortly.'],
  'mail.connect': ['메일 계정 연결', 'Connect mail account'],
  'crew.assign': ['에이전트에게 맡기기', 'Hand off to agent'], 'crew.assignTo': ['{crew}에게 맡기기', 'Hand off to {crew}'], 'crew.dm': ['DM 열기', 'Open DM'],
  'nav.tools': ['플러그인', 'Plugins'],
  'nav.contracts': ['견적·계약', 'Quotes & contracts'],
  'crew.sent': ['{crew}에게 보냈습니다 · 메신저 1:1 대화에서 이어집니다', 'Sent to {crew} · continues in your Messenger 1:1 chat'],
  'crew.fail.unentitled': ['체험 기간이 끝나 에이전트가 멈춰 있습니다. 조직 결제를 확인해 주세요.', 'The trial has ended, so agents are paused. Check your organization billing.'],
  'crew.fail.locked': ['결제 문제로 조직이 잠겨 있어 보낼 수 없습니다.', 'The organization is locked due to a billing issue.'],
  'crew.fail.consent': ['메신저에서 AI 이용에 동의해야 에이전트에게 맡길 수 있습니다.', 'Agree to AI use in Messenger before handing work to an agent.'],
  'crew.fail.not_allowed': ['이 에이전트에게 일을 맡길 권한이 없습니다.', 'You are not allowed to give this agent work.'],
  'crew.fail.no_crew': ['맡길 수 있는 내 에이전트가 없습니다.', 'You have no agent to hand this to.'],
  'crew.fail.unavailable': ['지금은 에이전트에게 맡기기를 쓸 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 'Handing work to agents is unavailable right now. Try again later.'],
  'crew.fail.read': ['자료를 불러오지 못해 보내지 않았습니다. 다시 시도해 주세요.', 'Could not load the material, so nothing was sent. Try again.'],
  'crew.fail.generic': ['에이전트에게 보내지 못했습니다.', 'Could not send to the agent.'],
  'crew.drop': ['여기에 놓으면 {crew}에게 맡깁니다', 'Drop to hand off to {crew}'], 'crew.status.work': ['일하는 중', 'Working'], 'crew.status.ask': ['결재 대기', 'Waiting'], 'crew.status.idle': ['대기', 'Idle'],
  'page.untitled': ['제목 없음', 'Untitled'], 'page.copyTitle': ['{title} (사본)', '{title} (copy)'],
  'page.share': ['공유', 'Share'], 'page.restricted': ['비공개', 'Restricted'],
  'page.open': ['열기', 'Open'], 'page.openTab': ['새 탭에서 열기', 'Open in new tab'], 'page.duplicate': ['복제', 'Duplicate'], 'page.copyLink': ['링크 복사', 'Copy link'],
  'page.asTemplate': ['템플릿으로 저장', 'Save as template'], 'page.trash': ['휴지통으로', 'Move to trash'], 'page.addChild': ['하위 페이지 추가', 'Add subpage'],
  'page.trashed': ['휴지통으로 옮겼습니다', 'Moved to trash'], 'page.duplicated': ['복제했습니다', 'Duplicated'], 'page.linkCopied': ['링크를 복사했습니다', 'Link copied'],
  'page.history': ['버전 기록', 'Version history'],
  'page.viewing': ['{n}명이 보는 중', '{n} viewing'], 'page.templateSaved': ['조직 템플릿으로 저장했습니다', 'Saved as an org template'], 'page.templateSavedMine': ['내 템플릿으로 저장했습니다', 'Saved to my templates'],
  'page.tooBig': ['50MB까지 올릴 수 있습니다', 'Files must be 50MB or smaller'],
  'share.failed': ['공유 설정을 저장하지 못했습니다', 'Could not save sharing'],
  'share.restrict': ['이 페이지 비공개', 'Restrict this page'],
  'cmd.newPage': ['새 페이지 만들기', 'Create a page'], 'cmd.goHome': ['홈으로', 'Go home'], 'cmd.goMail': ['메일 열기', 'Open mail'], 'cmd.goApprovals': ['결재함 열기', 'Open approvals'],
  'cmd.toggleSidebar': ['사이드바 접기/펴기', 'Toggle sidebar'], 'cmd.toggleLang': ['언어 바꾸기', 'Switch language'], 'cmd.theme': ['테마: {name}', 'Theme: {name}'], 'cmd.settings': ['설정 열기', 'Open settings'],
  'undo': ['되돌리기', 'Undo'], 'close': ['닫기', 'Close'], 'cancel': ['취소', 'Cancel'], 'more': ['더 보기', 'More'],
  'theme.linen': ['린넨 · 시스템', 'Linen · System'], 'theme.linen-light': ['린넨 · 라이트', 'Linen · Light'], 'theme.linen-dark': ['린넨 · 다크', 'Linen · Dark'],
  'theme.graphite': ['그래파이트 · 시스템', 'Graphite · System'], 'theme.graphite-light': ['그래파이트 · 라이트', 'Graphite · Light'], 'theme.graphite-dark': ['그래파이트 · 다크', 'Graphite · Dark'],
  'theme.cream': ['크림 · 시스템', 'Cream · System'], 'theme.cream-light': ['크림 · 라이트', 'Cream · Light'], 'theme.cream-dark': ['크림 · 다크', 'Cream · Dark'],
  'theme.sand': ['샌드 · 시스템', 'Sand · System'], 'theme.sand-light': ['샌드 · 라이트', 'Sand · Light'], 'theme.sand-dark': ['샌드 · 다크', 'Sand · Dark'],
  'theme.peach': ['피치 · 시스템', 'Peach · System'], 'theme.peach-light': ['피치 · 라이트', 'Peach · Light'], 'theme.peach-dark': ['피치 · 다크', 'Peach · Dark'],
  'theme.mist': ['미스트 · 시스템', 'Mist · System'], 'theme.mist-light': ['미스트 · 라이트', 'Mist · Light'], 'theme.mist-dark': ['미스트 · 다크', 'Mist · Dark'],
  'theme.glow': ['글로우 · 시스템', 'Glow · System'], 'theme.glow-light': ['글로우 · 라이트', 'Glow · Light'], 'theme.glow-dark': ['글로우 · 다크', 'Glow · Dark'],
  'theme.sage': ['세이지 · 시스템', 'Sage · System'], 'theme.sage-light': ['세이지 · 라이트', 'Sage · Light'], 'theme.sage-dark': ['세이지 · 다크', 'Sage · Dark'],
  'theme.ocean': ['오션 · 시스템', 'Ocean · System'], 'theme.ocean-light': ['오션 · 라이트', 'Ocean · Light'], 'theme.ocean-dark': ['오션 · 다크', 'Ocean · Dark'],
  'theme.rose': ['로즈 · 시스템', 'Rose · System'], 'theme.rose-light': ['로즈 · 라이트', 'Rose · Light'], 'theme.rose-dark': ['로즈 · 다크', 'Rose · Dark'],
  'theme.lavender': ['라벤더 · 시스템', 'Lavender · System'], 'theme.lavender-light': ['라벤더 · 라이트', 'Lavender · Light'], 'theme.lavender-dark': ['라벤더 · 다크', 'Lavender · Dark'],
  'theme.slate': ['슬레이트 · 시스템', 'Slate · System'], 'theme.slate-light': ['슬레이트 · 라이트', 'Slate · Light'], 'theme.slate-dark': ['슬레이트 · 다크', 'Slate · Dark'],
  'theme.ember': ['엠버 · 시스템', 'Ember · System'], 'theme.ember-light': ['엠버 · 라이트', 'Ember · Light'], 'theme.ember-dark': ['엠버 · 다크', 'Ember · Dark'],
  'mode.system': ['시스템', 'System'], 'mode.light': ['라이트', 'Light'], 'mode.dark': ['다크', 'Dark'],
  'shell.plain': ['기본', 'Classic'], 'shell.float': ['떠 있는 사이드바', 'Floating sidebar'], 'shell.window': ['창', 'Window'],
  'shell.panel': ['떠 있는 본문', 'Floating page'], 'shell.pill': ['알약', 'Pill'], 'shell.glass': ['유리', 'Glass'],
  'shell.liquid': ['리퀴드 글래스', 'Liquid glass'], 'shell.neu': ['뉴모피즘', 'Neumorphism'],
  'color.linen': ['린넨', 'Linen'], 'color.graphite': ['그래파이트', 'Graphite'], 'color.cream': ['크림', 'Cream'], 'color.sand': ['샌드', 'Sand'],
  'color.peach': ['피치', 'Peach'], 'color.mist': ['미스트', 'Mist'], 'color.glow': ['글로우', 'Glow'],
  'color.sage': ['세이지', 'Sage'], 'color.ocean': ['오션', 'Ocean'], 'color.rose': ['로즈', 'Rose'], 'color.lavender': ['라벤더', 'Lavender'], 'color.slate': ['슬레이트', 'Slate'], 'color.ember': ['엠버', 'Ember'], 'cmd.shell': ['앱 셸: {name}', 'App shell: {name}'],
  'file.download': ['다운로드', 'Download'],
  'journal.count': ['{n}건', '{n} entries'], 'file.sendCrew': ['에이전트에게 보내기', 'Send to agent'], 'record.openMsgr': ['메신저에서 열기', 'Open in Messenger'],
  'login.title': ['Argo Office에 로그인', 'Sign in to Argo Office'], 'login.sub': ['아르고 메신저와 같은 계정으로 로그인합니다', 'Use the same account as Argo Messenger'],
  'login.google': ['Google로 계속', 'Continue with Google'], 'login.apple': ['Apple로 계속', 'Continue with Apple'], 'login.github': ['GitHub로 계속', 'Continue with GitHub'],
  'login.dev': ['개발용 로그인(로컬 스택)', 'Dev sign-in (local stack)'], 'login.email': ['이메일', 'Email'], 'login.password': ['비밀번호', 'Password'],
  'login.submit': ['로그인', 'Sign in'], 'login.failed': ['로그인하지 못했습니다', 'Could not sign in'], 'login.loading': ['불러오는 중…', 'Loading…'],
  'home.readOnly': ['조직 홈 구성은 관리자가 정합니다', 'Admins arrange the organization home'],
  'sync.rejected': ['서버가 이 변경을 받지 않았습니다 — 서버 상태로 되돌렸습니다', 'The server rejected this change — restored the server version'],
  'page.conflict': ['다른 사람이 먼저 수정했습니다', 'Someone else changed this page first'],
  'page.conflictReload': ['새로 불러오기', 'Reload'],
  'draft.badge': ['화면 초안 · 예시 데이터', 'Screen draft · sample data'],
  'load.fail': ['화면을 불러오지 못했습니다. 새 버전이 있을 수 있어요.', 'Couldn’t load this screen. A new version may be available.'], 'load.retry': ['다시 불러오기', 'Reload'],
  'time.now': ['방금', 'just now'], 'time.min': ['{n}분 전', '{n}m ago'], 'time.hour': ['{n}시간 전', '{n}h ago'], 'time.day': ['{n}일 전', '{n}d ago'],
};

let lang = (() => { try { const v = localStorage.getItem('argo-lang'); if (v === 'ko' || v === 'en') return v; } catch { /* 없음 */ } return navigator.language?.startsWith('ko') ? 'ko' : 'en'; })();
const listeners = new Set();
export const getLang = () => lang;
export function setLang(next) {
  lang = next;
  try { localStorage.setItem('argo-lang', next); } catch { /* 이번 세션만 */ }
  document.documentElement.lang = next;
  listeners.forEach((l) => l());
}
export const useLang = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => lang, () => lang);

export function t(key, vars) {
  const pair = DICT[key] ?? EXTRA[key];
  let s = pair ? pair[lang === 'en' ? 1 : 0] : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

export function ago(iso) {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return t('time.now');
  if (min < 60) return t('time.min', { n: min });
  if (min < 60 * 24) return t('time.hour', { n: Math.round(min / 60) });
  return t('time.day', { n: Math.round(min / 1440) });
}
