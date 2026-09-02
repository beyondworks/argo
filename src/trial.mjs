// 영입 시운전 — 영입 직후 크루가 스스로 첫 인사 + 샘플 산출물을 만들어 보인다.
// 목적: "영입했는데 뭐라고 시키지?"의 빈 화면(첫 3분 이탈)을 없앤다. 실패해도 영입은 유효하다.
import { chat } from './chat.mjs';
import { appendTurn } from './thread.mjs';
import { resolveRunner, visibleRunnerNamesLine } from './runners.mjs'; // 실패 원인 판별 — "연결 없음"과 "연결됐는데 실행 실패"를 구분

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
        artifacts: r.artifacts, // 시운전 프롬프트가 "샘플 산출물을 만들어라"다 — 첫인상 칩(검수 HIGH)
      });
    } catch (e) {
      const m = String(e.message || e);
      // 첫 턴이 터지면 빈 화면 대신 크루 첫 메시지로 안내를 남긴다(가장 저비용 경로).
      // 문구는 **실제 상태로 갈린다** — 예전엔 인증류 에러를 전부 "AI 연결 안 됨 + Claude 키 연결"로
      // 뭉뚱그려, Kimi를 연결해 둔 사용자가 "연결됐는데 왜 안 됐다고 하지?"를 겪었다(실사용 문의
      // 2026-07-25). 러너 독립 원칙(2026-07-19)상 특정 러너를 하드코딩하지도 않는다.
      // 5초 상한 — resolveRunner는 호스트 CLI 프로브를 타므로, 행이 걸리면 안내 자체가 안 남아
      // 이 기능이 없애려던 빈 화면으로 회귀한다(검수 LOW-9). 초과 시 보수적으로 '연결됨' 문구.
      const connected = await Promise.race([
        resolveRunner(wsId, null).then((r) => r.available).catch(() => false),
        new Promise((r) => setTimeout(r, 5_000, true)),
      ]);
      // 서버측이라 UI 언어를 모른다 — ko/en 병기(다국어 규칙: 하드코딩 단일언어 금지)
      const reply = connected
        ? `첫 시운전이 실패했어요 — AI 연결은 되어 있으니 지시를 한 번 더 보내주시면 이어서 시작할게요.\n(원인: ${m.slice(0, 200)})\n\nThe trial run failed — your AI runner is connected, so just send an instruction and I'll pick it up.\n(Reason: ${m.slice(0, 200)})`
        : `AI 연결이 아직 안 되어 있어요. 설정 → AI 연결에서 ${visibleRunnerNamesLine()} 중 하나를 연결하면 바로 일을 시작할게요.\n\nAI isn't connected yet. Connect any runner (${visibleRunnerNamesLine('en')}) in Settings → AI connections and I'll get started right away.`;
      await appendTurn(wsId, slug, {
        userMsg: '(영입 시운전) 첫 인사와 샘플 산출물을 보여주세요.',
        reply, handover: null, sessionId: null,
      }).catch(() => {});
      console.error(`[argo] 시운전 실패(${wsId}/${slug}):`, e.message);
    }
  })();
}
