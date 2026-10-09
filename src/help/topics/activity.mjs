// 도움말 — 활동 화면(필터·출처·행 펼치기·다시 실행·반복 실패), 백그라운드 작업 독, 장시간 작업
export default {
  id: 'activity',
  ko: {
    title: '활동 · 백그라운드 작업',
    keywords: ['활동', '기록', '타임라인', '다시 실행', '반복 실패', '오류 기록', '백그라운드 작업', '작업 독', '장시간 작업', '진행 중'],
    body: `활동 화면은 내가 없는 동안 무슨 일이 있었는지 한눈에 보여 주는 타임라인입니다. 사이드바 "활동"에서 엽니다.

**필터와 행**
- 필터: "주요"(정상 처리된 턴을 뺀 결재·오류·기억·에이전트 변경 등), "결재", "기억", "오류", "전체". 정상 턴은 "전체"에서만 보입니다.
- 행에는 시각, 누가(위임·쪽지는 "A → B"), 무엇을, 관련 화면으로 가는 링크, 출처 칩, 걸린 시간이 보입니다.
- 출처 칩: 데크·메신저·루틴·위임·쪽지·세션 메시지·시운전·회의실·경쟁 시안.
- 위쪽 검색칸으로 활동을 거를 수 있습니다. 오른쪽에는 "오늘" 요약과 "오늘 에이전트별" 턴 수가 있습니다.

**행 펼치기와 다시 실행**
- 턴 행을 누르면 지시 전문과 "단계 로그"가 펼쳐집니다.
- "다시 실행"은 같은 에이전트에게 원래 지시를 다시 보냅니다. 진행은 그 에이전트의 대화에서 보입니다.
- 다시 실행은 사용자가 직접 시킨 턴(데크·회의실·경쟁 시안·사용자가 만든 루틴·사용자가 보낸 쪽지·시운전)에만 있습니다. 메신저로 받은 지시는 메신저에서 다시 보내야 하고, 에이전트끼리 넘긴 일과 에이전트가 건 예약에는 단추가 없습니다.

**자주 보는 표시**
- "사용자가 중단했습니다": 내가 멈춘 턴입니다.
- "반복 실패": 같은 오류가 24시간 안에 3번 이상 나면 한 줄로 묶어 원문과 함께 보여 줍니다. 설정의 러너 상태를 먼저 확인하고, 앱 업데이트 뒤에도 계속되면 원문과 함께 피드백으로 알려 주세요.
- "루틴 건너뜀": 예정 시각에 기기가 꺼져 있거나 잠들어 있어 실행하지 못한 회차입니다.
- 그 밖에 영입·하선·정보 변경, 기억 정리, MCP 접속 실패, 러너 자격 확인, 메신저 페어링 완료가 남습니다.

**백그라운드 작업 독**
- 상단바의 작업 아이콘을 누르면 열립니다. 지금 도는 작업이 있으면 아이콘에 점이 붙습니다.
- "진행 중": 에이전트 이름, 지금 단계, 경과 시간. 누르면 그 에이전트 대화로 갑니다.
- "최근 작업": 최근 15건(지시 수행·루틴·기억 정리)과 성공·실패, 걸린 시간.
- 사이드바에서 답을 쓰는 중인 에이전트는 아바타 둘레가 은은하게 깜빡입니다.

**장시간 작업**
- 10분을 넘길 수 있는 일(대량 수집, 긴 브라우저 자동화, 큰 빌드)은 에이전트가 장시간 작업으로 걸어 둡니다.
- 대화를 막지 않고 뒤에서 돌며, 끝나면 결과가 그 대화에 "장시간 작업" 카드로 오고 알림을 켠 메신저로도 갑니다.
- 일부 연결 방식(예: Antigravity)에서는 장시간 작업을 쓸 수 없습니다.`,
  },
  en: {
    title: 'Activity and background tasks',
    keywords: ['activity', 'log', 'timeline', 're-run', 'repeated failure', 'errors', 'background tasks', 'task dock', 'long task', 'running'],
    body: `Activity is a timeline of what happened while you were away. Open it from "Activity" in the sidebar.

**Filters and rows**
- Filters: "Main" (approvals, errors, memory, agent changes and more, without normal turns), "Approval", "Memory", "Error", "All". Normal turns appear only under "All".
- Each row shows the time, who (delegation and notes show "A → B"), what happened, a link to the related screen, a source chip and the duration.
- Source chips: deck, messenger, routine, delegate, mail, session message, trial, room, contest.
- The search box at the top filters activity. On the right are "Today" totals and "Today by Agent" turn counts.

**Expanding a row and re-running**
- Click a turn row to see the full instruction and the "Step log".
- "Re-run" sends the original instruction to the same agent again; progress shows in that agent's chat.
- Re-run is offered only for turns you started yourself (deck, meeting room, contest, routines you created, notes you sent, trial runs). Instructions received through the messenger must be resent from the messenger, and work handed between agents or scheduled by an agent has no button.

**Common markers**
- "You stopped this": a turn you stopped.
- "Repeated failure": the same error 3 or more times within 24 hours, grouped with the original message. Check the runner in Settings first; if it persists after updating the app, report it via Feedback with the message.
- "Routine skipped": a run missed because this device was off or asleep at the scheduled time.
- You will also see hires, departures and info changes, memory organizing, MCP connection failures, runner credential checks, and messenger pairing.

**Background task dock**
- Click the tasks icon in the top bar. A dot on the icon means something is running.
- "Running": agent name, current stage and elapsed time; click to open that agent's chat.
- "Recent": the last 15 items (instructions, routines, memory organizing) with success or failure and duration.
- In the sidebar, an agent writing a reply has a softly pulsing ring around its avatar.

**Long tasks**
- Work that can take more than 10 minutes (bulk collection, long browser automation, big builds) is set up by the agent as a long task.
- It runs in the background without blocking the chat. When it finishes, the result arrives in that chat as a "Long task" card and in any messenger you enabled for notifications.
- Some connection methods (for example Antigravity) cannot run long tasks.`,
  },
};
