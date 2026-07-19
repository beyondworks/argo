// 원샷 실행 — 크루 채팅 밖의 단발 AI 호출(크루 카드 생성·직함 추천·기억 정리 등)을 러너 독립으로 돌린다.
// 실사용 신고(2026-07-19): 크루 영입이 Claude SDK 하드코딩이라 Codex만 연결한 사용자는 영입 자체가
// 불가였고, 에러 문구조차 "Claude 키를 연결하라"였다. 어떤 러너든 연결만 되면 이 경로도 돌아야 한다.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { paths } from './workspace.mjs';
import { GLM_DEFAULT_MODEL, externalExec, resolveRunner, runnerCredEnv, sdkEnvFor } from './runners.mjs';

/** 단발 프롬프트 1회 실행 — resolveRunner로 가용 러너를 고르고(SDK 또는 벤더 CLI), 실패하면 그 러너를
    제외하고 1회 재시도한다(스테일 자격 오탐 자가 치유 — chat.mjs의 인증 재시도와 같은 원칙, 재귀 1회).
    model은 claude 러너일 때만 적용(다른 러너는 각자 기본 모델). 반환 { runner, text, usage, costUsd }. */
export async function runOneShot(wsId, prompt, opts = {}) {
  const { lang = 'ko', model = null, maxTurns = 1, timeoutMs = 120_000, __exclude = null } = opts;
  // 해석 실패(.secrets.json 손상 등)는 미가용으로 — 조용한 호스트 스캐빈징 금지(검수 MEDIUM, chat.mjs와 동일)
  const resolved = await resolveRunner(wsId, 'claude', { exclude: __exclude })
    .catch(() => ({ runner: 'claude', available: false, fellBack: false }));
  if (!resolved.available) {
    throw new Error(lang === 'en'
      ? 'No AI runner is connected — connect Claude, Codex, Gemini, or GLM in Settings → AI connections.'
      : 'AI 러너가 하나도 연결돼 있지 않습니다 — 설정 → AI 연결에서 Claude·Codex·Gemini·GLM 중 하나를 연결해 주세요.');
  }
  const runner = resolved.runner;
  try {
    if (runner === 'codex' || runner === 'gemini') {
      const cred = await runnerCredEnv(wsId, runner); // 회사 자격 우선, 없으면 호스트 로그인
      const text = (await externalExec({ runner, cwd: paths(wsId).root, prompt, cred, timeoutMs })).trim();
      if (!text) throw new Error('empty-reply');
      return { runner, text, usage: {}, costUsd: null }; // 외부 CLI — 토큰 사용량 비노출(채팅 경로와 동일)
    }
    const sdkEnv = await sdkEnvFor(wsId, runner);
    let text = ''; let failed = null; let usage = null; let costUsd = null;
    for await (const msg of query({
      prompt,
      options: {
        cwd: paths(wsId).root,
        allowedTools: [], // 순수 생성 — 도구 불필요
        settingSources: [], // 호스트 머신의 CLAUDE.md 등 미주입(테넌트 격리)
        maxTurns,
        ...(sdkEnv ? { env: sdkEnv } : {}),
        ...(runner === 'glm' ? { model: GLM_DEFAULT_MODEL } : (model ? { model } : {})),
      },
    })) {
      if (msg.type === 'result') {
        usage = msg.usage; costUsd = msg.total_cost_usd;
        if (msg.subtype === 'success') text = msg.result; else failed = msg.subtype;
      }
    }
    if (!text?.trim()) throw new Error(failed || 'empty-reply');
    return { runner, text: text.trim(), usage, costUsd };
  } catch (e) {
    // 자가 치유 — 방금 죽은 러너를 제외하고 다른 가용 러너로 1회. __exclude 가드로 재귀 1회 제한.
    if (!__exclude) {
      const alt = await resolveRunner(wsId, 'claude', { exclude: runner }).catch(() => null);
      if (alt?.available && alt.runner !== runner) {
        console.warn(`[argo] 원샷 ${runner} 실패(${String(e.message).slice(0, 80)}) — ${alt.runner}로 재시도(${wsId})`);
        return runOneShot(wsId, prompt, { ...opts, __exclude: runner });
      }
    }
    throw Object.assign(new Error(lang === 'en'
      ? `AI call failed — check the runner connection in Settings → AI connections. (${String(e.message).slice(0, 120)})`
      : `AI 호출이 실패했습니다 — 설정 → AI 연결에서 러너 연결 상태를 확인해 주세요. (${String(e.message).slice(0, 120)})`), { cause: e });
  }
}
