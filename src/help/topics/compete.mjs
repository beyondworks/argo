// 도움말 — 경쟁 시안: 같은 과제를 한 에이전트에게 모델 2~3개로 동시에 맡겨 비교·채택하는 화면
export default {
  id: 'compete',
  ko: {
    title: '경쟁 시안',
    keywords: ['경쟁 시안', '경쟁', '시안 비교', '모델 비교', '여러 모델', '채택', '초안 비교', '새 경쟁'],
    body: `경쟁 시안은 같은 과제를 에이전트 1명에게 모델 2~3개로 동시에 맡기고, 나온 시안을 나란히 비교해 하나를 채택하는 화면입니다. 사이드바 "경쟁 시안"에서 엽니다.

**시작하기**
- 왼쪽 "새 경쟁"을 누르고 과제를 적습니다. 예: "신제품 출시 공지문 초안 작성".
- 에이전트 1명을 고르고, 모델 칸 1·2번을 채웁니다. 3번은 "+ 모델 추가"로 선택합니다. 과제·에이전트·모델 2개가 모두 있어야 "경쟁 시작"이 눌립니다.
- 모델 수만큼 답이 동시에 실행되므로 비용도 그만큼(약 n배) 듭니다. 화면에 안내가 나옵니다.
- 연결된 러너가 없으면 모델 칸 대신 설정으로 가는 링크가 보입니다. 먼저 설정 → AI 연결에서 러너를 연결합니다.

**진행과 채택**
- 시안 카드가 모델별로 나란히 생기고, 완성되는 대로 내용이 보입니다(시안 작성 중 → 완성, 실패하면 실패 표시와 이유).
- 마음에 드는 시안에서 "이 시안 채택"을 누르고 확인합니다.
- 채택본만 그 에이전트의 대화에 기록되어, 대화에서 이어서 지시할 수 있습니다. 경쟁 중의 다른 답변은 에이전트 대화를 어지럽히지 않습니다.
- 채택이 끝난 경쟁은 읽기 전용이 되고 "에이전트 대화로 이동" 링크가 보입니다.

**기록**
- 왼쪽 "경쟁 기록"에 지난 경쟁이 쌓여 다시 열어 볼 수 있습니다.
- 활동 화면에는 출처 "경쟁 시안"으로 남습니다.`,
  },
  en: {
    title: 'Contest',
    keywords: ['contest', 'compare drafts', 'compare models', 'multiple models', 'adopt', 'side by side', 'new contest'],
    body: `Contest runs the same brief on one agent with 2–3 models at once, shows the drafts side by side, and lets you adopt one. Open it from "Contest" in the sidebar.

**Starting**
- Click "New contest" on the left and write the brief, e.g. "Draft the launch announcement".
- Pick one agent and fill model slots 1 and 2; slot 3 is optional via "+ Add model". "Start contest" is enabled only with a brief, an agent and at least two models.
- Every model runs at the same time, so cost is roughly multiplied by the number of models. The screen says so.
- With no runner connected, the model slots are replaced by a link to Settings. Connect a runner in Settings → AI connection first.

**Progress and adopting**
- One draft card per model appears side by side and fills in as each finishes (Drafting → Done, or Failed with the reason).
- Press "Adopt this draft" on the one you like and confirm.
- Only the adopted draft is written into that agent's chat, where you can continue instructing. The other drafts do not clutter the agent's chat.
- A contest with an adopted draft becomes read only and shows "Open agent thread".

**History**
- Past contests stay under "Contests" on the left.
- In Activity they appear with the source "contest".`,
  },
};
