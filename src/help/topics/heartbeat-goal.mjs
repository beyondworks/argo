// 도움말 — 목표 하트비트: 목표를 이룰 때까지 주기적으로 확인하고 이루면 스스로 꺼지는 개인 기능(src/goal-heartbeat.mjs). 숫자는 goal-time.mjs GOAL과 같다.
export default {
  id: 'heartbeat-goal',
  ko: {
    title: '목표 하트비트 — 이룰 때까지 챙기고 이루면 꺼짐',
    keywords: ['목표 하트비트', '하트비트', '목표', '티켓', '예매', '오픈 시간', '챙겨 줘', '될 때까지', '멈춰 줘', '꺼 줘', '기한', 'HEARTBEAT_OK'],
    body: `목표 하트비트는 "○○ 공연 티켓 오픈 시간 확인해서 예매해 줘"처럼 끝이 있는 일을 에이전트가 이룰 때까지 주기적으로 확인하고, 이루면 스스로 꺼지는 개인 기능입니다.

**만들기**
- 에이전트와의 1:1에서 말하면 에이전트가 목표·끝나는 조건·확인 간격·기한을 정리해 바로 만들고, 그 내용을 한 번 보여 줍니다.
- 주인의 1:1이 아닌 곳(채널·다른 에이전트의 부탁·루틴 실행 중)에서 나온 요청은 결재 카드로 올라옵니다. 카드에 목표·끝나는 조건·기한이 보이고, 승인해야 만들어집니다.
- 확인 간격은 10분~24시간(기본 60분), 기한은 기본 7일·최대 30일입니다. 동시에 켤 수 있는 목표는 5개입니다.
- 주인이 분명히 부탁한 일만 만듭니다. 대화에서 짐작해 만들지 않고, 하트비트 확인·루틴 실행 도중에는 새로 만들지 못합니다.

**도는 방식**
- 확인할 때마다 담당 에이전트가 목표·끝나는 조건·지난 확인 메모(최근 3개)를 받아 한 번 확인합니다.
- 새로 알릴 것이 없으면 아무것도 보내지 않습니다. 진전이 있으면 개인 공간 1:1 방에 "[하트비트] 제목"으로 짧게 알립니다. 같은 내용은 데스크톱 대화에도 남습니다.
- 에이전트가 다음 확인 시각을 직접 당기거나 미룰 수 있습니다(예: 티켓 오픈 5분 전). 단 지금부터 10분 뒤 ~ 기한 사이에서만입니다.
- 목표 하나는 하루 최대 48번 확인합니다. 넘으면 그날은 쉬고 다음 날 이어 갑니다.

**끝나는 경우**
- 달성: 에이전트가 끝나는 조건을 직접 확인하면 "[하트비트] 목표 달성"과 결과를 보내고 꺼집니다.
- 멈춤: 이룰 수 없거나 주인이 정해야 하면 이유를 알리고 꺼집니다.
- 기한 지남: "기한이 지나 껐어요"와 마지막 상태를 알립니다.
- 연속 3번 실패(러너 오류 등): 멈추고 마지막 오류를 알립니다.
- 끝난 목표는 지우지 않고 목록에 기록으로 남습니다(최근 20개).

**되돌릴 수 없는 단계**
- 결제·구매·예매 확정·회사 밖으로 메시지 보내기·계정 설정 바꾸기는 에이전트가 직접 하지 않고 결재 카드로 묻습니다. 풀 오토가 켜져 있어도 하트비트 확인은 결재를 거칩니다.
- 카드 번호·비밀번호 같은 결제·신원 정보는 에이전트가 입력하지 않습니다. 그 단계는 주인이 직접 합니다.

**확인·멈추기**
- 루틴 화면 "내 하트비트 → 목표 하트비트"에서 목표·상태·다음 확인·기한·최근 메모를 보고, 일시 정지·다시 켜기·끄기를 합니다.
- 에이전트에게 "그 티켓 하트비트 멈춰 줘", "다시 켜 줘", "꺼 줘"라고 말해도 됩니다(주인 1:1이면 바로, 그 밖은 결재).
- 메신저 알림 종류에서 하트비트 알림을 끄면 목표 알림도 메신저로 가지 않습니다(데스크톱 대화에는 남습니다).

**비용**
- 확인 1번 = 에이전트 턴 1번입니다. 기본 간격(60분)이면 목표 하나에 하루 24턴, 최대는 목표마다 48턴입니다.`,
  },
  en: {
    title: 'Goal heartbeat — keeps at it until done, then turns off',
    keywords: ['goal heartbeat', 'heartbeat', 'goal', 'tickets', 'booking', 'until done', 'keep checking', 'pause', 'turn off', 'deadline', 'HEARTBEAT_OK'],
    body: `A goal heartbeat is a personal feature for tasks with an end, like "find out when the concert tickets open and book them": the agent checks periodically until the goal is reached, then turns it off by itself.

**Creating**
- Ask your agent in your 1:1; it sums up the goal, the done condition, the check interval and the deadline, creates it right away, and shows you that summary once.
- Requests from anywhere other than your 1:1 (channels, another agent's request, during a routine) arrive as approval cards showing the goal, done condition and deadline; nothing is created until you approve.
- Interval 10 min–24 h (default 60 min); deadline 7 days by default, up to 30. Up to 5 goals can run at once.
- Only what you explicitly asked for becomes a goal — never inferred from conversation, and never created inside a heartbeat check or a routine run.

**How it runs**
- Each check, the agent gets the goal, the done condition and the last 3 check notes, and checks once.
- Nothing new means nothing is sent. Progress is posted briefly to your personal 1:1 room as "[Heartbeat] title"; the same text stays in the desktop chat.
- The agent can move the next check earlier or later (e.g. 5 minutes before tickets open), but only between 10 minutes from now and the deadline.
- Each goal checks at most 48 times a day; past that it rests until the next day.

**How it ends**
- Reached: once the agent confirms the done condition, it sends "[Heartbeat] Goal reached" with the result and turns off.
- Blocked: if it can't be achieved or needs your decision, it says why and turns off.
- Deadline passed: it sends "Deadline passed, turned off" with the last status.
- 3 failures in a row (runner errors etc.): it stops and reports the last error.
- Ended goals are kept as records in the list (latest 20), not deleted.

**Irreversible steps**
- Payment, purchase, confirming a booking, sending messages outside the company and changing account settings are never done by the agent — it asks with an approval card. Heartbeat checks go through approval even with full auto on.
- The agent never types payment or identity details such as card numbers or passwords — you do that step yourself.

**Checking and pausing**
- Routines → My heartbeat → Goal heartbeats shows the goal, status, next check, deadline and latest note, with Pause / Resume / Turn off.
- You can also tell the agent "pause the ticket heartbeat", "resume it", "turn it off" (immediate in your 1:1, otherwise an approval).
- Muting heartbeat notifications in the messenger also stops goal messages there (they still appear in the desktop chat).

**Cost**
- One check = one agent turn. At the default 60 min that is 24 turns a day per goal; the cap is 48 per goal.`,
  },
};
