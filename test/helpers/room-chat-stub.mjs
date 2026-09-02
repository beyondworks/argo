// 회의실 행동 테스트용 chat() 스텁 — room.mjs가 정적 임포트하는 './chat.mjs'만 이 파일로 바꿔 끼운다(리졸브 훅).
// 실 러너를 부르지 않고(자격·비용·브라우저 창 0 — 2026-08-31 교훈: 실 CLI를 타는 행동 테스트는 로그인 창을 띄운다)
// 발언 루프가 chat()을 **누구에게, 어떤 순서로, 어떤 첨부로** 불렀는지 기록한다.
//
// 사용법: register(new URL('./helpers/room-chat-stub.mjs', import.meta.url)) 뒤 room.mjs를 동적 임포트한다.
// 테스트가 같은 URL을 임포트하면 room.mjs가 받은 것과 같은 모듈 인스턴스라 state.calls를 읽을 수 있다
// (훅 스레드에 실린 인스턴스는 별개 — 거기선 resolve만 돈다). 다른 모듈(thread·crewmail 등)의 './chat.mjs'는
// 그대로 실물이다(parentURL 조건). node --test는 파일별 자식 프로세스라 다른 테스트 파일로 새지 않는다.
const SELF = import.meta.url;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === './chat.mjs' && /\/src\/room\.mjs$/.test(context.parentURL ?? '')) return { url: SELF, shortCircuit: true };
  return nextResolve(specifier, context);
}

export const state = { calls: [], reply: (slug) => `${slug} 답변` };
export async function chat(wsId, slug, prompt, sessionId, opts = {}) {
  state.calls.push({ wsId, slug, prompt, opts });
  return { reply: state.reply(slug), handover: null, artifacts: [] };
}
