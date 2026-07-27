// 원샷 실행 — 크루 채팅 밖의 단발 AI 호출(크루 카드 생성·직함 추천·기억 정리 등)을 러너 독립으로 돌린다.
// 실사용 신고(2026-07-19): 크루 영입이 Claude SDK 하드코딩이라 Codex만 연결한 사용자는 영입 자체가
// 불가였고, 에러 문구조차 "Claude 키를 연결하라"였다. 어떤 러너든 연결만 되면 이 경로도 돌아야 한다.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { paths } from './workspace.mjs';
import { GLM_DEFAULT_MODEL, KIMI_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL, RUNNERS, externalExec, isOpenRouterCreditError, resolveRunner, runnerCredEnv, sdkEnvFor } from './runners.mjs';

/** 단발 프롬프트 1회 실행 — resolveRunner로 가용 러너를 고르고(SDK 또는 벤더 CLI), 실패하면 그 러너를
    제외하고 1회 재시도한다(스테일 자격 오탐 자가 치유 — chat.mjs의 인증 재시도와 같은 원칙, 재귀 1회).
    model은 claude 러너일 때만 적용(다른 러너는 각자 기본 모델). 반환 { runner, text, usage, costUsd }. */
export async function runOneShot(wsId, prompt, opts = {}) {
  const { lang = 'ko', model = null, maxTurns = 1, timeoutMs = 120_000, __exclude = null } = opts;
  // 해석 실패(.secrets.json 손상 등)는 미가용으로 — 조용한 호스트 스캐빈징 금지(검수 MEDIUM, chat.mjs와 동일)
  // want=null(무선호) — 이 경로는 러너 독립이 명세라 claude 선호를 가장하지 않는다(선택 순서는 동일)
  const resolved = await resolveRunner(wsId, null, { exclude: __exclude })
    .catch(() => ({ runner: 'claude', available: false, fellBack: false, credButNoCli: [] }));
  if (!resolved.available) {
    // 자격은 연결됐는데 벤더 CLI가 없는 러너(codex/gemini)는 원인을 정확히 — chat.mjs 게이트와 같은 안내.
    // (실사고 2026-07-20: Gemini OAuth만 연결한 Windows 사용자가 "하나도 연결돼 있지 않습니다"를 받아
    //  설정의 '연결됨' 배지와 정면 모순 — 어느 쪽도 거짓말은 아니었지만 사용자에겐 둘 다 거짓이 된다)
    const noCli = (resolved.credButNoCli ?? []).map((id) => RUNNERS[id]?.name || id);
    throw new Error(noCli.length
      ? (lang === 'en'
          ? `${noCli.join('/')} is connected but its CLI is not installed on this computer — install it, or connect Claude (no install needed) in Settings → AI connections.`
          : `${noCli.join('/')} 자격은 연결됐지만 이 컴퓨터에 해당 CLI가 설치돼 있지 않습니다 — CLI를 설치하거나, 설치가 필요 없는 Claude를 설정 → AI 연결에서 연결해 주세요.`)
      : (lang === 'en'
          ? 'No AI runner is connected — connect Claude, Codex, Gemini, or GLM in Settings → AI connections.'
          : 'AI 러너가 하나도 연결돼 있지 않습니다 — 설정 → AI 연결에서 Claude·Codex·Gemini·GLM·Kimi·OpenRouter 중 하나를 연결해 주세요.'));
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
        // openrouter는 카탈로그 검증 — 호출자가 넘긴 타 러너용 모델(예: consolidate의 claude-haiku
        // 하드코딩)이 그대로 나가면 OpenRouter에 없는 id라 400으로 전멸한다(2R 검수 H1: openrouter-only
        // 회사의 기억 정리 100% 실패). 카탈로그 밖 id는 기본 모델로 강등(chat.mjs 경로와 동일 원칙).
        ...(runner === 'glm' ? { model: GLM_DEFAULT_MODEL } : runner === 'kimi' ? { model: KIMI_DEFAULT_MODEL }
          : runner === 'openrouter' ? { model: RUNNERS.openrouter.models.some((m) => m.id === model) ? model : OPENROUTER_DEFAULT_MODEL }
          : (model ? { model } : {})),
      },
    })) {
      if (msg.type === 'result') {
        usage = msg.usage; costUsd = msg.total_cost_usd;
        if (msg.subtype === 'success') text = msg.result; else failed = msg.subtype;
      }
    }
    if (!text?.trim()) throw new Error(failed || 'empty-reply');
    // 402를 성공으로 두면 그 문구가 크루 카드·기억 노트에 영구 저장된다(검수 HIGH-1) — 실패로
    // 승격해 자가치유(다른 가용 러너 1회)·정직한 오류 경로를 태운다.
    if (runner === 'openrouter' && isOpenRouterCreditError(text)) {
      throw new Error(`openrouter-credit: ${text.slice(0, 140)}`);
    }
    return { runner, text: text.trim(), usage, costUsd: runner === 'openrouter' ? null : costUsd };
  } catch (e) {
    // 자가 치유 — 방금 죽은 러너를 제외하고 다른 가용 러너로 1회. __exclude 가드로 재귀 1회 제한.
    if (!__exclude) {
      const alt = await resolveRunner(wsId, 'claude', { exclude: runner }).catch(() => null);
      if (alt?.available && alt.runner !== runner) {
        console.warn(`[argo] 원샷 ${runner} 실패(${String(e.message).slice(0, 80)}) — ${alt.runner}로 재시도(${wsId})`);
        return runOneShot(wsId, prompt, { ...opts, __exclude: runner });
      }
    }
    // 402(크레딧 소진)는 연결 문제가 아니다 — "연결 상태 확인" 안내는 키 정상·연결됨 표시와 모순돼
    // 사용자를 오도한다(2R 검수 N2, oneshot 상단 주석의 2026-07-20 모순과 동일 계열). 충전처를 준다.
    if (/openrouter-credit/.test(String(e.message))) {
      throw Object.assign(new Error(lang === 'en'
        ? 'OpenRouter credit balance is too low. OpenRouter is prepaid — top up at https://openrouter.ai/settings/credits and try again.'
        : 'OpenRouter 크레딧 잔액이 부족합니다. OpenRouter는 선불제입니다 — https://openrouter.ai/settings/credits 에서 충전 후 다시 시도해 주세요.'), { cause: e });
    }
    throw Object.assign(new Error(lang === 'en'
      ? `AI call failed — check the runner connection in Settings → AI connections. (${String(e.message).slice(0, 120)})`
      : `AI 호출이 실패했습니다 — 설정 → AI 연결에서 러너 연결 상태를 확인해 주세요. (${String(e.message).slice(0, 120)})`), { cause: e });
  }
}
