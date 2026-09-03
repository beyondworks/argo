// 메신저 사전 — 모든 UI 문자열은 여기로만(레포 규칙과 동일). 언어 상태는 Argo 앱과 같은 localStorage 키 'argo-lang'.
export const DICT = {
  'app.title': ['Argo 메신저', 'Argo Messenger'],
  'auth.email': ['이메일', 'Email'],
  'auth.sendCode': ['로그인 코드 보내기', 'Send sign-in code'],
  'auth.code': ['이메일로 받은 코드', 'Code from your email'],
  'auth.verify': ['로그인', 'Sign in'],
  'auth.sent': ['코드를 보냈습니다. 메일함을 확인하세요.', 'Code sent — check your inbox.'],
  'auth.password': ['비밀번호(개발용)', 'Password (dev only)'],
  'auth.signOut': ['로그아웃', 'Sign out'],
  'auth.notConfigured': ['서버 설정이 없습니다 — .env.local에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를 넣으세요.', 'No server configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.'],
  'org.none': ['아직 조직이 없습니다. 새 조직을 만들거나 초대 링크로 들어오세요.', 'No organization yet. Create one or join with an invite link.'],
  'org.new': ['새 조직', 'New organization'],
  'org.name': ['조직 이름', 'Organization name'],
  'org.create': ['만들기', 'Create'],
  'org.invite': ['초대 링크', 'Invite link'],
  'org.inviteMade': ['초대 링크를 복사했습니다(7일 유효).', 'Invite link copied (valid 7 days).'],
  'org.joined': ['조직에 들어왔습니다.', 'Joined the organization.'],
  'org.members': ['멤버', 'Members'],
  'org.crews': ['크루', 'Crews'],
  'org.crewsHint': ['크루는 각자의 Argo 앱 설정에서 이 조직에 등록합니다.', 'Crews are registered from each member’s Argo app settings.'],
  'ch.list': ['채널', 'Channels'],
  'ch.new': ['새 채널', 'New channel'],
  'ch.name': ['채널 이름', 'Channel name'],
  'ch.private': ['비공개', 'Private'],
  'ch.crewMemory': ['크루가 이 채널 내용을 장기 기억(일지)에 남김 — 끄면 요약·정리에서 제외되지만 대화 기록 자체는 남습니다', 'Crews keep this channel in long-term memory (journal) — off excludes it from summaries, though the conversation log itself remains'],
  'ch.empty': ['첫 메시지를 남겨 보세요. @로 크루를 부를 수 있습니다.', 'Say something. Mention a crew with @.'],
  'msg.placeholder': ['메시지 — @로 사람·크루 멘션, Enter 전송, Shift+Enter 줄바꿈', 'Message — @ to mention, Enter to send, Shift+Enter for newline'],
  'msg.send': ['보내기', 'Send'],
  'msg.attach': ['첨부', 'Attach'],
  'msg.typing': ['{name} 입력 중…', '{name} is typing…'],
  'msg.reply': ['답글', 'Reply'],
  'msg.attachFail': ['첨부 업로드 실패', 'Attachment upload failed'],
  'crew.away': ['부재중', 'Away'],
  'crew.online': ['대기 중', 'Online'],
  'ap.pending': ['결재 대기', 'Awaiting approval'],
  'ap.approve': ['승인', 'Approve'],
  'ap.reject': ['거절', 'Reject'],
  'ap.approved': ['승인됨', 'Approved'],
  'ap.rejected': ['거절됨', 'Rejected'],
  'ap.expired': ['만료됨', 'Expired'],
  'ap.ownerOnly': ['이 크루의 소유자만 확정할 수 있습니다.', 'Only this crew’s owner can decide.'],
  'ap.by': ['확정: {name}', 'Decided by {name}'],
  'ui.lang': ['EN', '한국어'],
  'ui.theme': ['테마', 'Theme'],
  'ui.error': ['오류', 'Error'],
  'ui.loading': ['불러오는 중…', 'Loading…'],
  'ui.copy': ['복사', 'Copy'],
};
export const LANGS = ['ko', 'en'];
export function readLang() { try { const v = localStorage.getItem('argo-lang'); return LANGS.includes(v) ? v : 'ko'; } catch { return 'ko'; } }
export function t(key, lang, vars) {
  const row = DICT[key];
  let s = row ? row[lang === 'en' ? 1 : 0] : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
