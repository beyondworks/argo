// 에이전트가 아르고 상태를 읽고 설정을 바꾸는 규칙 — src/argo-self.mjs(SETTINGS·FORBIDDEN_SETTINGS·argoStatus)와 맞춘다.
export default {
  id: 'agent-settings',
  ko: {
    title: '에이전트에게 아르고 상태를 묻고 설정을 맡기기',
    keywords: ['설정 바꾸기', '설정 변경', '에이전트가 설정', '권한', '결재', '되돌리기', '바로 바뀜', '상태 확인', '아르고 상태', '무엇을 바꿀 수 있나'],
    body: `에이전트는 아르고 앱의 지금 상태를 읽고, 일부 설정은 직접 바꿀 수 있습니다.

읽을 수 있는 것(화면과 같은 값 — 회사 주인의 1:1에서만)
- 데크 숫자(기억·에이전트·기억 연결 %와 계산 내역·구성·일별 적립), 에이전트 목록과 러너·모델·작업 중 여부, 루틴과 마지막 실행 결과, 하트비트 상태, 기기 간 동기화, 러너 연결(키 값은 보이지 않음), 요금제·사용량, 메신저·알림 연결, 결재 대기.
- 상태와 설정 값은 회사 주인의 1:1(데스크톱 앱의 에이전트 대화, 메신저에서 주인과 그 에이전트만 있는 1:1 방)에서만 알려 줍니다. 조직 채널·회의실, 다른 사람이나 손님의 요청, 루틴·위임으로 온 일에서는 알려 주지 않습니다. 에이전트의 답이 그 방 사람들에게 보이기 때문입니다. 기능 설명은 어디서나 합니다.

바꿀 수 있는 설정
- 하트비트: 아침 정리 시각(= 조용한 시간 끝), 내일 일정 요약 시각, 조용한 시간 시작, 일정 알림(10·15·30·60분 전), 조용한 시간에도 일정 알림 보내기, 하트비트 켜기·끄기, 하트비트 에이전트 바꾸기(켜져 있을 때만 — 꺼진 하트비트를 켜지는 않습니다). 하트비트는 계정마다 한 곳에서만 켤 수 있어 켜면 같은 계정의 다른 회사 하트비트가 꺼지고, 에이전트가 그 사실을 함께 알려 줍니다. 하트비트 켜기·끄기와 하트비트 에이전트 바꾸기는 주인의 1:1에서만 하고, 다른 곳의 요청은 결재 카드로도 올리지 않습니다.
- 자기 에이전트 카드: 역할, 러너(연결된 러너만 — 바꾸면 화면처럼 그 러너의 첫 모델로), 모델(지금 러너의 모델만 — 러너가 자동이면 먼저 러너를 정해야 합니다), 추론 강도(그 모델이 받는 단계만). 카드 화면과 같은 저장·검증을 거칩니다.
- 자기 카드의 일하는 방식 규칙 추가·삭제와 루틴 내용(매번 할 일, 380자까지): 오래 남아 계속 실행되는 지시라서 주인의 1:1에서도 결재 카드로 올라갑니다. 주인 1:1에서 올린 카드에는 바뀌기 전·후가 보이고, 승인하면 바뀝니다(그 사이 규칙이 바뀌었으면 적용하지 않습니다). 주인 1:1이 아닌 곳에서는 규칙을 번호로만 지울 수 있고 카드에도 "규칙 N번"만 보이며, 승인할 때 그때의 N번 규칙을 지웁니다(그 번호가 없으면 적용하지 않습니다). 손님의 요청으로는 규칙·루틴 변경을 결재로도 올리지 않습니다.
- 루틴: 실행 시각(시각이 하나인 1회·매일·매주 루틴), 제목, 요일(매주 루틴), 간격(N분마다 도는 루틴, 10~1440분), 켜기·끄기. 다른 에이전트의 루틴을 고치거나, 주인 1:1이 아닌 곳의 요청으로 고친 루틴은 이후 풀 오토 없이 돕니다(끄기는 제외).
- 에이전트 응답 언어(한국어·영어).
- 루틴 만들기는 예약 도구로, 지우기는 예약 정리 도구로 합니다(주인 1:1이면 바로, 그 밖은 결재). 에이전트 이름·팀, 다른 에이전트의 카드, 카드의 다른 섹션은 프로필 변경 결재로 합니다.
- 에이전트는 "내 설정 보여 줘"에 카드 화면과 같은 값(역할·러너·모델·추론 강도·스킬·MCP 범위·일하는 방식 규칙·하트비트 담당 여부·텔레그램 직통 봇·메신저 연결·내 루틴)으로 답합니다.

언제 바로 바뀌고, 언제 결재로 가나
- 회사 주인이 1:1로 직접 시킨 경우만 바로 바뀝니다: 데스크톱 앱의 에이전트 대화, 메신저에서 주인과 그 에이전트만 있는 1:1 방.
- 그 밖에서 온 요청은 주인에게 결재 카드로 올라가고, 주인이 승인하면 시스템이 바꿉니다: 조직 채널·회의실, 다른 사람의 요청, 루틴·장시간 작업, 다른 에이전트의 위임·쪽지, 텔레그램·슬랙, 터미널(argo) 대화.
- 어느 쪽인지는 앱이 판정합니다. 에이전트가 "주인이 시켰다"고 적어도 판정은 바뀌지 않습니다.
- 바로 바꾼 뒤에는 이전 값 → 새 값과 되돌리는 법을 알려 줍니다(예: "08:00 → 07:00으로 바꿨습니다. 되돌리려면 8시로 되돌려 달라고 하시거나 에이전트 카드 → 하트비트 탭에서 바꾸세요").

에이전트가 바꾸지 못하는 것(사용자가 화면에서 직접)
- 결제·요금제·지출 한도, 풀 오토 모드, 컴퓨터 유즈, 자격 증명 동기화.
- API 키·토큰·로그인 연결(설정 → AI 연결, 설정 → 연결의 텔레그램·슬랙·외부 서비스 연결).
- 삭제·해고(회사 삭제, 에이전트 해고, 기억·데이터 삭제).
- 권한·공유 범위(하트비트가 무엇을 읽을지 — 메일 확인 켜기 포함, 에이전트의 스킬·MCP 사용 범위, 누구와 나눌지, 조직 멤버).`,
  },
  en: {
    title: 'Asking agents about Argo and letting them change settings',
    keywords: ['change settings', 'setting change', 'agent changes settings', 'permission', 'approval', 'undo', 'applied immediately', 'status check', 'argo status', 'what can be changed'],
    body: `Agents can read Argo's current state and change some settings themselves.

What they can read (same values as the screens — only in the company owner's 1:1)
- Deck numbers (memory, agents, Memory Links % with the calculation, composition, daily accrual), the agent list with runner/model and whether each is working, routines and their last results, the heartbeat status, cross-device sync, runner connections (key values are never shown), plan and usage, messenger and notification connections, pending approvals.
- State and setting values are shared only in the company owner's 1:1 (the agent chat in the desktop app, or a Messenger 1:1 room with just the owner and that agent). They are not shared in organization channels or the Meeting Room, for requests from other people or guests, or in work that came from routines or delegation — the agent's answer is visible to the people in that room. Feature explanations are available anywhere.

Settings they can change
- Heartbeat: morning summary time (= quiet hours end), tomorrow's summary time, quiet hours start, event reminder (10/15/30/60 min before), still send reminders during quiet hours, heartbeat on/off, which agent is the heartbeat agent (only while it is on — it never turns heartbeat on). Heartbeat runs in one company per account, so turning it on turns off heartbeat in your other company, and the agent tells you so. Turning heartbeat on/off and switching its agent happen only in the owner's 1:1; requests from elsewhere are not filed as approval cards either.
- Their own agent card: role, runner (connected runners only — switching picks that runner's first model, like the screen), model (only the current runner's models — with an Auto runner, set the runner first), reasoning effort (only levels that model accepts). Saved and checked the same way as the card screen.
- Adding or removing a working rule on their own card, and a routine's instruction (up to 380 characters): these are standing instructions that keep running, so they go to an approval card even in the owner's 1:1. A card filed in the owner's 1:1 shows before and after, and approving applies it (not applied if the rules changed in the meantime). Outside the owner's 1:1, rules can be removed only by number and the card shows just "rule #N"; on approval the rule at #N at that time is removed (not applied if there is no such number). Requests from guests never file rule or routine changes.
- Routines: time (once/daily/weekly routines with a single time), title, weekdays (weekly routines), interval (every-N-minutes routines, 10–1440), on/off. A routine changed for another agent, or changed through a request from outside the owner's 1:1, then runs without full auto (turning it off excluded).
- Agent response language (Korean/English).
- Creating routines uses the scheduling tool and deleting uses the schedule cleanup tool (immediate in the owner's 1:1, otherwise an approval). Agent name and team, other agents' cards, and other card sections go through a profile-change approval.
- Asked "show my settings", an agent answers with the same values as its card screen (role, runner, model, effort, skill/MCP scope, working rules, whether it is the heartbeat agent, Telegram bot, Messenger link, its routines).

When a change applies immediately vs. goes to approval
- Only when the company owner asked directly in a 1:1: the agent chat in the desktop app, or a Messenger 1:1 room with just the owner and that agent.
- Requests from anywhere else go to the owner as an approval card, and the system applies the change once approved: organization channels and the Meeting Room, other people's requests, routines and long tasks, delegation or mail from other agents, Telegram/Slack, and terminal (argo) chats.
- The app decides which case applies. An agent writing "the owner asked" does not change the decision.
- After an immediate change, the agent tells you old value → new value and how to undo it (e.g. "Changed 08:00 → 07:00. To undo, ask me to set it back to 8:00, or change it in Agent card → Heartbeat tab").

What agents can never change (the user does it on screen)
- Billing, plan, and spending limit; Full auto mode; computer use; credential sync.
- API keys, tokens, and login connections (Settings → AI connection; Telegram, Slack, and external service connections under Settings → Connections).
- Deletion and firing (deleting the company, firing agents, deleting memory or data).
- Permissions and sharing scope (what heartbeat may read — including turning on mail check, an agent's skill/MCP scope, who things are shared with, organization members).`,
  },
};
