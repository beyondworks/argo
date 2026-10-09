// 도움말 — 결재: 데크 결재함 카드·대화창 결재 카드·승인/거절·고위험 표시·권한 요청, 풀 오토 모드에서 결재 없이 되는 것과 항상 결재인 것
export default {
  id: 'approvals',
  ko: {
    title: '결재와 풀 오토 모드',
    keywords: ['결재', '결재함', '승인', '거절', '고위험', '결재 카드', '풀 오토', '풀 오토 모드', '자동 승인', '권한 요청'],
    body: `결재는 에이전트가 밖으로 나가거나 되돌리기 어려운 일(예: 외부 발송, 연결 서비스의 쓰기 작업)을 하기 전에 사용자에게 올리는 승인 요청입니다. 에이전트가 자기 카드 규칙을 바꾸거나 새 동료 영입을 제안할 때도 결재로 올라옵니다.

**어디서 처리하나**
- 데크의 "결재함" 카드: 대기 중인 결재가 있을 때만 보이며 "대기 n"이 표시됩니다.
- 에이전트 대화 안의 결재 카드: "결재 대기 — 대화창에서 바로 처리할 수 있습니다".
- 메신저: Argo 메신저에서 시작한 일의 결재는 그 대화에 결재 카드로 올라옵니다. 알림을 켠 텔레그램에는 승인·거절 버튼이 오고, 슬랙에는 "승인 <번호>" 또는 "거절 <번호>"로 회신합니다.
- 모두 같은 결재 목록이라 한 곳에서 처리하면 다른 곳에서는 사라집니다.
- 결재를 기다리는 동안 에이전트의 진행 단계는 "사용자 결재 대기 중"으로 보입니다.

**카드 읽기**
- 목적·할 일·필요한 것이 쉬운 문장으로 나오고, 실제로 실행될 명령은 "명령 보기"에서 확인합니다.
- "고위험" 칩이 붙은 결재는 명령이 처음부터 펼쳐져 있습니다. 승인 전에 꼭 읽어 보세요.
- 동료에게 위임한 일에서 올라온 결재는 "○○ 위임"으로 출처가 보입니다. 행을 누르면 그 에이전트의 대화로 가서 앞뒤 맥락을 볼 수 있습니다.
- "권한 요청" 카드는 "네, 켜고 진행"을 누르면 그 능력을 켜고 바로 이어서 실행합니다.
- 팀 메신저의 조직 정책상 조직 관리자가 정하는 결재는 버튼 대신 "조직 관리자가 결정"으로 보입니다.

**승인과 거절 뒤**
- 승인하면 에이전트가 이어서 실행하고 결과를 대화에 "결재 결과"로 보고합니다.
- 거절하면 에이전트가 다른 방법을 찾습니다.
- 처리에 실패하면 이유가 보이고, 이미 다른 곳에서 처리된 결재는 목록에서 빠집니다.

**풀 오토 모드** (설정 → 일반 → 풀 오토 모드, 기본 꺼짐)
- 켜면 사용자가 직접 지시한 턴(본체 대화·메신저 DM·텔레그램 등)과 사용자가 만든 루틴·장시간 작업에서는 결재 없이 바로 실행하고 결과를 보고합니다.
- 켜도 항상 결재: 연결 서비스(Gmail·Drive·Notion 등)의 삭제, 구매·결제, 민감 정보 변경(비밀번호·API 키·토큰·로그인 연결·결제 수단·공유·권한·계정 설정).
- 적용되지 않는 곳: 에이전트끼리 넘긴 일, 에이전트가 건 예약, 조직 채널에서 다른 사람이 한 지시, 손님 요청.
- 연결 서비스 밖의 삭제·민감한 작업은 에이전트가 스스로 결재를 올리도록 안내받을 뿐 시스템이 강제하지는 않습니다. 켤 때 이 점을 고려하세요.
- 풀 오토는 사용자만 설정 화면에서 켜고 끌 수 있습니다. 에이전트가 바꿀 수 없습니다.`,
  },
  en: {
    title: 'Approvals and Full auto mode',
    keywords: ['approval', 'approvals', 'approve', 'reject', 'high risk', 'approval card', 'full auto', 'full auto mode', 'auto approve', 'permission request'],
    body: `An approval is a request an agent sends you before doing something that leaves the company or is hard to undo (for example sending something out, or a write action in a connected service). Agents also file approvals when they propose changing their own card rules or hiring a new colleague.

**Where to handle them**
- The "Approvals" card on the Deck: shown only when something is waiting, with "Pending {n}".
- Approval cards inside the agent's chat: "Approval needed — you can resolve it right here".
- Messengers: work started in Argo Messenger gets its approval card in that conversation. A Telegram bot with notifications on shows Approve/Reject buttons, and in Slack you reply "승인 <id>" (approve) or "거절 <id>" (reject).
- It is one shared list, so handling it in one place removes it everywhere else.
- While waiting, the agent's stage reads "Waiting for your approval".

**Reading a card**
- Purpose, task and needs are written in plain language; the exact command that will run is under "View command".
- Cards marked "High risk" show the command expanded from the start. Read it before approving.
- Approvals from delegated work show their origin ("delegated by …"). Click the row to open that agent's chat and see the context.
- On a "Permission request" card, "Yes, enable & continue" turns that ability on and continues right away.
- When team messenger policy says an org admin decides, the card shows "Org admin decides" instead of buttons.

**After approving or rejecting**
- Approved: the agent carries on and reports the result in the chat as an approval result.
- Rejected: the agent looks for another way.
- If processing fails you see the reason; an approval already handled elsewhere drops off the list.

**Full auto mode** (Settings → General → Full auto mode, off by default)
- When on, turns you gave directly (main chat, messenger DMs, Telegram, etc.) and routines and long tasks you created run without approval and report back.
- Still always needs approval even when on: deletion, purchases and payments, and sensitive changes (passwords, API keys, tokens, login connections, payment methods, sharing, permissions, account settings) in connected services such as Gmail, Drive and Notion.
- Not covered: work handed between agents, schedules set by agents, instructions from other people in org channels, and guest requests.
- Deletion or sensitive actions outside connected services rely on agents being instructed to ask first; the system does not enforce it. Keep that in mind before turning it on.
- Only you can turn Full auto on or off, in Settings. Agents cannot change it.`,
  },
};
