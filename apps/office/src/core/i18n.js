// 다국어 — 모든 화면 문자열은 이 사전으로만(프로젝트 규칙). [ko, en] 쌍, 언어는 argo-lang(메신저와 같은 키).
import { useSyncExternalStore } from 'react';

const DICT = {
  'app.name': ['Argo Office', 'Argo Office'],
  'space.me': ['내 공간', 'My space'],
  'space.switch': ['공간 전환', 'Switch space'],
  'space.members': ['멤버 {n}명', '{n} members'],
  'space.role.owner': ['소유자', 'Owner'], 'space.role.admin': ['관리자', 'Admin'], 'space.role.member': ['멤버', 'Member'],
  'nav.search': ['검색 및 명령', 'Search and commands'],
  'nav.home': ['홈', 'Home'], 'nav.mail': ['메일', 'Mail'], 'nav.shared': ['공유받은 항목', 'Shared with me'],
  'nav.work': ['진행 중인 일', 'In progress'], 'nav.approvals': ['결재함', 'Approvals'], 'nav.decisions': ['결정 기록', 'Decisions'],
  'nav.outputs': ['산출물', 'Deliverables'], 'nav.journal': ['크루 일지', 'Crew journal'],
  'nav.pages': ['페이지', 'Pages'], 'nav.wiki': ['조직 위키', 'Wiki'], 'nav.crews': ['크루', 'Crew'],
  'nav.trash': ['휴지통', 'Trash'], 'nav.settings': ['설정', 'Settings'], 'nav.newPage': ['새 페이지', 'New page'],
  'nav.collapse': ['사이드바 접기', 'Collapse sidebar'], 'nav.open': ['메뉴 열기', 'Open menu'],
  'save.saved': ['저장됨', 'Saved'], 'save.saving': ['저장 중…', 'Saving…'], 'save.unsaved': ['저장 안 됨', 'Not saved'], 'save.offline': ['오프라인 — 연결되면 저장', 'Offline — saves when back online'],
  'home.title': ['오늘', 'Today'], 'home.addModule': ['모듈 추가', 'Add module'], 'home.noHidden': ['추가할 모듈이 없습니다', 'All modules are on the board'],
  'home.reset': ['기본 배치로 되돌리기', 'Reset to default layout'],
  'mod.stats': ['현황', 'Overview'], 'stat.pick': ['이 카드에 보일 지표', 'Show on this card'], 'stat.add': ['카드 추가', 'Add card'], 'stat.remove': ['카드 빼기', 'Remove card'],
  'stat.approvals': ['결재 대기', 'Pending approvals'], 'stat.work': ['진행 중인 일', 'Work in progress'], 'stat.mail': ['안 읽은 메일', 'Unread mail'], 'stat.crews': ['크루 가동', 'Crews working'],
  'stat.todos': ['크루가 뽑은 할 일', 'Crew to-dos'], 'stat.decisions': ['이번 주 결정', 'Decisions this week'], 'stat.outputs': ['이번 주 산출물', 'Outputs this week'], 'stat.pages': ['페이지', 'Pages'],
  'stat.b.waiting': ['대기', 'Waiting'], 'stat.b.none': ['없음', 'None'], 'stat.b.blocked': ['멈춤 있음', 'Blocked'], 'stat.b.normal': ['정상', 'Normal'], 'stat.b.unread': ['미확인', 'Unread'],
  'stat.b.check': ['확인 필요', 'Check'], 'stat.b.open': ['남음', 'Open'], 'stat.b.week': ['7일', '7 days'], 'stat.b.wiki': ['위키', 'Wiki'],
  'stat.highRisk': ['높은 위험 {n}건', '{n} high risk'], 'stat.noHighRisk': ['높은 위험 없음', 'No high risk'], 'stat.approvalsSub': ['결재함', 'Approvals'],
  'stat.blocked': ['멈춤 {n}건', '{n} blocked'], 'stat.workSub': ['크루가 진행 중', 'Crews on it'], 'stat.mailCheck': ['확인 필요', 'Needs a look'], 'stat.mailDone': ['모두 확인', 'All read'], 'stat.mailSub': ['받은 편지함', 'Inbox'],
  'stat.crewWorking': ['일하는 중', 'Working now'], 'stat.crewAsk': ['결재 기다리는 크루 {n}명', '{n} waiting on approval'], 'stat.todoDone': ['완료 {done} / {total}', '{done} / {total} done'], 'stat.todosSub': ['메일에서 뽑음', 'From mail'],
  'stat.decided': ['승인 {a} · 반려 {r}', '{a} approved · {r} rejected'], 'stat.weekSub': ['최근 7일', 'Last 7 days'], 'stat.pagesRecent': ['최근 7일 수정 {n}', '{n} edited in 7 days'], 'stat.pagesMe': ['내 페이지', 'My pages'], 'stat.pagesOrg': ['조직 위키', 'Org wiki'],
  'mod.approvals': ['결재 대기', 'Waiting for approval'], 'mod.work': ['진행 중인 일', 'In progress'], 'mod.mail': ['안 읽은 메일', 'Unread mail'],
  'mod.todos': ['크루가 뽑은 할 일', 'To-dos from crew'], 'mod.pages': ['최근 페이지', 'Recent pages'], 'mod.outputs': ['최근 산출물', 'Recent deliverables'],
  'mod.journal': ['크루 일지', 'Crew journal'], 'mod.decisions': ['결정 기록', 'Decisions'],
  'mod.size': ['크기', 'Size'], 'mod.size.s': ['1/3 폭', 'One third'], 'mod.size.m': ['1/2 폭', 'Half'], 'mod.size.l': ['2/3 폭', 'Two thirds'], 'mod.size.full': ['전체 폭', 'Full width'],
  'mod.hide': ['숨기기', 'Hide'], 'mod.empty': ['비어 있습니다', 'Nothing here'], 'mod.more': ['모두 보기', 'View all'], 'mod.drag': ['끌어서 옮기기', 'Drag to move'], 'mod.resize': ['끌어서 크기 바꾸기', 'Drag to resize'],
  'status.running': ['진행 중', 'Running'], 'status.blocked': ['멈춤', 'Blocked'], 'status.approved': ['승인', 'Approved'], 'status.rejected': ['거절', 'Rejected'],
  'risk.high': ['높은 위험', 'High risk'], 'risk.low': ['낮은 위험', 'Low risk'],
  'ap.review': ['검토', 'Review'], 'ap.approve': ['승인', 'Approve'], 'ap.reject': ['거절', 'Reject'], 'ap.command': ['명령 보기', 'View command'],
  'ap.from': ['{crew} · #{channel}', '{crew} · #{channel}'], 'ap.empty': ['결재를 기다리는 일이 없습니다', 'Nothing waiting for approval'],
  'ap.decided': ['{result}했습니다', 'Marked as {result}'], 'ap.who': ['결정할 수 있는 사람: 관리자', 'Who can decide: admins'], 'ap.whoLow': ['결정할 수 있는 사람: 크루 주인', 'Who can decide: crew owner'],
  'col.goal': ['목표', 'Goal'], 'col.lead': ['맡은 크루', 'Lead'], 'col.status': ['상태', 'Status'], 'col.progress': ['단계', 'Steps'], 'col.started': ['시작', 'Started'],
  'col.channel': ['채널', 'Channel'], 'col.name': ['이름', 'Name'], 'col.size': ['크기', 'Size'], 'col.date': ['날짜', 'Date'], 'col.result': ['결과', 'Result'], 'col.by': ['결정한 사람', 'Decided by'], 'col.item': ['내용', 'Item'], 'col.crew': ['크루', 'Crew'],
  'mail.inbox': ['받은편지함', 'Inbox'], 'mail.drafts': ['임시 보관함', 'Drafts'], 'mail.sent': ['보낸편지함', 'Sent'], 'mail.archive': ['보관함', 'Archive'],
  'mail.compose': ['새 메일', 'New mail'], 'mail.reply': ['답장', 'Reply'], 'mail.forward': ['전달', 'Forward'], 'mail.archiveIt': ['보관', 'Archive'],
  'mail.markRead': ['읽음으로 표시', 'Mark as read'], 'mail.markUnread': ['안 읽음으로 표시', 'Mark as unread'],
  'mail.select': ['메일을 고르세요', 'Select a message'], 'mail.empty': ['메일이 없습니다', 'No messages'], 'mail.note': ['{crew}의 정리', 'Notes from {crew}'],
  'mail.to': ['받는 사람', 'To'], 'mail.subject': ['제목', 'Subject'], 'mail.send': ['보내기', 'Send'], 'mail.dropHere': ['여기에 놓으면 첨부됩니다', 'Drop to attach'],
  'mail.draftSaved': ['임시 보관함에 자동 저장됨', 'Autosaved to Drafts'], 'mail.back': ['목록', 'Back'], 'mail.archived': ['보관했습니다', 'Archived'],
  'mail.imagesBlocked': ['외부 이미지는 차단되어 있습니다', 'External images are blocked'], 'mail.connect': ['메일 계정 연결', 'Connect mail account'],
  'crew.assign': ['크루에게 맡기기', 'Hand off to crew'], 'crew.assignTo': ['{crew}에게 맡기기', 'Hand off to {crew}'], 'crew.dm': ['DM 열기', 'Open DM'],
  'crew.what': ['무엇을 할까요', 'What should they do'], 'crew.task.summary': ['요약', 'Summarize'], 'crew.task.todos': ['할 일 뽑기', 'Extract to-dos'],
  'crew.task.reply': ['답장 초안', 'Draft a reply'], 'crew.task.custom': ['직접 입력', 'Custom'], 'crew.customPh': ['크루에게 시킬 일을 적어 주세요', 'Describe the task'],
  'crew.dataNote': ['메일·문서 내용은 지시가 아닌 참고 자료로 전달됩니다. 크루는 메일을 보낼 수 없고 초안까지만 씁니다.', 'Mail and page content is passed as reference data, not instructions. Crew can only draft, never send.'],
  'crew.handed': ['{crew}에게 맡겼습니다', 'Handed off to {crew}'], 'crew.go': ['맡기기', 'Hand off'], 'crew.drop': ['여기에 놓으면 {crew}에게 맡깁니다', 'Drop to hand off to {crew}'],
  'crew.files': ['파일 {n}개', '{n} files'], 'crew.status.work': ['일하는 중', 'Working'], 'crew.status.ask': ['결재 대기', 'Waiting'], 'crew.status.idle': ['대기', 'Idle'],
  'page.untitled': ['제목 없음', 'Untitled'], 'page.copyTitle': ['{title} (사본)', '{title} (copy)'], 'page.placeholder': ["'/'를 입력해 블록 고르기", "Type '/' for blocks"], 'page.titlePh': ['제목 없음', 'Untitled'], 'page.missing': ['페이지를 찾을 수 없습니다', 'Page not found'],
  'page.share': ['공유', 'Share'], 'page.restricted': ['비공개', 'Restricted'], 'page.edited': ['{when} 수정', 'Edited {when}'],
  'page.open': ['열기', 'Open'], 'page.openTab': ['새 탭에서 열기', 'Open in new tab'], 'page.duplicate': ['복제', 'Duplicate'], 'page.copyLink': ['링크 복사', 'Copy link'],
  'page.asTemplate': ['템플릿으로 저장', 'Save as template'], 'page.trash': ['휴지통으로', 'Move to trash'], 'page.addChild': ['하위 페이지 추가', 'Add subpage'],
  'page.trashed': ['휴지통으로 옮겼습니다', 'Moved to trash'], 'page.duplicated': ['복제했습니다', 'Duplicated'], 'page.linkCopied': ['링크를 복사했습니다', 'Link copied'],
  'page.history': ['버전 기록', 'Version history'], 'history.empty': ['아직 남은 버전이 없습니다. 편집을 10분 넘게 쉬었다가 다시 고치면 이전 모습이 남습니다', 'No versions yet. Earlier states are kept when you edit again after a 10-minute pause'],
  'history.sample': ['예시 데이터 모드에서는 버전 기록이 없습니다', 'No version history in sample mode'], 'history.pick': ['버전을 고르면 미리 봅니다', 'Pick a version to preview'], 'history.version': ['버전 {n}', 'Version {n}'],
  'history.restore': ['이 버전으로 되돌리기', 'Restore this version'], 'history.restored': ['버전 {n}으로 되돌렸습니다', 'Restored version {n}'], 'history.failed': ['되돌리지 못했습니다', 'Could not restore'],
  'history.pending': ['저장이 끝난 뒤에 되돌릴 수 있습니다', 'Wait for saving to finish before restoring'], 'page.viewing': ['{n}명이 보는 중', '{n} viewing'], 'page.templateSaved': ['조직 템플릿으로 저장했습니다', 'Saved as an org template'], 'page.templateSavedMine': ['내 템플릿으로 저장했습니다', 'Saved to my templates'],
  'tpl.start': ['템플릿에서 시작', 'Start from a template'], 'tpl.basic': ['기본', 'Basics'], 'tpl.intranet': ['업무 기록', 'Work records'], 'tpl.org': ['조직', 'Organization'], 'tpl.mine': ['내 것', 'Mine'],
  'tpl.edit': ['템플릿 편집', 'Edit template'], 'tpl.readOnly': ['조직 템플릿은 관리자가 고칩니다', 'Admins edit org templates'], 'tpl.editing': ['템플릿입니다. 여기서 고친 내용은 이 템플릿으로 새로 만드는 페이지에 들어갑니다', 'This is a template. Changes apply to new pages made from it'],
  'page.dropFiles': ['파일을 놓으면 이 페이지에 올립니다(최대 50MB)', 'Drop files to upload to this page (max 50MB)'], 'page.uploaded': ['{n}개 파일을 올렸습니다', 'Uploaded {n} files'],
  'page.tooBig': ['50MB까지 올릴 수 있습니다', 'Files must be 50MB or smaller'], 'page.restrictedNote': ['관리자와 지정한 사람만 볼 수 있습니다', 'Only admins and invited people can see this'],
  'block.text': ['텍스트', 'Text'], 'block.h1': ['제목 1', 'Heading 1'], 'block.h2': ['제목 2', 'Heading 2'], 'block.h3': ['제목 3', 'Heading 3'],
  'block.bullet': ['글머리 목록', 'Bulleted list'], 'block.ordered': ['번호 목록', 'Numbered list'], 'block.todo': ['할 일 목록', 'To-do list'],
  'block.quote': ['인용', 'Quote'], 'block.code': ['코드', 'Code'], 'block.divider': ['구분선', 'Divider'], 'block.menu': ['블록 메뉴', 'Block menu'], 'block.private': ['이 블록 비공개', 'Make this block private'], 'block.delete': ['블록 삭제', 'Delete block'],
  'block.privateBadge': ['비공개', 'Private'], 'block.unhide': ['공개로 되돌리기', 'Make public'], 'block.hidden': ['비공개 내용입니다', 'This content is private'], 'block.privateFailed': ['비공개로 바꾸지 못했습니다', 'Could not make this block private'], 'block.none': ['맞는 블록이 없습니다', 'No matching blocks'],
  'share.title': ['공유', 'Share'], 'share.publish': ['게시', 'Publish'], 'share.invitePh': ['이메일이나 아이디로 초대', 'Invite by email or handle'], 'share.invite': ['초대', 'Invite'],
  'share.role.full': ['전체 권한', 'Full access'], 'share.role.edit': ['편집', 'Can edit'], 'share.role.view': ['보기', 'Can view'],
  'share.general': ['일반 접근', 'General access'], 'share.g.invited': ['초대된 사람만', 'Only invited people'], 'share.g.org': ['{org} 전체 보기', 'Everyone at {org} can view'],
  'share.g.orgEdit': ['{org} 전체 편집', 'Everyone at {org} can edit'], 'share.you': ['나', 'You'], 'share.remove': ['내보내기', 'Remove'],
  'share.notFound': ['그 이메일이나 아이디로 찾을 수 있는 사용자가 없습니다', 'No one found with that email or handle'],
  'share.readOnly': ['공유 설정은 이 페이지의 전체 권한자만 바꿀 수 있습니다', 'Only people with full access can change sharing'],
  'share.sample': ['예시 데이터 모드에서는 공유를 저장하지 않습니다', 'Sharing is not saved in sample mode'], 'share.failed': ['공유 설정을 저장하지 못했습니다', 'Could not save sharing'],
  'share.pubOn': ['웹에 게시', 'Publish to web'], 'share.pubDesc': ['로그인하지 않은 사람도 링크로 이 페이지를 볼 수 있습니다.', 'Anyone with the link can read this page without signing in.'],
  'share.index': ['검색 엔진에 노출', 'Allow search engines'], 'share.logo': ['상단에 {org} 로고가 표시됩니다', 'The {org} logo appears at the top'],
  'share.hidden': ['결재·메일 참조와 비공개 블록은 공개 화면에서 가려집니다', 'Approvals, mail references and restricted blocks are hidden on the public page'],
  'share.copy': ['링크 복사', 'Copy link'], 'share.restrict': ['이 페이지 비공개', 'Restrict this page'],
  'palette.ph': ['페이지·메일 검색 또는 명령', 'Search pages and mail, or run a command'], 'palette.pages': ['페이지', 'Pages'], 'palette.commands': ['명령', 'Commands'], 'palette.mail': ['메일', 'Mail'], 'palette.none': ['결과 없음', 'No results'],
  'cmd.newPage': ['새 페이지 만들기', 'Create a page'], 'cmd.goHome': ['홈으로', 'Go home'], 'cmd.goMail': ['메일 열기', 'Open mail'], 'cmd.goApprovals': ['결재함 열기', 'Open approvals'],
  'cmd.toggleSidebar': ['사이드바 접기/펴기', 'Toggle sidebar'], 'cmd.toggleLang': ['언어 바꾸기', 'Switch language'], 'cmd.theme': ['테마: {name}', 'Theme: {name}'], 'cmd.settings': ['설정 열기', 'Open settings'],
  'undo': ['되돌리기', 'Undo'], 'close': ['닫기', 'Close'], 'cancel': ['취소', 'Cancel'], 'more': ['더 보기', 'More'],
  'settings.title': ['설정', 'Settings'], 'settings.theme': ['테마', 'Theme'], 'settings.lang': ['언어', 'Language'], 'settings.mail': ['메일 계정', 'Mail accounts'],
  'settings.reset': ['초안 예시 데이터 되돌리기', 'Reset sample data'], 'settings.shortcuts': ['단축키', 'Keyboard shortcuts'],
  'theme.linen': ['린넨 · 시스템', 'Linen · System'], 'theme.linen-light': ['린넨 · 라이트', 'Linen · Light'], 'theme.linen-dark': ['린넨 · 다크', 'Linen · Dark'],
  'theme.graphite': ['그래파이트 · 시스템', 'Graphite · System'], 'theme.graphite-light': ['그래파이트 · 라이트', 'Graphite · Light'], 'theme.graphite-dark': ['그래파이트 · 다크', 'Graphite · Dark'],
  'trash.title': ['휴지통', 'Trash'], 'trash.note': ['30일이 지나면 영구 삭제됩니다', 'Items are deleted permanently after 30 days'], 'trash.restore': ['복원', 'Restore'], 'trash.empty': ['휴지통이 비어 있습니다', 'Trash is empty'],
  'shared.title': ['공유받은 항목', 'Shared with me'], 'shared.empty': ['공유받은 페이지가 없습니다', 'Nothing shared with you yet'],
  'file.download': ['다운로드', 'Download'], 'file.sendCrew': ['크루에게 보내기', 'Send to crew'], 'record.openMsgr': ['메신저에서 열기', 'Open in Messenger'],
  'lang.ko': ['한국어', '한국어'], 'lang.en': ['English', 'English'], 'public.missing': ['게시되지 않았거나 없는 페이지입니다', 'This page is not published or does not exist'], 'public.madeWith': ['Argo Office로 만듦', 'Made with Argo Office'],
  'login.title': ['Argo Office에 로그인', 'Sign in to Argo Office'], 'login.sub': ['아르고 메신저와 같은 계정으로 로그인합니다', 'Use the same account as Argo Messenger'],
  'login.google': ['Google로 계속', 'Continue with Google'], 'login.apple': ['Apple로 계속', 'Continue with Apple'], 'login.github': ['GitHub로 계속', 'Continue with GitHub'],
  'login.dev': ['개발용 로그인(로컬 스택)', 'Dev sign-in (local stack)'], 'login.email': ['이메일', 'Email'], 'login.password': ['비밀번호', 'Password'],
  'login.submit': ['로그인', 'Sign in'], 'login.failed': ['로그인하지 못했습니다', 'Could not sign in'], 'login.loading': ['불러오는 중…', 'Loading…'],
  'settings.account': ['계정', 'Account'], 'settings.signOut': ['로그아웃', 'Sign out'],
  'home.readOnly': ['조직 홈 구성은 관리자가 정합니다', 'Admins arrange the organization home'],
  'sync.rejected': ['서버가 이 변경을 받지 않았습니다 — 서버 상태로 되돌렸습니다', 'The server rejected this change — restored the server version'],
  'page.conflict': ['다른 사람이 먼저 수정했습니다', 'Someone else changed this page first'],
  'page.conflictHint': ['새로 불러오면 내 변경은 사라집니다. 내 변경을 지키려면 사본으로 저장하세요.', 'Reloading discards your changes. Save them as a copy to keep them.'],
  'page.conflictReload': ['새로 불러오기', 'Reload'], 'page.conflictCopy': ['내 변경을 사본으로 저장', 'Save my changes as a copy'], 'page.copySaved': ['사본으로 저장했습니다', 'Saved as a copy'],
  'draft.badge': ['화면 초안 · 예시 데이터', 'Screen draft · sample data'],
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
  const pair = DICT[key];
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
