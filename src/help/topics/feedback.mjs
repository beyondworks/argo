// 피드백과 로그인 상태 표시(app/c/[ws]/layout.jsx 사이드바 하단·상단바와 맞춘다).
export default {
  id: 'feedback',
  ko: {
    title: '피드백 보내기와 로그인 상태 표시',
    keywords: ['피드백', '의견 보내기', '불편한 점', '로그아웃', '세션 만료', '재로그인', '새로 고침 실패', '다시 시도'],
    body: `피드백
- 사이드바 아래쪽의 "피드백"에서 불편했던 점·바라는 점을 적어 보냅니다(로그인해서 쓸 때 보입니다).
- 보내는 곳에 따라 "공개 이슈 추적기에 등록됩니다"라는 안내가 함께 뜰 수 있습니다. 그때는 키·비밀번호·개인정보를 적지 마세요 — 자동으로 가리는 것이 완전하지 않습니다.
- 앱 디자인이나 기능을 바꾸고 싶을 때도 에이전트에게 고쳐 달라고 하기보다 피드백으로 보내는 것이 맞습니다. 에이전트는 앱 자체를 고치지 않습니다.

로그인 상태 표시
- 사이드바 아래쪽 "세션 만료 · 재로그인": 이 기기의 로그인이 끝났다는 뜻입니다. 다시 로그인하기 전까지 피드백과 기기 간 동기화가 멈춥니다.
- "로그아웃"은 이 기기에서 계정 로그인을 끝냅니다.
- 상단의 "새로 고침 실패 · 다시 시도": 회사 정보를 새로 받지 못해 마지막으로 받은 화면을 보여 주는 중이라는 뜻입니다. 눌러서 다시 받습니다.`,
  },
  en: {
    title: 'Sending feedback and sign-in status',
    keywords: ['feedback', 'send feedback', 'what felt off', 'sign out', 'session expired', 'sign in again', 'refresh failed', 'retry'],
    body: `Feedback
- Use "Feedback" at the bottom of the sidebar to write what felt off or what you wish it did (shown when you are signed in).
- Depending on where it goes, a note may say it is posted to a public issue tracker. In that case leave out keys, passwords and personal details — automatic masking is not complete.
- To change the app's design or features, send feedback rather than asking an agent to change it; agents do not modify the app itself.

Sign-in status
- "Session expired · Sign in again" at the bottom of the sidebar means this device's sign-in ended. Feedback and cross-device sync pause until you sign in again.
- "Sign out" ends the account sign-in on this device.
- "Refresh failed · Retry" at the top means the latest company info could not be loaded, so the last loaded view is shown. Click to try again.`,
  },
};
