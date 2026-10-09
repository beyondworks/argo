// 도움말 — 스킬·도구 화면: 스킬 설치·제거, 공방(스킬 직접 만들기), MCP 도구, 이 컴퓨터의 Claude Code 도구 가져오기, 직접 추가, 외부 서비스 연결(커넥터)
export default {
  id: 'market',
  ko: {
    title: '스킬·도구와 외부 서비스 연결',
    keywords: ['스킬', '도구', 'MCP', '플러그인', '공방', '스킬 만들기', '도구 설치', '외부 서비스 연결', '커넥터', '구글 연결', 'Claude Code 도구'],
    body: `스킬·도구 화면에서 에이전트가 쓸 지침서(스킬)와 외부 연결 도구(MCP)를 찾아 바로 설치합니다. 설치한 것은 다음 턴부터 반영됩니다. 사이드바 "스킬·도구"에서 엽니다.

**스킬 — 지시형 지침**
- 스킬은 에이전트가 따를 업무 매뉴얼입니다. 추천 목록이나 커뮤니티 스킬 검색에서 "즉시 설치"합니다.
- 항목을 누르면 "이게 뭐예요?", "언제 쓰면 좋아요?", "에이전트에게 이렇게 시켜보세요" 같은 쉬운 설명이 나옵니다.
- 설치된 항목의 "설치됨" 알약을 누르면 바로 제거됩니다.
- 대화 입력창에 /스킬이름을 치면 그 스킬을 쓰라는 지시가 입력창에 들어갑니다.
- 스킬이 너무 크면 "참조만 주입(예산 초과)", 너무 많으면 "미주입(설치 과다)" 표시가 붙습니다. 안 쓰는 스킬을 지우거나 내용을 줄이면 됩니다.

**공방 — 스킬 직접 만들기**
- 이름과 지시를 적고 "만들기"를 누르면 모든 에이전트의 다음 턴부터 적용됩니다. 발송·게시 같은 행동은 여전히 결재를 거칩니다.

**MCP 도구 — 외부 연결**
- 추천 목록이나 공식 레지스트리 검색에서 설치합니다. "키 필요" 칩이 붙은 도구는 키가 있어야 동작합니다.
- 이 컴퓨터의 Claude Code 도구: 이 컴퓨터의 Claude Code에 등록된 도구를 "가져오기"로 회사에 연결합니다. 설정(토큰 포함)이 그대로 복사되고, 기기 간 동기화 때는 암호화되어 전송됩니다.
- 직접 추가: 이름(영소문자·하이픈)과 실행 명령을 넣습니다. 키가 필요한 도구는 이 칸에 키를 적지 말고 환경변수로 넘깁니다.
- npx로 실행하는 도구와 직접 추가는 데스크톱 앱에서만 실행됩니다("데스크톱 앱 전용").
- MCP 도구는 Codex와 Claude·GLM·Kimi·OpenRouter·Grok 에이전트에서 쓰입니다. Antigravity 에이전트는 아직 쓸 수 없습니다.
- 에이전트가 일하다 필요한 도구를 직접 설치하기도 합니다. 설치 기록은 활동에 남습니다.

**에이전트별 사용 범위**
- 에이전트 카드의 "능력" 탭에서 에이전트마다 쓸 스킬·도구를 고릅니다. 기본은 "전체 사용"입니다.

**외부 서비스 연결** (설정 → 연결 → 외부 서비스 연결)
- 구글 계정처럼 로그인만으로 붙는 서비스입니다. API 키를 만들 필요가 없습니다.
- "연결"을 누르면 브라우저에 동의 화면이 열리고, 로그인을 마치면 상태가 "연결됨"으로 바뀝니다. "다시 연결"·"연결 해제"도 여기서 합니다.
- 연결 뒤에도 쓰기 작업은 사용자 결재 후에 실행됩니다. 카드에 결재가 필요한 쓰기 작업 수가 나옵니다.
- 이 빌드에서 아직 열리지 않은 서비스는 "준비 중"으로 보입니다.`,
  },
  en: {
    title: 'Skills & Tools and connected services',
    keywords: ['skills', 'tools', 'MCP', 'plugin', 'workshop', 'create skill', 'install tool', 'connected services', 'connector', 'Google', 'Claude Code tools'],
    body: `On Skills & Tools you find and install instructional guides (skills) and external connection tools (MCP) for your agents. Installed items apply from the next turn. Open it from "Skills & Tools" in the sidebar.

**Skills — instructional guides**
- A skill is a work manual agents follow. Install one with "Install now" from the recommendations or the community skill search.
- Click an item for a plain explanation: "What is this?", "When should I use it?", "Try instructing your agents like this".
- Clicking the "Installed" pill on an installed item removes it right away.
- Typing /skill-name in the chat input inserts an instruction to use that skill.
- Very large skills get "Reference only (over budget)", and with too many installed some get "Not injected (too many installed)". Remove unused skills or shorten them.

**Workshop — craft your own skill**
- Enter a name and instructions and press "Create". It applies to every agent from their next turn. Outbound actions such as sending or posting still go through approvals.

**MCP tools — external connections**
- Install from the recommendations or the official registry search. Tools with a "Needs key" chip work only with a key.
- Tools from this computer's Claude Code: "Import" connects tools already registered in this computer's Claude Code. The config (including tokens) is copied as is and encrypted when synced across devices.
- Custom: add a name (lowercase-hyphen) and a run command. For tools that need secrets, do not type keys here; use environment variables.
- Tools launched with npx and custom tools run only in the desktop app ("Desktop app only").
- MCP tools work for Codex and for Claude, GLM, Kimi, OpenRouter and Grok agents. Agents on Antigravity cannot use them yet.
- Agents may also install a tool they need while working; the install is recorded in Activity.

**Per-agent scope**
- In the agent card's "Abilities" tab, choose which skills and tools each agent uses. The default is "all".

**Connected services** (Settings → Connections → Connected services)
- Services you connect just by signing in, such as with a Google account. No API keys to create.
- "Connect" opens a consent screen in your browser; when you finish signing in, the status changes to "Connected". "Reconnect" and "Disconnect" are here too.
- Even after connecting, write actions run only after your approval; the card shows how many write actions need approval.
- Services not yet available in this build show "Coming soon".`,
  },
};
