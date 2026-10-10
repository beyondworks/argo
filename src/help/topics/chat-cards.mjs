// 1:1 대화의 바깥 글 카드·만든 문서 칩·미리보기·그림(app/c/[ws]/crew/[slug]/inbound-card.jsx·artifact-chips.jsx와 맞춘다).
export default {
  id: 'chat-cards',
  ko: {
    title: '대화창의 카드 — 바깥에서 온 글, 만든 문서, 그림',
    keywords: ['바깥 글', '출처 카드', '전체 보기', '접기', '만든 문서', '미리보기', '그림 크게 보기', '자동 배달', '앞선 대화'],
    body: `에이전트 1:1 대화창에는 사용자가 직접 쓴 글과 에이전트의 답 말고도 몇 가지 카드가 보입니다.

바깥에서 온 글
- 메신저·루틴·쪽지·위임·장시간 작업·회의실·결재 결과로 들어온 지시는 출처 줄(예: "메신저 · #마케팅 · 이름", "루틴 · 아침 보고")과 앞 두 줄만 보이는 카드로 접힙니다. 라벨은 메신저·메신저 DM·루틴·루프·쪽지·위임·장시간 작업·회의실·결재 결과·자동 배달입니다.
- "전체 보기"로 펼치고 "접기"로 닫습니다. 메신저 글이면 함께 넘어간 최근 방 대화("앞선 대화 N건")와 "답글 대상"도 펼친 화면에서 작게 보입니다.
- 사용자가 직접 입력한 글과 에이전트의 답은 접히지 않습니다.

만든 문서
- 에이전트가 이번 답에서 만들거나 고친 파일은 답 아래 "만든 문서" 칩으로 나옵니다. 마크다운은 보기 화면으로 열고, 그 밖의 형식은 내려받습니다.
- 눈 모양 버튼으로 대화 안에서 "미리보기"를 펼치고 "미리보기 접기"로 닫습니다. 긴 파일은 앞부분만 보이고, 미리보기를 지원하지 않는 형식은 내려받아 확인합니다.

그림
- 에이전트가 만든 그림은 대화창과 회의실에 바로 보입니다. 그림을 누르면 크게 보고 저장할 수 있습니다.`,
  },
  en: {
    title: 'Cards in the chat — messages from elsewhere, created files, images',
    keywords: ['incoming card', 'source card', 'show all', 'collapse', 'created files', 'preview', 'view image larger', 'auto-delivered', 'earlier messages'],
    body: `Besides what you type and the agent's answers, an agent's 1:1 chat shows a few kinds of cards.

Messages from elsewhere
- Instructions that came from Messenger, routines, agent mail, delegation, long tasks, the Meeting Room or approval results fold into a card with a source line (e.g. "Messenger · #marketing · name", "Routine · morning report") and the first two lines. Labels: Messenger, Messenger DM, Routine, Loop, Agent mail, Delegated, Long task, Meeting room, Approval result, Auto-delivered.
- "Show all" opens it and "Collapse" closes it. For Messenger messages, the recent room conversation that came along ("Earlier messages (N)") and "In reply to" also appear, small, when opened.
- What you type yourself and the agent's answers never fold.

Created files
- Files the agent created or changed in that answer appear as "Created files" chips under it. Markdown opens in a viewer; other formats download.
- The eye button opens a "Preview" inside the chat; "Hide preview" closes it. Long files show the beginning only, and formats without preview are downloaded instead.

Images
- Images an agent makes appear right in the chat and in meeting rooms. Click one to view it larger and save it.`,
  },
};
