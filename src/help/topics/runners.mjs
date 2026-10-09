// 도움말 — 러너 연결(설정 → AI 연결): 러너 종류, API 키·구독 로그인·이 컴퓨터 로그인, 재연결 필요, 회사 기본 러너, 러너가 없을 때와 대체 실행, 구독 사용량
export default {
  id: 'runners',
  ko: {
    title: '러너 연결 (AI 연결)',
    keywords: ['러너', 'AI 연결', 'API 키', '구독 연결', 'Claude 연결', 'Codex 연결', '재연결 필요', '기본 러너', '대체 실행', '사용 한도', '러너 없음'],
    body: `러너는 에이전트를 실제로 움직이는 AI 엔진입니다. 사용자가 연결한 러너만 에이전트가 씁니다. 설정 → AI 연결 → "러너 연결" 카드에서 연결합니다. 데크의 "설정에서 연결하기", 대화 실패 때의 "AI 연결 열기", 모델 메뉴의 "연결하기 →"도 같은 곳으로 갑니다.

**러너 종류와 연결 방식**
- Claude: API 키, 또는 구독(OAuth) 토큰. 터미널에서 claude setup-token을 실행해 마지막에 나오는 토큰을 붙여넣습니다. 맥 데스크톱 앱에서는 "브라우저로 바로 연결"도 됩니다. 구독은 Pro·Max·Team·Enterprise 대상입니다.
- Codex: API 키, 또는 "연결 — 로그인 페이지 열기"로 브라우저에서 승인. 이 컴퓨터의 Codex CLI 로그인을 쓰는 "이 컴퓨터 로그인 사용"도 됩니다.
- Grok: API 키, 또는 계정 로그인(링크를 열고 화면의 코드를 입력).
- Gemini·GLM·Kimi·OpenRouter: API 키. "키 발급" 링크로 발급처에 갈 수 있습니다.
- Antigravity: "이 컴퓨터 로그인 사용"만 됩니다. 이 컴퓨터에 agy CLI를 설치하고 로그인해 둡니다.
- "저장·확인"을 누르면 실제로 확인한 뒤 저장합니다. 나중에 "연결 확인"으로 다시 확인할 수 있습니다.

**상태 표시**
- "미연결", "연결됨 · 방식", "이번 달 n턴".
- "재연결 필요": 저장된 토큰 형식이 맞지 않거나, 더 이상 제공되지 않는 방식(예: Gemini 구독)입니다. 아래에서 다시 연결합니다.
- "마지막 사용 시 오류가 났습니다", "자격 확인에 실패했습니다": 만료·철회됐을 수 있으니 다시 연결합니다.
- "연결 해제"는 이 회사의 모든 기기·모든 에이전트에서 그 러너 연결을 없앱니다.

**어떤 러너로 도나**
- 에이전트 카드나 모델 단추에서 러너를 지정합니다. "자동"이면 회사 기본 러너, 없으면 연결 순서(Claude → Codex → Gemini → GLM → Kimi → OpenRouter → Grok → Antigravity)로 고릅니다.
- 회사 기본 러너: 설정 → 일반 → 회사 정보 카드의 "기본 러너". 러너가 2개 이상 연결됐을 때만 보입니다.
- 지정 러너가 연결돼 있지 않거나 인증 오류가 나면 다른 연결 러너가 대신 답하고 "…이(가) 대신 답했습니다"로 알립니다. 반복되면 그 러너를 다시 연결하세요.
- 사용 한도·잔액 소진이나 구독 사용 차단은 다른 러너로 넘기지 않고 이유를 보여 줍니다. 잠시 뒤 다시 보내거나 다른 러너를 지정합니다.
- 연결된 러너가 하나도 없으면 데크에 안내가 뜨고, 대화는 "연결된 AI 러너가 없습니다"와 "AI 연결 열기"를 보여 줍니다.

**사용량**
- 구독으로 연결하면 사용량이 그 구독의 한도에서 차감됩니다. API 키는 발급처가 사용량만큼 청구합니다.
- Claude 구독·Codex(ChatGPT 로그인)·GLM 코딩 플랜은 입력창 오른쪽에 사용 한도 막대가 보입니다. 누르면 창별 사용률과 리셋까지 남은 시간이 나오고, 90%를 넘으면 빨갛게 바뀝니다.
- Antigravity 연결에서는 동료 답을 기다리는 위임·도구 설치·장시간 작업·에이전트 영입·루틴 취소를 쓸 수 없습니다.`,
  },
  en: {
    title: 'Runner connections (AI connection)',
    keywords: ['runner', 'AI connection', 'API key', 'subscription', 'connect Claude', 'connect Codex', 'reconnect needed', 'default runner', 'fallback', 'usage limit', 'no runner'],
    body: `A runner is the AI engine that actually powers an agent. Agents use only runners you connect. Connect them in Settings → AI connection → "Runner connections". "Connect in Settings" on the Deck, "Open AI connections" after a failed turn, and "Connect →" in the model menu all lead there.

**Runners and how to connect**
- Claude: an API key, or a subscription (OAuth) token. Run claude setup-token in a terminal and paste the token it prints at the end. In the Mac desktop app, "Connect via browser" also works. Subscriptions require Pro, Max, Team or Enterprise.
- Codex: an API key, or "Connect — open sign-in" to approve in your browser. "Use this computer's login" uses this computer's Codex CLI sign-in.
- Grok: an API key, or account sign-in (open the link and enter the code shown).
- Gemini, GLM, Kimi, OpenRouter: an API key. "Create a key" links to the provider.
- Antigravity: only "Use this computer's login". Install the agy CLI on this computer and sign in.
- "Save & test" verifies before saving. Use "Verify connection" to check again later.

**Status**
- "Not connected", "Connected · method", "{n} turns this month".
- "Reconnect needed": the stored token is malformed, or the method is no longer offered (for example a Gemini subscription). Reconnect below.
- "The last turn with this runner failed" or "A credential check failed": it may be expired or revoked; reconnect.
- "Disconnect" removes that runner for every device and every agent in this company.

**Which runner runs**
- Assign a runner in the agent card or the model button. "Auto" uses the company default runner, otherwise the connection order (Claude → Codex → Gemini → GLM → Kimi → OpenRouter → Grok → Antigravity).
- Company default runner: "Default runner" in Settings → General → Company Info. It appears only with two or more runners connected.
- If the assigned runner is not connected or hits an authentication error, another connected runner answers and a note says it "answered instead". If it repeats, reconnect that runner.
- An exhausted usage limit or balance, or a vendor block on subscription use, does not switch runners; you see the reason. Try again later or assign another runner.
- With no runner connected at all, the Deck shows a notice and chats show "No AI runner is connected" with "Open AI connections".

**Usage**
- With a subscription, usage counts against that subscription's limits. With an API key, the provider bills you for usage.
- Claude subscriptions, Codex (ChatGPT sign-in) and the GLM coding plan show a usage-limit bar to the right of the input. Click it for per-window usage and time until reset; it turns red above 90%.
- On an Antigravity connection, waiting delegation, tool installs, long tasks, hiring agents and cancelling routines are not available.`,
  },
};
