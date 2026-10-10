// 에이전트가 대화 밖에서 자기 이름으로 보낸 글(하트비트 알림·루틴 결과)을 자기 글로 알아보는 방법 — src/self-posts.mjs와 맞춘다.
export default {
  id: 'agent-posts',
  ko: {
    title: '에이전트가 대화 밖에서 보낸 글 — 하트비트 알림·루틴 결과',
    keywords: ['에이전트가 보낸 글', '자기 글', '인용', '답장', '하트비트 알림', '루틴 결과', '누가 보냈어', '내가 보낸 알림', '이거 뭐야'],
    body: `하트비트(일정 알림·아침 정리·내일 일정 요약·메일 알림)와 루틴 결과는 대화가 아니라 앱이 정해진 때에 에이전트 이름으로 보내는 글입니다. 에이전트는 이 글을 자기가 보낸 글로 알고 답합니다.

메신저에서
- 방의 최근 대화를 에이전트에게 넘길 때, 그 에이전트가 쓴 글에는 "(나 · 하트비트 알림)", "(나 · 루틴 결과)", "(나)" 표시가 붙습니다. 조직 채널에 올라간 루틴 결과도 같습니다.
- 그 글을 인용해 답장하면(예: 하트비트 알림을 길게 눌러 답장하고 "이거 테스트야?"라고 묻기) 에이전트는 "답글 대상은 네가 대화 밖에서 자동으로 보낸 하트비트 알림"이라는 안내를 함께 받습니다. 남이 쓴 글처럼 추측하지 않고, 왜 보냈는지·설정이 어떤지는 아르고 상태 도구로 확인해 답합니다.

데스크톱 앱 1:1 대화에서
- 메신저 개인 1:1 방에 보낸 하트비트 알림·루틴 결과 가운데 최근 것(7일 안, 5건까지, 글마다 앞부분만)을 대화 맥락에 "네가 대화 밖에서 보낸 최근 글"로 함께 받습니다. 그래서 "아까 보낸 일정 알림 뭐였어?"라고 물어도 답합니다.
- 이 목록은 회사 주인의 1:1(데스크톱 1:1, 메신저에서 주인과 그 에이전트만 있는 방)에서만 넘깁니다. 채널·회의실·다른 사람의 요청·루틴·위임으로 온 일에는 넘기지 않습니다.
- 메일에서 가져온 하트비트 글은 메일 내용 대신 "메일 알림 · 메일 id" 같은 표시만 넘깁니다.
- 기록은 그 알림을 보낸 기기에만 남습니다(동기화하지 않음). 다른 기기의 데스크톱 대화는 그 기기에서 보낸 글만 압니다.
- 에이전트에게 "argo 상태에서 나를 보여 줘"처럼 물으면 최근에 보낸 글 목록도 함께 확인합니다.`,
  },
  en: {
    title: 'Messages an agent sent outside a conversation — heartbeat notices and routine results',
    keywords: ['messages the agent sent', 'own message', 'quote', 'reply', 'heartbeat notice', 'routine result', 'who sent this', 'what is this'],
    body: `Heartbeat notices (event reminders, morning summary, tomorrow's summary, mail notices) and routine results are not conversations — the app sends them under the agent's name at set times. The agent treats them as its own messages.

In Messenger
- When the recent room conversation is passed to an agent, its own messages are marked "(me · heartbeat notice)", "(me · routine result)" or "(me)". Routine results posted in organization channels are marked the same way.
- If you reply to one of them (for example, reply to a heartbeat notice and ask "is this a test?"), the agent is told that the message being replied to is a heartbeat notice it sent automatically. It answers as the sender instead of guessing, and checks why it was sent and the settings with the Argo status tool.

In the desktop app's 1:1 chat
- The agent also receives the most recent heartbeat notices and routine results it sent to the personal 1:1 messenger room (last 7 days, up to 5, the start of each) as "messages you sent outside a conversation". So "what was that reminder you sent earlier?" gets an answer.
- This list is passed only in the company owner's 1:1 (the desktop 1:1, or a Messenger room with just the owner and that agent) — not in channels, the Meeting Room, other people's requests, routines or delegated work.
- Heartbeat messages taken from mail are passed only as a marker such as "mail notice · mail id", not the mail text.
- The record stays on the device that sent the notice (it is not synced). The desktop chat on another device knows only what that device sent.
- Ask the agent to show its own Argo status to see the recent list too.`,
  },
};
