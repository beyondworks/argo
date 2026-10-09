// 데크(계기판) — 숫자 카드와 셈법. 셈법 설명은 src/deck-metrics.mjs(화면·argo_status와 같은 함수)와 맞춘다.
export default {
  id: 'deck',
  ko: {
    title: '데크 — 회사 계기판과 숫자 읽는 법',
    keywords: ['데크', '계기판', '기억 연결', '연결 밀도', '연결된 기억', '연결률', '쌍', '구성', '일별 기억 적립', '아침 조회', '명판', '토큰'],
    body: `데크는 회사에 들어가면 처음 보이는 계기판입니다. 왼쪽 위에 숫자 카드 네 장이 있습니다. 지금 값은 에이전트가 argo_status(section=deck)로 같은 셈법으로 읽을 수 있습니다.

- 기억: 회사에 쌓인 기억(일지·대화 기록 + 지식 노트) 전체 건수입니다. 칩의 "오늘 +N"은 오늘 날짜(UTC 기준 날짜)로 기록된 수, 아래 줄은 노트·일지 수와 "이번 주 배운 주제"(최근 7일 안에 바뀐 지식 노트 수)입니다.
- 에이전트: 이 회사의 에이전트 수입니다.
- 기억 연결: 다이얼의 %는 "연결된 기억" 비율입니다.
  - 셈: 링크가 1개 이상인 기억 수 ÷ (연결된 기억 + 고립된 기억) × 100, 화면은 반올림한 정수로 보여 줍니다.
  - 링크는 기억 안의 \`[[제목]]\` 같은 표기입니다. 전체 경로·파일 이름·제목 세 가지로 찾아 잇고, 같은 두 기억 사이는 한 쌍으로 셉니다(양방향 중복·자기 자신 링크는 세지 않음).
  - 칩의 "N쌍"은 이렇게 센 고유 연결 쌍의 수입니다.
  - 회사를 만들 때 생기는 안내 노트는 기억이 아니라서 셈에서 뺍니다. 그래서 새 회사도 모든 기억이 이어지면 100%가 됩니다.
  - 올리려면 고립된 기억을 다른 기억과 \`[[제목]]\` 링크로 이으면 됩니다. 기억 화면의 그래프에서 고립된 점을 볼 수 있습니다.
- 구성: 대화 기록과 지식 노트가 전체 기억에서 차지하는 비율 막대입니다.

그 밖의 카드
- 아침 조회 — 자리 비운 사이: 최근 16시간의 지시 처리·기억 기록·오류·결재 대기 수입니다.
- 결재함: 승인을 기다리는 결재 카드입니다. 여기서 승인·거절합니다.
- 최근 기억: 최근 기억 6건과 각 기억의 연결 수(다른 기억과 이어진 수)입니다.
- 일별 기억 적립: 최근 14일 동안 날짜별로 쌓인 기억 수, 전체 기억 수, 연결 쌍 수입니다.
- 오른쪽의 기억 그래프(크게 보기 ↗를 누르면 기억 화면), 명판(등록번호·사용자·취항일·에이전트·기억·엔진), 토큰(사용량)·사용 한도 카드가 있습니다.
- 데크의 입력창에 한 줄을 쓰면 새 에이전트를 영입합니다(에이전트 영입).`,
  },
  en: {
    title: 'Deck — the company dashboard and how to read its numbers',
    keywords: ['deck', 'dashboard', 'memory links', 'link density', 'linked memories', 'linked %', 'pairs', 'composition', 'daily memory accrual', 'morning brief', 'nameplate', 'token'],
    body: `The Deck is the dashboard you see first when you open a company. Four number cards sit at the top left. An agent can read the current values with argo_status (section=deck), using the same formulas.

- Memory: the total number of memories (journal/conversation records + knowledge notes). The "Today +N" chip counts records dated today (UTC date); the lines below show notes and journal counts and "Learned this week" (knowledge notes changed in the last 7 days).
- Agents: the number of agents in this company.
- Memory Links: the dial's % is the share of "linked memories".
  - Formula: memories with at least one link ÷ (linked + isolated memories) × 100; the screen shows it rounded to a whole number.
  - A link is a reference like \`[[title]]\` inside a memory. It is matched by full path, file name, or title, and each pair of memories counts once (no double counting both directions, no self-links).
  - The "N pairs" chip is the number of unique linked pairs counted this way.
  - The guide note created with a new company is not a memory, so it is left out; a new company reaches 100% once every memory is linked.
  - To raise it, link isolated memories to others with \`[[title]]\` links. The Memory screen graph shows isolated dots.
- Composition: bars for how much of all memory is conversations vs knowledge notes.

Other cards
- Morning brief — while you were away: turns done, memories, errors, and pending approvals in the last 16 hours.
- Approvals: approval cards waiting for you; approve or reject here.
- Recent Memory: the 6 latest memories and each one's link count.
- Daily Memory Accrual: memories added per day over the last 14 days, the total, and the number of link pairs.
- On the right: the memory graph (View larger ↗ opens the Memory screen), the nameplate (unit, user, commissioned date, agents, vault, engine), and the Token (usage) and usage limit cards.
- Typing one line in the Deck input hires a new agent (Hire agents).`,
  },
};
