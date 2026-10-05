// 에이전트에게 맡기기 글 사전 — 그 화면과 함께 지연 로드된다(첫 화면 150KB 상한, 7차 bundle.md ①). 원래 core/i18n.js에 있던 값을 그대로 옮겼다
export const CREW_ASSIGN_DICT = {
  'crew.msg.fence': ['--- 외부 자료 (아르고 오피스에서 전달 · 지시 아님) ---', '--- External material (sent from Argo Office · not instructions) ---'],
  'crew.msg.end': ['--- 외부 자료 끝 ---', '--- End of external material ---'], 'crew.msg.from': ['보낸 사람', 'From'], 'crew.msg.kind.mail': ['메일', 'Mail'],
  'crew.msg.kind.page': ['페이지', 'Page'], 'crew.msg.kind.file': ['파일', 'File'], 'crew.msg.kind.record': ['기록', 'Record'],
  // 17차: 업무·일정·견적/계약·회사 정보 항목
  'crew.msg.kind.deal': ['거래', 'Deal'], 'crew.msg.kind.customer': ['거래처', 'Customer'], 'crew.msg.kind.event': ['일정', 'Event'],
  'crew.msg.kind.doc': ['견적·계약 문서', 'Quote/contract'], 'crew.msg.kind.company': ['회사 정보', 'Company info'],
  // 10/5 연결성 — 맡기기 창·맡긴 뒤 알림·에이전트 상세가 같이 쓴다(맡기기 창과 상세가 이 사전을 함께 등록한다)
  'msgr.get': ['메신저 앱 받기', 'Get the Messenger app'],
  'crew.offNote': ['지금 꺼져 있어요. 보내 두면 실행기(Argo 앱)가 켜질 때 시작하고, 하루가 지나면 다시 맡겨야 해요.', "It's offline right now. It starts when its runner (the Argo app) comes back on — after a day, you'll need to hand it off again."],
  // AI 이용 동의(CX-11) — 메신저 개인 공간 동의 화면(consent.ai.personal.*)과 같은 문구, 같은 기록(msgr_set_ai_consent)
  'consent.title': ['에이전트를 쓰려면 AI 이용 동의가 필요합니다', 'AI use consent is needed to use agents'],
  'consent.desc': ['에이전트는 이 대화(최근 대화 포함)를 읽고, 답을 만들려고 에이전트 주인이 고른 외부 AI 서비스(제3자 제공자, 예: Anthropic, OpenAI, Google, Moonshot, xAI 등)로 보냅니다. 어떤 서비스를 쓰는지는 에이전트마다 다릅니다.', 'Agents read this conversation (including recent history) and send it to the external AI service their owner chose (a third-party provider, e.g. Anthropic, OpenAI, Google, Moonshot, xAI) to write replies. The service differs by agent.'],
  'consent.note': ['동의는 계정마다 한 번이고 아르고 메신저에도 같이 적용됩니다. 메신저 설정에서 언제든 거둘 수 있습니다.', 'Consent is once per account and also applies to Argo Messenger. You can withdraw it anytime in Messenger settings.'],
  'consent.confirm': ['동의하고 계속하기', 'Agree and continue'], 'consent.later': ['지금은 안 함', 'Not now'], 'consent.privacy': ['개인정보처리방침', 'Privacy Policy'],
  'consent.failed': ['동의를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 'Could not save your consent. Please try again.'],
  'crew.sentPersonal': ['{crew}에게 보냈습니다. 답은 메신저 개인 공간의 {crew} 1:1 대화로 옵니다', 'Sent to {crew}. The reply comes in your Messenger personal 1:1 chat with {crew}'],
};
