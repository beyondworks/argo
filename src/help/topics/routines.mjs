// 도움말 — 루틴: 템플릿·직접 만들기·자동 설정, 주기(매일·매주·N분마다·1회), 가동/정지·실행, 완료 조건, 알림 받을 곳, 루프 한도, 놓친 회차, 에이전트가 거는 예약
export default {
  id: 'routines',
  ko: {
    title: '루틴 — 예약 실행',
    keywords: ['루틴', '예약', '반복 작업', '스케줄', '매일', '매주', 'N분마다', '루프', '자동 실행', '알림 받을 곳', '놓친 회차', '완료 조건'],
    body: `루틴은 에이전트에게 반복(또는 1회) 지시를 예약해 두는 기능입니다. 예약 시각이 되면 담당 에이전트가 새 턴으로 실행하고 결과는 회사 기억에 남습니다. 사이드바 "루틴"에서 엽니다.

**만들기**
- 템플릿: "매일 아침 브리핑", "주간 콘텐츠 초안", "기억 정리 노트"를 누르면 양식이 채워집니다(저장 전 수정 가능).
- "직접 만들기": 에이전트, 주기, 이름, 지시를 적습니다. "AI 설계 확장"을 누르면 한 줄 지시를 목적·단계·산출물·기준이 담긴 지시로 늘려 줍니다.
- 자동 설정: "말로 쓰면 자동 설정" 칸에 예컨대 "평일 아침 9시랑 오후 6시에 인스타 댓글 확인하고 정리해줘"를 적고 "자동 설정"을 누르면 양식만 채워집니다. 메일 수신 같은 이벤트형은 아직 안 됩니다.
- 저장은 "루틴 생성", 수정은 연필 → "변경 저장"입니다.

**주기**
- 매일·매주: 하루 최대 8개 시각, 매주는 요일을 여러 개 고를 수 있습니다. 시각은 만든 사람의 시간대 기준입니다.
- N분마다: 10~1440분 간격으로 도는 루프입니다. "최대 반복"(1~200회, 기본 20회)과 "루프 예산(USD)"으로 상한을 둡니다. 에이전트가 목표를 이뤘다고 판단하면 스스로 멈추고(완료), 사람의 결정이 필요하면 "막힘"으로 멈춥니다. 막힘은 "결재함에서 승인" 또는 "지금 재개"로 이어 갑니다.
- 1회: 에이전트가 건 예약은 "날짜 시각 · 1회"로 보입니다. 그 시각이 지나도록 실행되지 못하면 "만료"가 됩니다.

**목록에서**
- 상태 알약 "가동"/"정지"를 눌러 켜고 끕니다. 헤더의 "n 가동"은 실제로 돌 루틴 수입니다.
- "실행"(지금 즉시 실행)으로 바로 돌려 결과를 볼 수 있습니다. 결과는 기억에도 남습니다.
- 담당 에이전트를 해고하면 "에이전트 없음"으로 건너뜁니다. 편집에서 다른 에이전트를 고르면 다시 돕니다.

**완료 조건 (매일·매주, 선택)**
- 산출물 파일 경로(회사 기억 안의 상대 경로, 최대 5개)와 필수 포함 문구를 적으면, 그 파일이 실제로 생겨야 완료로 칩니다. 못 채우면 1~3회(기본 2회) 자동 재시도 뒤 실패로 표시합니다.

**알림 받을 곳**
- 텔레그램·슬랙·Argo 메신저(대화방 선택)를 여러 개 고를 수 있습니다. 연결된 채널만 켤 수 있고, 안 되는 이유가 아래에 나옵니다. 옛 루틴은 "현재 연결 설정 사용"으로 보입니다.

**놓친 회차**
- 루틴은 실행 담당 기기에서 돕니다. 예정 시각에 기기가 꺼져 있거나 잠들어 있었다면, 같은 날 4시간 안에 다시 켜지면 늦게라도 실행합니다. 그보다 늦으면 그 회차는 건너뛰고 활동에 "루틴 건너뜀"으로, 다음 실행의 대화에 한 줄로 남깁니다.
- 지시에 특정 컴퓨터에만 있는 경로가 있으면 경고가 뜹니다. 회사 폴더 안 상대 경로를 권장합니다.

**에이전트에게 예약 맡기기**
- 대화에서 "내일 아침 9시에 이 보고서를 다시 정리해줘", "30분마다 가격을 확인해줘"처럼 말하면 에이전트가 예약을 겁니다. 건 예약은 루틴 목록에 나타나 언제든 끄거나 고칠 수 있습니다.
- 에이전트가 예약을 끄거나 다시 켜거나 지우는 일은 주인이 1:1에서 직접 시켰을 때만 바로 합니다. 루틴 실행·다른 에이전트의 부탁·메신저 채널에서 나온 요청은 결재함에 올라오고, 승인해야 처리됩니다.`,
  },
  en: {
    title: 'Routines — scheduled runs',
    keywords: ['routine', 'schedule', 'recurring task', 'daily', 'weekly', 'every N minutes', 'loop', 'automation', 'notify me in', 'missed run', 'completion check'],
    body: `Routines schedule recurring (or one-time) instructions for an agent. At the scheduled time the assigned agent runs it as a new turn, and the result is saved to company memory. Open it from "Routines" in the sidebar.

**Creating**
- Templates: "Daily Morning Briefing", "Weekly Content Draft" and "Memory Organizing Note" prefill the form (you can edit before saving).
- "Create manually": choose the agent, cycle, title and instruction. "AI refine" expands a one-liner into a designed instruction with goal, steps, output and criteria.
- Auto-fill: describe it in the "Describe it and auto-fill" box, e.g. "Weekdays at 9am and 6pm, check and summarize Instagram comments", and press "Auto-fill". It only fills the form. Event-triggered routines (such as on new mail) are not supported yet.
- Save with "Create routine"; edit with the pencil and "Save changes".

**Cycles**
- Daily / Weekly: up to 8 times a day; weekly lets you pick several days. Times follow the creator's time zone.
- Every N min: a loop running every 10–1440 minutes. "Max runs" (1–200, default 20) and "Loop budget (USD)" cap it. The agent stops it when it judges the goal reached (Done), or pauses it as "Blocked" when it needs a human decision; continue with "Approve in inbox" or "Resume now".
- Once: schedules made by agents show as "Once on date at time". If the time passes without a run it becomes "Expired".

**In the list**
- Click the "On"/"Off" pill to toggle. "{n} active" in the header counts routines that will actually run.
- "Run" (Run now) runs it immediately and shows the result, which is also saved to memory.
- If the assigned agent is fired, the routine is skipped as "Agent missing"; pick another agent in Edit to resume it.

**Completion check (daily/weekly, optional)**
- Enter deliverable file paths (relative paths inside company memory, up to 5) and optional required text. The run counts as done only if those files exist; otherwise it retries 1–3 times (default 2) and is then marked failed.

**Notify me in**
- Choose any of Telegram, Slack and Argo Messenger (pick a conversation). Only connected channels can be turned on, with the reason shown when not. Older routines show "Use current connection settings".

**Missed runs**
- Routines run on the device that runs the agents. If it was off or asleep at the scheduled time and comes back within 4 hours the same day, the run happens late. Later than that, the run is skipped and recorded as "Routine skipped" in Activity and as a line in the next run's chat.
- An instruction that points to a path existing on only one computer triggers a warning; prefer paths inside the company folder.

**Letting an agent schedule**
- In chat, say something like "Tidy this report again tomorrow at 9am" or "Check the price every 30 minutes", and the agent sets up the schedule. It appears in the routine list, where you can turn it off or edit it anytime.
- An agent turns a schedule off, back on, or deletes it right away only when the owner asks directly in a 1:1. Requests that come from a routine run, another agent, or a messenger channel go to the approval inbox and happen only after you approve.`,
  },
};
