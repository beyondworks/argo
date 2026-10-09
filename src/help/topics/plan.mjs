// 도움말 — 요금제(Free·Pro에서 앱이 보여 주는 차이), AI 사용 비용과 구독 연결, 사용량·토큰 보기, 사용 한도 막대
export default {
  id: 'plan',
  ko: {
    title: '요금제와 사용량',
    keywords: ['요금제', '요금', 'Pro', 'Free', '무료', '업그레이드', '구독 관리', '사용량', '토큰', '사용 한도', '비용', '청구'],
    body: `**요금제**
- Argo 요금제는 Free와 Pro입니다. 결제하지 않아도 이 기기에서는 에이전트·대화·기억·루틴 같은 기능을 그대로 씁니다.
- Pro가 여는 것은 여러 기기 동기화입니다. Free에서는 동기화 카드에 "이 기기에만 저장됩니다 · 여러 기기 동기화는 Pro"가 보입니다. 종단간 암호화도 동기화가 도는 상태(Pro)에서 켭니다.
- 요금제와 가격은 설정 → 기기·데이터 → 기기 간 동기화 카드에서 봅니다. 업그레이드 단추에 현재 가격이 표시되고, 결제하려면 먼저 로그인해야 합니다(결제는 계정에 연결됩니다).
- 구독 중이면 같은 카드의 "구독 관리"에서 결제 수단·해지를 다룹니다. 해지를 예약하면 "해지 예약됨 — 날짜까지 이용 가능"이 보입니다.
- 결제가 확인되지 않으면 결제 수단을 확인하라는 안내가 나오고, 확인될 때까지 클라우드는 잠시 유지됩니다.
- Pro가 아닌데 클라우드에 회사 사본이 있으면 삭제 예정일이 안내됩니다. "클라우드 자료 내보내기"로 결제 없이 내려받을 수 있습니다.
- 예전에 가입해 체험 중인 계정은 "무료 체험 D-n"이 보입니다.

**AI 사용 비용**
- 에이전트가 쓰는 AI 비용은 Argo 요금제와 별개로, 내가 연결한 러너 계정에서 나갑니다.
- API 키로 연결하면 발급처(Anthropic·OpenAI 등)가 사용량만큼 청구합니다.
- 구독으로 연결하면(예: Claude Pro·Max) 그 구독의 사용 한도에서 차감되고, Argo가 따로 청구하지 않습니다.
- 사용량을 줄이려면: 긴 대화는 "새 대화로 아끼기", 회의실은 "1라운드만", 경쟁 시안은 모델 수를 줄이고, 위임 제한은 켜 둡니다.

**사용량 보기**
- 데크의 "토큰" 카드: 입력(읽은 맥락)·출력(생성)·캐시 적중률·누적. 금액은 표시하지 않습니다. 첫 턴 전에는 "다음 턴부터 사용량이 기록됩니다"가 보입니다.
- 에이전트 카드 → 개요 → 상세 정보: 그 에이전트가 처리한 턴, 읽은 맥락/생성, 평균 턴 시간, 많이 쓴 도구.
- 설정 → AI 연결: 러너마다 "이번 달 n턴".
- 사용 한도 막대: Claude 구독·Codex(ChatGPT 로그인)·GLM 코딩 플랜으로 도는 에이전트는 대화 입력창 오른쪽에 작은 막대가 보입니다. 누르면 창(예: 5시간·7일)별 사용률과 "리셋까지 남은 시간"이 나오고, 90%를 넘으면 빨갛게 바뀝니다. 오래된 값이면 "n시간 전 기준"이 붙습니다.`,
  },
  en: {
    title: 'Plans and usage',
    keywords: ['plan', 'pricing', 'Pro', 'Free', 'upgrade', 'subscription', 'manage subscription', 'usage', 'tokens', 'usage limit', 'cost', 'billing'],
    body: `**Plans**
- Argo has two plans, Free and Pro. Without paying you keep using agents, chats, memory, routines and the rest on this device.
- Pro unlocks multi-device sync. On Free the sync card says "Stored on this device only · multi-device sync is Pro". End-to-end encryption is also turned on while sync is active (Pro).
- See plans and prices in Settings → Devices & data → Cross-device Sync. The upgrade button shows the current price, and you must sign in first to pay (the subscription is tied to your account).
- If you subscribe, "Manage subscription" on the same card handles payment methods and cancellation. A scheduled cancellation shows "Cancellation scheduled — available until date".
- If a payment does not go through you are asked to check your payment method, and cloud stays on for a grace period.
- If you are not on Pro and the cloud holds a copy of your company, a deletion date is shown. "Export Cloud Data" downloads it with no payment needed.
- Older accounts still on a free trial see "Trial: {n}d left".

**AI costs**
- What agents spend on AI is separate from your Argo plan and comes from the runner accounts you connected.
- With an API key, the provider (Anthropic, OpenAI, etc.) bills you for usage.
- With a subscription (for example Claude Pro or Max), usage counts against that subscription's limits, and Argo does not charge anything extra.
- To use less: start a fresh chat when a chat gets long ("Save with a fresh chat"), use "One round only" in the Meeting Room, pick fewer models in Contest, and keep the delegation limit on.

**Seeing usage**
- The "Token" card on the Deck: In (context read), Out (generated), cache hit rate and cumulative totals. No money amounts are shown. Before the first turn it says "Usage will be tracked starting next turn".
- Agent card → Overview → Details: that agent's turns, context/output, average turn time and top tools.
- Settings → AI connection: "{n} turns this month" per runner.
- Usage-limit bar: agents running on a Claude subscription, Codex (ChatGPT sign-in) or the GLM coding plan show a small bar to the right of the chat input. Click it for usage per window (for example 5 hours, 7 days) and time until reset; it turns red above 90%. Older readings are marked "as of {n}h ago".`,
  },
};
