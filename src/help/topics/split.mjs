// 옆에 열기 — 본문 옆에 다른 에이전트의 대화나 기억 문서를 나란히 연다(app/c/[ws]/split.mjs·layout.jsx와 맞춘다).
export default {
  id: 'split',
  ko: {
    title: '옆에 열기 — 두 화면을 나란히 보기',
    keywords: ['옆에 열기', '나란히', '분할', '패널', '패널 닫기', '전체 화면으로', '기억에서 열기', '두 에이전트 동시에'],
    body: `지금 보는 화면 옆에 다른 에이전트의 1:1 대화나 기억 문서를 나란히 열 수 있습니다.

- 여는 곳: 사이드바의 에이전트 행, 대화 화면 위쪽의 "옆에 열기", 기억 화면의 문서 행.
- 옆 패널의 폭은 경계를 끌어서 조절합니다.
- 패널 안에서 "전체 화면으로"를 누르면 그 화면으로 옮겨 가고, 문서는 "기억에서 열기"로 기억 화면에서 엽니다.
- 닫을 때는 "패널 닫기"를 누릅니다.
- 옆에 연 상태는 주소에 담겨, 새로고침해도 같은 두 화면이 그대로 열립니다.
- 다른 에이전트가 없으면 "옆에 열 다른 에이전트가 없습니다"라고 나옵니다.
- 예: 한쪽에서 리서처와 대화하며 다른 쪽에 정리 노트를 띄워 두거나, 두 에이전트의 대화를 함께 지켜볼 때 씁니다.`,
  },
  en: {
    title: 'Open beside — two views side by side',
    keywords: ['open beside', 'side by side', 'split', 'panel', 'close panel', 'open full', 'open in memory'],
    body: `You can open another agent's 1:1 chat or a memory document next to the current screen.

- Where: an agent row in the sidebar, "Open beside" at the top of a chat, or a document row in Memory.
- Drag the border to resize the side panel.
- Inside the panel, "Open full" moves to that screen, and "Open in memory" opens a document in the Memory screen.
- "Close panel" closes it.
- The side-by-side state lives in the page address, so a refresh reopens the same two views.
- If there is no other agent, it says "No other agent to open beside".
- Example: chat with a researcher on one side while keeping a summary note open on the other, or watch two agents' chats together.`,
  },
};
