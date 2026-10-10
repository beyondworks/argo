// 하트비트 메일 확인 — 답장이 필요한 메일·확인할 메일을 개인 1:1 방으로 알린다(src/assistant/mail*.mjs와 맞춘다).
export default {
  id: 'heartbeat-mail',
  ko: {
    title: '하트비트 메일 확인 — 답장이 필요한 메일 알림',
    keywords: ['메일 확인', '메일 알림', '답장이 필요한 메일', '답장 초안', '미리 보기', '안 봄', '마지막 메일 확인', '메일 연결'],
    body: `하트비트 에이전트가 연결된 메일함을 정해진 간격으로 확인해 알려 줄 수 있습니다. 루틴 → 내 하트비트 → 무엇을 알려 줄까요에서 "메일"을 고릅니다.

- 메일을 고르면 알림, 고르지 않으면 안 봄(기본)입니다. 고급의 "메일은 미리 보기만"을 켜면 알리지 않고 무엇을 알렸을지 기록만 합니다(며칠 지켜보는 용도).
- 확인 간격: 평일 9시~19시에는 10분마다, 그 밖의 시간과 주말에는 30분마다. 조용한 시간에는 확인하지 않습니다.
- 답장이 필요한 메일은 한 통씩, 확인하면 되는 메일은 번호를 붙인 묶음 한 글로 개인 공간 1:1 방에 알립니다.
- 답장 초안은 하트비트 에이전트가 만들고, 하루 세 번까지입니다. 무료 모델이나 일부 명령줄 실행기로 일하는 에이전트는 메일 글을 AI에게 보내지 않고 초안 없이 알림만 보냅니다. 초안이 필요하면 그 알림에 "초안 만들어 줘"라고 답하면 됩니다.
- 메일을 대신 보내지는 않습니다.
- 메일에서 나온 글은 다른 대화의 맥락에 본문 대신 "메일 알림 · 메일 id" 표시만 넘어갑니다.
- 상태는 루틴 → 내 하트비트 → 고급의 "마지막 메일 확인"에 보입니다. 연결된 메일이 없음, 메일 연결 만료, 요청 한도에 걸림, 읽지 못함(다음 확인 때 다시 읽음) 같은 경우가 표시됩니다. 메일 연결이 없거나 만료됐으면 메일 계정을 다시 연결해야 합니다.
- 무엇을 읽게 할지(메일 확인 켜기)는 권한이라 에이전트가 바꾸지 않고 사용자가 화면에서 정합니다.`,
  },
  en: {
    title: 'Heartbeat mail check — notices for mail that needs a reply',
    keywords: ['mail check', 'mail notice', 'needs a reply', 'reply draft', 'preview', 'off', 'last mail check', 'mail connection'],
    body: `The heartbeat agent can check a connected mailbox at set intervals and tell you about it. Choose "Mail" under Routines → My heartbeat → What should it tell you about?

- Checking Mail turns notices on; leaving it unchecked is Off (default). Turn on "Mail preview only" under Advanced to record what it would have sent without messaging you (for watching a few days first).
- Interval: every 10 minutes on weekdays 9:00–19:00, every 30 minutes otherwise and on weekends. It does not check during quiet hours.
- Mail that needs a reply is announced one by one; mail you only need to look at comes as one numbered batch message, in the personal 1:1 room.
- Reply drafts are written by the heartbeat agent, up to three a day. Agents on a free model or some command-line runners don't send mail text to the AI and notify without a draft — reply "draft it" to the notice if you need one.
- It never sends mail for you.
- Text that came from mail is passed into other conversations only as a "mail notice · mail id" marker, not the mail text.
- Status appears as "Last mail check" under Routines → My heartbeat → Advanced: no mail connected, mail connection expired, rate limited, or couldn't read (retries at the next check). If mail is not connected or expired, reconnect the mail account.
- Turning mail reading on is a permission, so agents never change it — the user decides on screen.`,
  },
};
