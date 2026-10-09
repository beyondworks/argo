// 도움말 — Argo 메신저 연결 카드(파견·응답 상태·다시 연결), 알림 받을 메신저, 텔레그램 연결(BotFather 토큰·연결 코드), 슬랙 연결, 텔레그램 직통 봇
export default {
  id: 'messenger',
  ko: {
    title: '메신저 연결 — Argo 메신저·텔레그램·슬랙',
    keywords: ['메신저', 'Argo 메신저', '텔레그램', '슬랙', '파견', '알림 받을 메신저', '연결 코드', '페어링', 'BotFather', '직통 봇', '다시 연결'],
    body: `메신저를 연결하면 자리를 비운 동안에도 에이전트에게 일을 시키고 결과·결재 알림을 받습니다. 모두 설정 → 연결 탭에 있습니다. 에이전트는 내 컴퓨터(실행 담당 기기)에서 돌기 때문에, 그 기기가 켜져 있어야 메신저에 답합니다.

**Argo 메신저 연결**
- Argo 계정으로 로그인하면 내 에이전트가 메신저 개인 공간에 바로 연결됩니다. "메신저 받기"로 앱(맥·윈도우·iOS·Android)을 받습니다.
- 팀과 쓰려면 메신저에서 조직을 만들거나 초대 링크로 들어온 뒤, 이 카드에서 조직을 고르고 "에이전트 n명 연결" 또는 "연결 안 된 에이전트 추가"를 누릅니다. 조직 채널에서 @로 부르면 연결한 에이전트가 답합니다.
- 누가 시킬 수 있는지(허용 범위)·파견 해제·다시 파견은 메신저 앱의 에이전트 카드에서 바꿉니다.
- "메신저 응답 상태"에 "정상 응답 중"이 보이면 연결된 것입니다. "이 기기의 Argo 로그인이 필요합니다"면 로그인하고, "이 회사를 만든 Argo 계정으로 로그인해야…"면 그 계정으로 로그인합니다. 응답이 없으면 "다시 연결"(또는 "다시 확인")을 누릅니다.

**알림 받을 메신저**
- 아르고 메신저·텔레그램·슬랙 중 체크한 곳으로 결재 요청·작업 완료·쪽지·루틴 결과가 갑니다. 여러 개를 켜면 모두에 갑니다.
- 연결된 메신저만 켤 수 있고, 안 되는 이유(로그인 필요·파견된 에이전트 없음·연결 안 됨)가 옆에 보입니다. 아르고 메신저 알림은 그 에이전트와 나의 1:1 대화로 옵니다.
- 루틴마다 받을 곳을 따로 정할 수도 있습니다(루틴 주제 참고).

**텔레그램 연결**
- 텔레그램의 @BotFather로 봇을 만들고 토큰을 붙여넣은 뒤 "가동"합니다.
- 카드에 6자리 연결 코드가 보이면 텔레그램에서 그 봇에게 코드를 그대로 보냅니다. 코드를 보낸 사람만 연결되고, 그 뒤로는 그 사람만 지시·결재를 할 수 있습니다.
- "@에이전트 이름 지시"로 특정 에이전트를 부르고, 이름 없이 보내면 기본 에이전트가 받습니다. "에이전트"라고 보내면 연결 현황을 답하고, 결재는 버튼으로 처리합니다.
- "다른 기기가 수신 중 — 이 기기는 대기합니다"는 정상입니다. 그 기기가 꺼지면 이 기기가 이어받습니다.

**슬랙 연결**
- 봇 토큰(xoxb-)과 채널 ID를 넣고 봇을 그 채널에 초대합니다. 카드의 6자리 코드를 채널에 보내면 보낸 사람이 사용자로 고정됩니다.
- 채널 메시지가 에이전트에게 전달되고, 결재는 "승인 <번호>" 또는 "거절 <번호>"로 회신합니다.

**텔레그램 직통 봇** (에이전트 카드 → 연결·원문 탭)
- 에이전트마다 전용 봇을 둘 수 있습니다. @BotFather로 만든 토큰을 넣고 "연결"한 뒤, 봇에게 연결 코드를 DM으로 보냅니다.
- DM은 그 에이전트와 1:1이며 앱의 대화와 이어집니다. 그룹에 초대해 @멘션하거나 봇 메시지에 답장하면 그룹에서도 함께 일합니다.
- 하나의 봇 토큰은 한 곳에만 연결할 수 있습니다.`,
  },
  en: {
    title: 'Messenger connections — Argo Messenger, Telegram, Slack',
    keywords: ['messenger', 'Argo Messenger', 'Telegram', 'Slack', 'dispatch', 'notifications', 'pairing code', 'pair', 'BotFather', 'direct bot', 'reconnect'],
    body: `Connect a messenger to give agents work and receive results and approval requests while you are away. Everything is under Settings → Connections. Agents run on your computer (the device that runs the agents), so it must be on for them to answer in a messenger.

**Argo Messenger connection**
- Signing in with your Argo account connects your agents to your personal space in the messenger right away. "Get the messenger" leads to the apps (Mac, Windows, iOS, Android).
- To work with a team, create an organization in the messenger or join with an invite link, then pick the organization on this card and press "Connect {n} agents" or "Add unconnected agents". Mention a connected agent with @ in an org channel and it replies there.
- Who can task an agent (access scope), recalling and re-dispatching are changed on the agent card in the messenger app.
- "Responding normally" under "Messenger response status" means it works. If it says this device needs an Argo login, sign in; if it says to sign in with the account that created this company, use that account. If there is no response, press "Reconnect" (or "Check again").

**Where to receive agent notifications**
- Approval requests, task results, agent mail and routine results go to whichever of Argo Messenger, Telegram and Slack you check; check several to receive on all.
- Only connected messengers can be turned on, and the reason is shown next to the others (sign in first, no agents dispatched, not connected). Argo Messenger notifications arrive in your one-on-one conversation with that agent.
- Each routine can also have its own destinations (see the routines topic).

**Telegram**
- Create a bot with @BotFather in Telegram, paste its token and turn it "On".
- When the card shows a 6-character pairing code, send that code to the bot in Telegram. Only the person who sends it is connected, and from then on only that person can give instructions and approve.
- Address an agent with "@name task"; messages without a name go to the default agent. Send "agents" for the roster; approvals arrive as buttons.
- "Another device is receiving — this device stands by" is normal; this device takes over if the other one goes offline.

**Slack**
- Enter the bot token (xoxb-) and channel ID, and invite the bot to that channel. Post the card's 6-character code in the channel; whoever posts it is locked in as the user.
- Channel messages go to agents. Approve or reject by replying "승인 <id>" or "거절 <id>".

**Direct Telegram Bot** (agent card → Links & raw tab)
- Each agent can have its own bot. Paste a token made with @BotFather, press "Connect", then DM the pairing code to the bot.
- A DM is a one-on-one line to that agent and continues the same chat as the app. Invite the bot to a group and @mention it or reply to it to work together there.
- One bot token can be connected in only one place.`,
  },
};
