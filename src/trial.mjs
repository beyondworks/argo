// 영입 시운전 — 영입 직후 크루가 스스로 첫 인사 + 샘플 산출물을 만들어 보인다.
// 목적: "영입했는데 뭐라고 시키지?"의 빈 화면(첫 3분 이탈)을 없앤다. 실패해도 영입은 유효하다.
import { chat } from './chat.mjs';
import { appendTurn } from './thread.mjs';

const TRIAL_PROMPT = `방금 이 회사에 영입되었다. 사장에게 첫 인사를 하라.
① 두 문장 자기소개 — 무엇을 맡고, 어떻게 일하는지.
② 네 역할에 맞는 샘플 산출물 1건을 지금 바로 만들어 보여줘라. 사장 지시 없이도 무엇을 할 수 있는지 보여주는 시운전이다 — 짧고 실전적으로.
③ 마지막 줄에 "이런 일을 시켜보세요:" 뒤에 지시 예시 2개.
전체 15줄 이내. 결재가 필요한 행동은 하지 마라.`;

/** 백그라운드 실행 — 영입 API 응답을 막지 않는다. 스레드에 첫 대화로 남아 채팅을 열면 바로 보인다. */
export function runTrialTurn(wsId, slug) {
  (async () => {
    try {
      const r = await chat(wsId, slug, TRIAL_PROMPT, null, { source: 'trial' });
      await appendTurn(wsId, slug, {
        userMsg: '(영입 시운전) 첫 인사와 샘플 산출물을 보여주세요.',
        reply: r.reply, handover: r.handover, sessionId: r.sessionId,
      });
    } catch (e) {
      const m = String(e.message || e);
      // 키 미설정/인증 실패로 첫 턴이 터지면 빈 화면 대신 크루 첫 메시지로 안내를 남긴다(가장 저비용 경로)
      if (/anthropic|api[\s._-]?key|x-api-key|credit|balance|401|authentication|unauthorized/i.test(m)) {
        await appendTurn(wsId, slug, {
          userMsg: '(영입 시운전) 첫 인사와 샘플 산출물을 보여주세요.',
          reply: 'AI 연결이 아직 안 되어 있어요. 설정 → AI 연결에서 Claude API 키를 넣어주시면 바로 일을 시작할게요. (Anthropic 콘솔에서 키를 발급받아 붙여넣으면 됩니다.)',
          handover: null, sessionId: null,
        }).catch(() => {});
      }
      console.error(`[argo] 시운전 실패(${wsId}/${slug}):`, e.message);
    }
  })();
}
