// 도움말 — 회의실: 여러 에이전트를 한 방에 부르는 법(@이름·@all·이어받기·cc·반복), 반응 라운드, 회의 마치기·새 회의·회의 기록
export default {
  id: 'room',
  ko: {
    title: '회의실',
    keywords: ['회의실', '회의', '여러 에이전트', '멘션', '@all', '이어받기', '반응 라운드', '회의록', '회의 마치기', '새 회의'],
    body: `회의실은 사용자와 여러 에이전트가 한 방에서 이야기하는 곳입니다. 사이드바 "회의실"에서 엽니다.

**부르는 법**
- "@이름 안건": 부른 에이전트가 발언합니다. 여러 명을 부르면 동시에 발언하고, 반응 라운드에서 서로의 발언에 답합니다.
- "@all" 또는 "@전체": 모든 에이전트가 발언합니다.
- "@A > @B": 이어받기. A가 답한 뒤 그 답을 받아 B가 이어 갑니다. 기본 3명까지, 위임 제한을 풀면 6명까지입니다.
- "cc @이름": 방에서 말하지 않고 참조 사본만 받습니다(참조도 그 에이전트의 턴을 씁니다).
- "반복 30분 @이름 지시": 그 지시를 30분마다 도는 루틴으로 등록합니다.
- 이름 없이 안건만 쓰면 첫 번째 에이전트가 답합니다. 이름만 쓰고 안건이 없으면 보내지 않습니다. 명단에 없는 이름이면 방에 안내가 남습니다.

**진행 중**
- 위쪽에 "회의 진행 중 · n/m명 발언 완료 · 경과 시간"이 보이고, 발언 중인 에이전트마다 단계와 생각이 카드로 보입니다.
- 반응 라운드 알약: "반응 라운드 켜짐"(기본)이면 전원이 서로의 발언을 읽고 한 번 더 답합니다. 턴 비용이 두 배라 "1라운드만"으로 바꿀 수 있습니다. 보탤 말이 없으면 "추가 의견 없음" 한 줄로 접힙니다.
- 넓은 화면에서 발언자 이름을 누르면 그 에이전트의 개별 대화가 옆에 열립니다.
- 입력창은 1:1 대화와 같습니다: / 명령(/memory·/deck·/end), 스킬·별칭, 첨부(파일당 10MB), 작업 폴더 고정(발언하는 모든 에이전트에게 전달), 위임 제한 스위치(이 회의에만 적용).

**회의 마치기와 기록**
- "회의 마치기 — 회의록 남기기": 회의록이 회사 기억의 일지에 남고 방이 비워집니다. 원래 대화는 보관됩니다.
- "새 회의 — 지금 회의는 진행 중으로": 회의록 없이 지금 회의를 "진행 중"으로 보관하고 빈 방을 엽니다.
- 왼쪽 "회의 기록"에서 지난 회의를 읽기 전용으로 보고, 다시 열거나 전환하고, 고정·이름 바꾸기를 합니다.
- 에이전트가 발언하는 동안에는 마치기·새 회의·전환을 할 수 없습니다. 끝난 뒤 다시 시도합니다.`,
  },
  en: {
    title: 'Meeting Room',
    keywords: ['meeting room', 'meeting', 'multiple agents', 'mention', '@all', 'relay', 'reaction round', 'minutes', 'end meeting', 'new meeting'],
    body: `The Meeting Room is where you and several agents talk in one thread. Open it from "Meeting Room" in the sidebar.

**How to call agents**
- "@name topic": the mentioned agent speaks. Mention several and they speak at once, then reply to each other in a reaction round.
- "@all" (or "@전체"): every agent speaks.
- "@A > @B": relay. A answers, then B continues from A's answer. Up to 3 agents by default, 6 with the delegation limit lifted.
- "cc @name": the agent does not speak in the room but receives a copy (a cc still uses that agent's turn).
- "loop 30m @name instruction" (Korean form "반복 30분 @이름 …"): registers the instruction as a routine that runs every 30 minutes.
- A topic with no mention goes to the first agent. A mention with no topic is not sent. Unknown names leave a note in the room.

**During the meeting**
- The header shows "Meeting in progress · done/total spoke · elapsed", and each speaking agent has a card with its stage and thinking.
- Reaction round pill: with "Reaction round on" (default) everyone reads the others and replies once more. That doubles turn cost, so you can switch to "One round only". An agent with nothing to add collapses to "Nothing to add".
- On a wide screen, clicking a speaker's name opens that agent's own chat beside the room.
- The input works like a one-on-one chat: / commands (/memory, /deck, /end), skills and aliases, attachments (10MB per file), a pinned work folder (passed to every speaking agent), and the delegation limit switch (this meeting only).

**Ending and history**
- "End meeting — file the minutes": the minutes go into the company memory journal and the room is cleared. The raw thread is archived.
- "New meeting — keep this one open": keeps the current meeting as "In progress" without minutes and opens an empty room.
- "Meetings" on the left lists past meetings, read only; you can reopen or switch to one, pin it, or rename it.
- While an agent is speaking you cannot end, start a new meeting or switch. Try again when it finishes.`,
  },
};
