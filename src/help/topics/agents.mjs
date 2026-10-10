// 도움말 — 에이전트 영입·에이전트 카드(탭별)·정보 수정·해고·러너/모델/추론 강도 고르기·회사가 아는 사용자 카드
export default {
  id: 'agents',
  ko: {
    title: '에이전트 영입과 에이전트 카드',
    keywords: ['에이전트', '영입', '채용', '해고', '에이전트 카드', '정보 수정', '모델 바꾸기', '러너 지정', '추론 강도', '팀', '기억 카드', '회사가 아는 사용자'],
    body: `에이전트는 회사에서 일하는 AI 직원입니다. 한 줄 소개로 영입하고, 대화 화면의 카드에서 성격·능력·엔진을 고칩니다.

**영입**
- 데크의 입력창(또는 사이드바 "에이전트 영입")에 필요한 전문가를 한 줄로 적고 "에이전트 영입"을 누릅니다. 예: 뉴스레터를 쓰는 시니어 에디터.
- 입력창이 비어 있으면 "예시로 시작" 칩 3개가 보입니다. 누르면 입력창에 채워집니다.
- "옵션"을 펼치면 이름(비우면 자동 작명)과 팀을 정할 수 있습니다. 같은 이름이 있어도 덮어쓰지 않고 새 에이전트로 만듭니다.
- 영입은 AI 턴 한 번을 씁니다. 연결된 러너가 없으면 영입되지 않으니 먼저 설정 → AI 연결에서 러너를 연결합니다.
- 영입되면 사이드바에 나타나고, 시운전으로 첫 인사와 샘플 결과물이 대화 첫 줄에 남습니다.
- 사이드바에서 에이전트를 고정하거나, 같은 그룹 안에서 끌어 순서를 바꾸고, 팀 이름 옆 연필로 팀 이름을 바꿉니다.

**에이전트 카드** (대화 화면 위쪽 "카드" 또는 입력창에 /card)
- 개요: 최근 자주 한 일, "엔진 — 러너·모델"과 추론 강도, 상세 정보(처리한 턴·읽은 맥락/생성·평균 턴 시간·많이 쓴 도구).
- 능력: 설치된 스킬·플러그인(MCP)을 칩으로 켜고 끕니다. 전부 켜면 "전체 사용"이라 새로 설치한 것도 자동 적용되고, 일부만 켜면 새 설치는 자동 적용되지 않습니다.
- 방식: "일하는 방식 — 규칙"을 추가·수정·순서 변경·삭제합니다. 아래 "회사가 아는 사용자 — 기억 카드"에는 에이전트가 대화에서 기록한 취향·결정·금지가 모이고, "잊기"로 지우거나 직접 추가합니다. 이 카드는 회사의 모든 에이전트가 같이 봅니다.
- 하트비트: 이 에이전트를 하트비트로 쓰는 설정입니다(하트비트 주제 참고).
- 연결·원문: 텔레그램 직통 봇 연결과 "카드 원문 — 시스템 프롬프트 그대로" 편집. 원문은 "원문 저장"을 눌러야 저장됩니다.
- 카드의 변경은 다음 턴부터 반영됩니다.

**정보 수정과 해고** (카드 아래)
- "정보 수정": 이름·역할·팀·러너·모델을 바꿉니다. 주소와 지난 기록은 그대로 유지됩니다. 러너를 바꾸면 모델은 그 러너의 첫 모델로 바뀝니다.
- "해고": 에이전트 이름과 "해고하겠습니다"를 똑같이 입력해야 실행됩니다. 카드는 바로 지워지지 않고 보관되며, 이 에이전트가 남긴 기억은 회사에 남습니다. 이 에이전트에 걸린 루틴은 "에이전트 없음"으로 멈춥니다.

**러너·모델·추론 강도 고르기**
- 입력창 아래 오른쪽 "엔진" 단추에서 러너·모델을 고릅니다. "자동"이면 회사 기본 러너나 연결 순서대로 고릅니다. 고르면 바로 저장되고 다음 턴부터 적용됩니다. 답변 중에는 잠깁니다.
- 연결 안 된 러너는 흐리게 보이고 "연결하기 →"로 설정에 갑니다.
- 추론 강도는 카드 개요 탭에서 고르며 Claude·Codex로 실행될 때만 적용됩니다.
- 고른 모델을 그 러너에서 쓸 수 없으면 기본 모델로 답하고 그 사실을 답 위에 알립니다.`,
  },
  en: {
    title: 'Hiring agents and the agent card',
    keywords: ['agent', 'hire', 'fire', 'agent card', 'edit info', 'change model', 'runner', 'reasoning effort', 'team', 'memory card', 'what the company knows about you'],
    body: `Agents are the AI staff of your company. You hire one with a one-line brief and adjust its persona, abilities and engine in the card on its chat screen.

**Hiring**
- On the Deck, type the expert you need in one line (or use "Hire agents" in the sidebar) and press "Hire agents". Example: a senior editor who writes newsletters.
- When the box is empty, "Start from an example" shows three chips that fill the box.
- Open "Options" to set a name (auto-generated if empty) and a team. A duplicate name never overwrites an existing agent; a new one is created.
- Hiring uses one AI turn. Without a connected runner it fails, so connect one first in Settings → AI connection.
- The new agent appears in the sidebar, and a trial run leaves a greeting and a sample result at the top of its chat.
- In the sidebar you can pin agents, drag to reorder within a group, and rename a team with the pencil next to it.

**The agent card** ("Card" at the top of the chat, or /card in the input)
- Overview: recent work, "Engine — runner & model" with reasoning effort, and details (turns, context/output, avg turn time, top tools).
- Abilities: toggle installed skills and plugins (MCP) as chips. With everything on ("all"), new installs apply automatically; with a partial list, new installs are not added.
- Working style: add, edit, reorder or delete "Working rules". Below it, "What the company knows about you" collects the preferences, decisions and no-gos agents recorded; "Forget" removes an item, or add one yourself. Every agent in the company sees this card.
- Heartbeat: settings for using this agent for heartbeat (see the heartbeat topic).
- Links & raw: the direct Telegram bot, and "Raw card — the system prompt itself". Raw edits are saved only with "Save raw card".
- Card changes apply from the next turn.

**Edit info and Fire** (bottom of the card)
- "Edit info": change name, role, team, runner and model. The address and past records stay. Changing the runner switches the model to that runner's first model.
- "Fire": you must type the agent's name and "fire this agent". The card is archived rather than deleted immediately, and the agent's memories stay with the company. Routines assigned to it pause as "Agent missing".

**Choosing runner, model and reasoning effort**
- Use the "Engine" button at the bottom right of the input. "Auto" uses the company default runner or the connection order. Choices save immediately and apply from the next turn; the button is locked while the agent is replying.
- Unconnected runners are dimmed, with "Connect →" leading to Settings.
- Reasoning effort is set in the card's Overview tab and applies only when running on Claude or Codex.
- If the chosen model is not available on that runner, the default model answers and a note says so above the reply.`,
  },
};
