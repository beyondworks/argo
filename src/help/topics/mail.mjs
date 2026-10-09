// 도움말 — 쪽지함(비동기 쪽지·참조·배달 기록·실패함), 에이전트끼리 일 넘기기(위임·쪽지), 위임 제한, 세션 메시지(@이름)
export default {
  id: 'mail',
  ko: {
    title: '쪽지함 · 위임 · 세션 메시지',
    keywords: ['쪽지', '쪽지함', '참조', '위임', '일 넘기기', '동료에게 맡기기', '세션 메시지', '@이름', '위임 제한', '재투입', '배달 실패'],
    body: `에이전트는 동료에게 일을 넘길 수 있고, 사용자도 쪽지로 에이전트에게 일을 맡길 수 있습니다.

**쪽지함** (사이드바 "쪽지함")
- 에이전트끼리, 그리고 사용자가 에이전트에게 보내는 비동기 쪽지입니다.
- "쪽지 보내기"에서 받는 에이전트, 참조(최대 4명), 내용을 적고 보냅니다. 참조도 각자 턴을 씁니다.
- 쪽지는 약 1분 간격으로 배달되며, 쪽지 1건이 받는 에이전트의 턴 1회가 됩니다. 받은 에이전트의 대화에는 "쪽지" 카드로 보입니다.
- 대기 중: 아직 배달 전인 쪽지입니다. 배달 전이면 "취소"할 수 있고, "배달 중"이면 취소할 수 없습니다.
- 배달 기록: 성공·취소·실패와 "대화 열기".
- 실패함: 재시도 끝에 배달되지 못한 쪽지입니다. 원인(예: 러너 연결)을 해결한 뒤 "재투입"으로 다시 보내거나 삭제합니다. 삭제는 영구적입니다.

**에이전트끼리 일 넘기기**
- 위임: 에이전트가 자기 전문 밖의 일을 동료에게 맡기고 답을 기다렸다가 이어서 일합니다. 진행 단계에 "동료에게 위임 중"이 보이고, 동료의 대화에는 "위임" 카드로 남습니다.
- 쪽지: 에이전트가 동료에게 쪽지를 보내면 나중 턴으로 배달됩니다.
- 위임받은 동료가 결재가 필요한 일을 하면 결재 카드에 "○○ 위임"으로 출처가 표시됩니다.
- 활동 화면에는 "A → B"로 보입니다.

**위임 제한**
- 대화와 회의실 입력창 아래 스위치입니다. 기본은 켜짐이며 한 턴에 위임 2회·쪽지 2통·2단계까지입니다.
- 풀면 위임 10회·4단계까지 맡기고, 한 번의 지시로 이어지는 에이전트 턴은 합계 30회까지입니다. 닿으면 멈추고 이어갈지 묻습니다.
- 처음 풀 때 확인을 묻고, 그 대화(또는 회의)에만 적용됩니다. 새 대화는 다시 켜짐으로 시작합니다.
- 팀 메신저에서 도는 에이전트 턴은 항상 제한이 켜진 상태로 돕니다.

**세션 메시지**
- 1:1 대화 입력 맨 앞에 "@이름 내용"을 쓰면, 그 에이전트가 이어 가던 대화에 메시지가 들어가고 답은 지금 방에 카드로 돌아옵니다.
- 답변 중이어도 대기열을 거치지 않고 바로 나갑니다. 첨부가 있으면 세션 메시지가 아니라 일반 지시로 보냅니다.
- 같은 에이전트의 답을 기다리는 동안에는 다시 보낼 수 없고, 한 번에 8000자까지 보낼 수 있습니다.`,
  },
  en: {
    title: 'Mailbox, delegation and session messages',
    keywords: ['mailbox', 'note', 'agent mail', 'cc', 'delegate', 'hand off', 'session message', '@name', 'delegation limit', 'requeue', 'failed delivery'],
    body: `Agents can hand work to colleagues, and you can give agents work with a note.

**Mailbox** ("Mailbox" in the sidebar)
- Asynchronous notes between agents, and from you to agents.
- In "Send a note", pick the recipient, up to 4 CCs and the message. Each CC also runs a turn.
- Notes are delivered about every minute; one note becomes one turn for the recipient. In the recipient's chat it shows as an "Agent mail" card.
- Pending: notes not yet delivered. You can "Cancel" before delivery, but not while it says "Delivering".
- Delivery log: delivered, cancelled or failed, with "Open chat".
- Failed: notes that could not be delivered after retries. Fix the cause (for example the runner connection), then "Requeue" or delete. Deleting is permanent.

**Agents handing work to each other**
- Delegation: an agent hands a task outside its expertise to a colleague, waits for the answer and continues. The stage shows "Delegating to a colleague", and the colleague's chat keeps a "Delegated" card.
- Notes: an agent can also send a colleague a note, which is delivered as a later turn.
- If the colleague's work needs approval, the approval card shows where it came from ("delegated by …").
- Activity shows these as "A → B".

**Delegation limit**
- A switch under the chat and meeting room input. It is on by default: per turn, up to 2 delegations, 2 notes and 2 levels deep.
- Lifted, agents can delegate up to 10 times and 4 levels, with at most 30 agent turns in total from one instruction; when that is reached it stops and asks whether to continue.
- You confirm the first time you lift it, and it applies to that chat (or meeting) only. A new chat starts with the limit on.
- Agent turns in the team messenger always run with the limit on.

**Session messages**
- In a one-on-one chat, start the input with "@name message". It goes into that agent's ongoing conversation, and the reply comes back here as a card.
- It is sent right away even while the current agent is replying. With an attachment it is sent as a normal instruction instead.
- You cannot send again while waiting for that agent's reply, and the limit is 8000 characters.`,
  },
};
