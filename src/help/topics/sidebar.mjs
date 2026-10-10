// 사이드바 에이전트 행의 표시(app/c/[ws]/layout.jsx와 맞춘다).
export default {
  id: 'sidebar',
  ko: {
    title: '사이드바 에이전트 목록의 표시',
    keywords: ['사이드바', '새 메시지', '답변 작성 중', '점', '텔레그램 직통 봇 표시', '카드를 읽지 못했어요', '다시 읽기', '고정', '순서 변경'],
    body: `사이드바의 에이전트 행에는 그 에이전트의 상태가 작은 표시로 붙습니다.

- 새 메시지 점: 아직 열어 보지 않은 답이나 글이 있습니다.
- 답변 작성 중: 지금 답을 쓰고 있습니다(깜빡임).
- 텔레그램 직통 봇 점: 연결됨(이 기기에서 받는 중), 다른 기기에서 수신 중, 연결됐지만 수신 대기 — 세 가지로 보입니다. 직통 봇은 에이전트 카드의 "연결·원문" 탭에서 붙입니다.
- 고정과 순서: 자주 쓰는 에이전트를 고정하고, 끌어서 순서를 바꿉니다.
- "에이전트 카드 N개를 읽지 못했어요": 카드 파일을 읽지 못해 그 에이전트가 목록에서 빠졌다는 뜻입니다. 다른 프로그램이 파일을 열고 있다면 잠시 뒤 "다시 읽기"를 누르세요. 계속 안 되면 카드 파일이 깨졌는지 확인합니다.
- 에이전트를 누르면 그 에이전트와의 1:1 대화가 열리고, "옆에 열기"로 지금 화면 옆에 나란히 열 수도 있습니다.`,
  },
  en: {
    title: 'Indicators in the sidebar agent list',
    keywords: ['sidebar', 'new messages', 'writing a reply', 'dot', 'telegram bot indicator', 'could not read agent cards', 'read again', 'pin', 'reorder'],
    body: `Each agent row in the sidebar carries small indicators of that agent's state.

- New-message dot: there is an answer or message you have not opened yet.
- Writing a reply: it is answering right now (blinking).
- Telegram bot dot: connected (receiving on this device), receiving on another device, or connected but not receiving yet. The direct bot is attached in the agent card's "Links & raw" tab.
- Pin and order: pin agents you use often and drag to reorder.
- "Couldn't read N agent card(s)": those card files could not be read, so the agents are missing from the list. If another program has the file open, click "Read again" after a moment; if it keeps failing, check whether the card file is damaged.
- Click an agent to open its 1:1 chat, or use "Open beside" to open it next to the current screen.`,
  },
};
