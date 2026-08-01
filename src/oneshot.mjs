// 원샷 실행 — 크루 채팅 밖의 단발 AI 호출(크루 카드 생성·직함 추천·기억 정리 등)을 러너 독립으로 돌린다.
// 실사용 신고(2026-07-19): 크루 영입이 Claude SDK 하드코딩이라 Codex만 연결한 사용자는 영입 자체가
// 불가였고, 에러 문구조차 "Claude 키를 연결하라"였다. 어떤 러너든 연결만 되면 이 경로도 돌아야 한다.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { paths } from './workspace.mjs';
import { GLM_DEFAULT_MODEL, KIMI_DEFAULT_MODEL, OPENROUTER_ONBOARD_MODEL, RUNNERS, excludeWith, externalExec, isCliRunner, isProcessCrash, isOpenRouterCreditError, isOpenRouterLimitError, resolveRunner, runnerCredEnv, sdkEnvFor } from './runners.mjs';

/** 단발 프롬프트 1회 실행 — resolveRunner로 가용 러너를 고르고(SDK 또는 벤더 CLI), 실패하면 그 러너를
    누적 제외하고 남은 가용 러너를 차례로 시도한다(스테일 자격 오탐 자가 치유 — chat.mjs의 인증 재시도와
    같은 누적 제외 원칙. 다만 이쪽은 실패 종류를 가리지 않고, chat.mjs는 AUTH_ERR_RE 한정이다).
    model은 claude 러너일 때만 적용(다른 러너는 각자 기본 모델). 반환 { runner, text, usage, costUsd }. */
export async function runOneShot(wsId, prompt, opts = {}) {
  // timeoutMs는 **두 실행 경로 공통** 상한이다(검수 2026-07-27 M-3): CLI는 externalExec가, SDK는
  // 아래 AbortController가 같은 값을 쓴다. 러너에 따라 상한이 갈리면 같은 작업이 codex로 뽑히면
  // 잘리고 claude로 뽑히면 안 잘린다 — 이 파일의 존재 이유(러너 독립)와 정면 충돌한다.
  // 오래 걸리는 배치(기억 정리)는 호출자가 명시로 늘린다.
  const { lang = 'ko', model = null, maxTurns = 1, timeoutMs = 120_000, __exclude = null, __crashRetry = false } = opts;
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
          ? 'No AI runner is connected — connect Claude, Codex, Gemini, Antigravity, GLM, Kimi, or OpenRouter in Settings → AI connections.'
          : 'AI 러너가 하나도 연결돼 있지 않습니다 — 설정 → AI 연결에서 Claude·Codex·Gemini·Antigravity·GLM·Kimi·OpenRouter 중 하나를 연결해 주세요.'));
  }
  const runner = resolved.runner;
  let hangGuard = null;            // SDK 경로 hang 상한 타이머 — 아래 finally에서 항상 해제
  const ac = new AbortController(); // catch에서도 봐야 한다(중단 원인을 정직한 문구로 바꾸기 위해)
  try {
    if (isCliRunner(runner)) {
      const cred = await runnerCredEnv(wsId, runner); // 회사 자격 우선, 없으면 호스트 로그인
      const text = (await externalExec({ runner, cwd: paths(wsId).root, prompt, cred, timeoutMs })).trim();
      if (!text) throw new Error('empty-reply');
      return { runner, text, usage: {}, costUsd: null }; // 외부 CLI — 토큰 사용량 비노출(채팅 경로와 동일)
    }
    const sdkEnv = await sdkEnvFor(wsId, runner);
    let text = ''; let failed = null; let usage = null; let costUsd = null;
    // 행(hang) 상한 — SDK 경로엔 타임아웃이 없어 소켓 정체 시 이 async iterator가 영영 안 끝난다.
    // 그러면 호출자(스케줄러)의 in-flight 표시가 안 풀려 그 회사 기억 정리가 **무증상 영구 정지**한다
    // (검수 2026-07-27 M-1). 외부 CLI 경로는 이미 timeoutMs로 상한이 있어 두 경로를 맞추는 것이기도 하다.
    // 지연 SLO가 아니라 순수 hang 가드라 넉넉히 잡는다 — 정상 작업을 잘라내면 안 된다.
    hangGuard = setTimeout(() => ac.abort(), timeoutMs);
    for await (const msg of query({
      prompt,
      options: {
        abortController: ac,
        cwd: paths(wsId).root,
        allowedTools: [], // 순수 생성 — 도구 불필요
        settingSources: [], // 호스트 머신의 CLAUDE.md 등 미주입(테넌트 격리)
        maxTurns,
        ...(sdkEnv ? { env: sdkEnv } : {}),
        // openrouter는 카탈로그 검증 — 호출자가 넘긴 타 러너용 모델(예: consolidate의 claude-haiku
        // 하드코딩)이 그대로 나가면 OpenRouter에 없는 id라 400으로 전멸한다(2R 검수 H1: openrouter-only
        // 회사의 기억 정리 100% 실패). 카탈로그 밖 id는 기본 모델로 강등(chat.mjs 경로와 동일 원칙).
        ...(runner === 'glm' ? { model: GLM_DEFAULT_MODEL } : runner === 'kimi' ? { model: KIMI_DEFAULT_MODEL }
          : runner === 'openrouter' ? { model: RUNNERS.openrouter.models.some((m) => m.id === model) ? model : OPENROUTER_ONBOARD_MODEL }
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
    // 429(요청 한도)도 성공으로 두면 그 문구가 크루 카드·기억 노트에 저장된다 — 402와 대칭 승격.
    if (runner === 'openrouter' && isOpenRouterLimitError(text)) {
      throw new Error(`openrouter-limit: ${text.slice(0, 140)}`);
    }
    return { runner, text: text.trim(), usage, costUsd: runner === 'openrouter' ? null : costUsd };
  } catch (err) {
    // 중단 원인 정정 — abort는 루프 안에서 throw하고 SDK 메시지가 "process aborted by user"다.
    // 그대로 두면 아무도 정지를 안 눌렀는데 "사용자가 중단"으로 읽히고, 자가치유 로그·최종 안내
    // 어디에도 "상한에 걸렸다"는 흔적이 없다 — 이 PR이 없애려던 무증상성이 문구로 남는다(검수 M-1).
    const e = ac.signal.aborted
      ? Object.assign(new Error(`sdk-timeout: ${Math.round(timeoutMs / 1000)}초 안에 응답이 끝나지 않아 중단했습니다`), { cause: err })
      : err;
    // 429(요청 한도)는 자가치유 대상이 아니다 — 일시적 한도인데 다른 벤더로 넘기면 사용자 고지 없이
    // 실제 과금 키로 갈아타게 된다(2R 검수 M1). 402(지속적 잔액 소진)와 달리 기다리면 풀린다.
    if (/openrouter-limit/.test(String(e.message))) {
      throw Object.assign(new Error(lang === 'en'
        ? 'OpenRouter rate limit reached (free models: 20/min, and 50/day until $10+ in lifetime credits). Wait a moment and try again, or switch to a paid model.'
        : 'OpenRouter 요청 한도에 걸렸습니다(무료 모델은 분당 20회, 누적 구매 $10 미만이면 하루 50회). 잠시 후 다시 시도하거나 유료 모델로 바꿔 주세요.'), { cause: e });
    }
    // 러너 프로세스가 크래시로 죽었으면 **같은 러너로 1회 먼저** 다시 건다. 크래시는 자격·크레딧이
    // 아니라 그 순간 프로세스가 죽은 것이라 대개 다시 걸면 붙는다. 아래 러너 교체보다 앞에 둔다 —
    // 첫 크래시에 바로 벤더를 갈아타면 사용자가 고른 엔진이 조용히 바뀌고 과금처도 달라진다.
    if (!__crashRetry && isProcessCrash(e?.message)) {
      console.warn(`[argo] 원샷 ${runner} 프로세스 비정상 종료 — 같은 러너로 1회 재시도(${wsId})`);
      return runOneShot(wsId, prompt, { ...opts, __crashRetry: true });
    }
    // 자가 치유 — 죽은 러너를 **누적 제외**하고 남은 가용 러너를 차례로 시도한다. 재귀는 제외 목록이
    // 매번 1개씩 늘어 러너 수(≤7)로 자연 종료된다. (이전: 1회 제한 — 4러너 연결 상태에서 앞의 둘이
    // 고장나자 멀쩡한 나머지 둘은 시도도 못 받고 영입이 통째로 실패했다. 라이브 재현 2026-07-30.
    // "한 벤더가 죽으면 회사가 선다"는 러너 중립성 원칙 위반이다.)
    // want=null — 선호를 두지 않는다(이전 'claude'는 같은 파일 상단 주석과 모순된 표류였다).
    // (__crashRetry는 ...opts로 이월된다 — 크래시 재시도는 이 체인 전체에서 1회다.)
    {
      const tried = excludeWith(__exclude, runner);
      const alt = await resolveRunner(wsId, null, { exclude: tried }).catch(() => null);
      if (alt?.available && !tried.includes(alt.runner)) {
        console.warn(`[argo] 원샷 ${runner} 실패(${String(e.message).slice(0, 80)}) — ${alt.runner}로 재시도(${wsId}, 제외 ${tried.join(',')})`);
        return runOneShot(wsId, prompt, { ...opts, __exclude: tried });
      }
    }
    // 402(크레딧 소진)는 연결 문제가 아니다 — "연결 상태 확인" 안내는 키 정상·연결됨 표시와 모순돼
    // 사용자를 오도한다(2R 검수 N2, oneshot 상단 주석의 2026-07-20 모순과 동일 계열). 충전처를 준다.
    if (/openrouter-credit/.test(String(e.message))) {
      throw Object.assign(new Error(lang === 'en'
        ? 'OpenRouter credit balance is too low. OpenRouter is prepaid — top up at https://openrouter.ai/settings/credits and try again.'
        : 'OpenRouter 크레딧 잔액이 부족합니다. OpenRouter는 선불제입니다 — https://openrouter.ai/settings/credits 에서 충전 후 다시 시도해 주세요.'), { cause: e });
    }
    // 크래시는 "연결을 확인하라"가 **거짓 안내**다. 실사용 신고 2026-08-02: 크레딧도 남아 있고 연결도
    // 정상인 사용자가 이 문구를 받고 "러너 연결 정상인데 왜 계속 실패하죠?"라고 되물었다. 우리가 이미
    // 재시도·러너 교체까지 해봤다는 사실과, 이게 연결·잔액 문제가 아니라는 사실을 그대로 말한다.
    if (isProcessCrash(e?.message)) {
      throw Object.assign(new Error(lang === 'en'
        ? `The AI program crashed on this computer (it was terminated by the OS, not by Argo). This is not a connection or credit problem — Argo already retried and tried other connected runners. If it keeps happening, reinstalling the runner CLI usually fixes it; security software blocking the process is the other common cause. (${String(e.message).slice(0, 120)})`
        : `AI 프로그램이 이 컴퓨터에서 비정상 종료됐습니다(Argo가 아니라 운영체제가 프로세스를 강제 종료했습니다). 연결이나 크레딧 문제가 아닙니다 — Argo가 이미 다시 시도했고, 연결된 다른 러너로도 넘겨봤습니다. 계속 반복되면 러너 CLI 재설치로 해결되는 경우가 많고, 보안 프로그램이 프로세스를 막는 것도 흔한 원인입니다. (${String(e.message).slice(0, 120)})`), { cause: e });
    }
    throw Object.assign(new Error(lang === 'en'
      ? `AI call failed — check the runner connection in Settings → AI connections. (${String(e.message).slice(0, 120)})`
      : `AI 호출이 실패했습니다 — 설정 → AI 연결에서 러너 연결 상태를 확인해 주세요. (${String(e.message).slice(0, 120)})`), { cause: e });
  } finally {
    if (hangGuard) clearTimeout(hangGuard); // 성공·실패·자가치유 어느 경로로 빠져나가도 타이머를 남기지 않는다
  }
}
