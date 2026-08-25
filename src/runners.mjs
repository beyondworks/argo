// 러너 — 크루의 두뇌 엔진. Claude Code(SDK)가 1급 시민이고, Codex/Gemini는 로컬 CLI의
// OAuth 로그인(구독)을 그대로 빌리는 어댑터, GLM은 Anthropic 호환 엔드포인트로 SDK를 태운다.
// 원칙: Argo가 새 API 키를 보관하지 않는다 — 이미 인증된 도구의 자격을 쓴다(BYOK/BYOA).

// ── 관심사 분리(2026-07-28): 구현은 src/runners/*.mjs 로 이동, 이 파일은 기존 62개 export를
//    그대로 내보내는 facade다(임포터 무수정). 아래 함수들만 이 파일에 남는다 — 배선 트립와이어
//    테스트(billing-gate·antigravity-runner·openrouter-runner)가 src/runners.mjs "소스 텍스트"로
//    위치를 잠그기 때문: externalExec(+agyCmd)·billedByType/isBilledRunner/billedRunnerMap·
//    runnerStatus·resolveRunner. export 표면 유실은 test/runners-facade.test.mjs가 차단한다.

import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monthCostByRunner } from './usage.mjs'; // usage는 workspace만 의존 — 순환 없음
import { exec, exists, scrubServerSecrets } from './runners/shared.mjs';
import { RUNNERS, RUNNER_AUTH, hostOptInAllowed, isCliRunner, pickRunner, oauthFormatError } from './runners/catalog.mjs';
import { codexHome, codexCmd, importCodexAuth, recoverCodexAuth, writeCodexTurnConfig, codexEffortArgs, CODEX_LOCKUP_RE, reprovisionCodexCli } from './runners/codex.mjs';
import { geminiCmd, writeGeminiTurnSettings } from './runners/gemini.mjs';
import { openRoots } from './workroots.mjs'; // 파일 반경 단일 진실(codex·gemini·antigravity 공유)

import { loadSecrets, credType, maskCred } from './runners/creds.mjs';
import { ensureCliPath, apiError, detectRunners } from './runners/exec.mjs';
/** antigravity 파일 반경 인자(순수) — openRoots를 반복형 --add-dir로. (export: 회귀 테스트용 —
    검수 HIGH-1: 반경 인자 세 줄을 지워도 전 게이트가 초록이었다. 인라인 조립은 단위로 못 잠근다.) */
export const agyDirArgs = (caps, workRoots = []) => openRoots(caps, workRoots).flatMap((r) => ['--add-dir', r]);


// ── 분리 모듈 re-export — 기존 임포터·테스트가 쓰는 이름 전부(62개 표면의 나머지 57개) ──
export { isServerSecretKey, scrubServerSecrets, maskKeyLike, homeEnv, isProcessCrash, crashHint } from './runners/shared.mjs';
export {
  RUNNERS, RUNNER_AUTH, hostOptInAllowed, isCliRunner,
  GLM_DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL, OPENROUTER_ONBOARD_MODEL, KIMI_DEFAULT_MODEL, GROK_DEFAULT_MODEL,
  isOpenRouterCreditError, isOpenRouterCreditReply, isOpenRouterLimitError, isOpenRouterLimitReply,
  pickRunner, autoRunnerOf, oauthFormatError, excludeWith, authExcludedNoRunnerMsg,
} from './runners/catalog.mjs';
export {
  provisionCodexCli, CODEX_EFFORTS, codexEffortArgs, CODEX_PIN, CODEX_LOCKUP_RE,
  importCodexAuth, recoverCodexAuth, writeCodexTurnConfig,
} from './runners/codex.mjs';

/* ── 도구 잠김(L2 자가치유) — 실행기 자체 고장(모델·자격 무관)의 공통 처리. 2026-08-25 사고로 신설:
   codex code-mode host가 잠기면 턴이 "성공"하되 셸·파일 도구만 전멸한다(제보의 형태). chat.mjs가
   toolLockup 마커를 보고 ① 재조달+1회 재시도 → ② 그래도면 러너 교체(인증 실패와 같은 계열 취급)한다. */
/** 잠김 판정 → 행동(순수). retried=재조달 재시도를 이미 했는가. (export: 회귀 테스트용) */
export function lockupAction(err, { retried = false } = {}) {
  if (!err?.toolLockup) return null;
  return retried ? 'switch' : 'reprovision-retry';
}
/** 러너별 재조달 — codex만 대상(gemini는 PR2에서 합류 예정). 반환: 실제 재조달 여부. */
export async function reprovisionRunner(runner) {
  if (runner === 'codex') return reprovisionCodexCli();
  return false;
}
const codexLockupError = () => Object.assign(new Error(
  'codex 실행기의 도구(셸·파일)가 잠겨 턴이 일을 하지 못했습니다(code-mode host 문제). '
  + 'Codex tools were locked (code-mode host issue) — the turn could not modify files.',
), { toolLockup: true });
export { provisionGeminiCli, probeGeminiOAuth, probeGeminiHostOAuth } from './runners/gemini.mjs';
export {
  accountScope, loadRunnerCred, saveRunnerCred, clearRunnerCred, seedRunnerCreds,
  maskCred, normalizePastedCred, runnerCredEnv, sdkEnvFor, kimiEnv, glmEnv, verifyRunnerCred,
  loadClaudeKey, maskClaudeKey, claudeEnvFor,
} from './runners/creds.mjs';
export { startRunnerWebAuth, submitRunnerWebAuth, webAuthDone, startRunnerDeviceAuth, pollRunnerDeviceAuth, deviceAuthSupported } from './runners/webauth.mjs';
export { isGrokCreditError, grokCreditNotice } from './runners/grok.mjs';
export {
  apiError, detectRunners, startRunnerLogin, runnerLoginStatus,
  extractSetupAuthUrl, extractSetupToken, extractSetupTokenCandidates, bundledClaudeCli,
  setupTokenStatus, submitSetupCode, startClaudeSetupToken,
} from './runners/exec.mjs';

/** CLI 턴 실패의 정직 번역 — 시간 초과가 "러너 실행 실패 (exit ?)" 잡음(우리 kill)이나 last.txt
    ENOENT(kill 후 출력 파일만 없는 변종)로 위장되던 것을 종결한다(QA P1-2, 실사용 4회 재현:
    "리릭비디오가 항상 약 300초 후 ENOENT" = 기본 timeoutMs와 정확히 일치. 위장 재현 실측 2026-07-28:
    timeoutMs=3000에서 3.8초 사망 + 배너 잡음 메시지, 시간 초과 언급 0). 판정은 경과 시간 기준 —
    우리 kill 타이머(timeoutMs)가 발화할 만큼 지났으면 표면 오류가 무엇으로 위장했든 원인은 시간 초과다.
    (export: 회귀 테스트용 — 순수 함수) */
export function cliTurnFailure(e, runner, elapsedMs, timeoutMs, { stage = 'exec', kind = 'chat' } = {}) {
  // 시간 초과 판정은 이중 조건 — 경과>=상한 **그리고** (우리 kill 흔적(killed) 또는 read 단계).
  // 경과만 보면 상한 직후 도착한 진짜 벤더 오류(예: 401)까지 '시간 초과'로 치환돼 AUTH_ERR_RE
  // 자가치유가 죽는다(분리 검수 M3 실측: 401@301s가 문구째 소실). killed는 exec 타이머 kill의
  // 확정 신호고, read 단계 ENOENT는 kill 뒤 출력 부재의 위장 본체다.
  if (elapsedMs >= timeoutMs && (e?.killed === true || stage === 'read')) {
    const cap = timeoutMs >= 3_600_000 ? `${Math.round((timeoutMs / 3_600_000) * 10) / 10}시간` : `${Math.round((timeoutMs / 60_000) * 10) / 10}분`;
    const capEn = timeoutMs >= 3_600_000 ? `${Math.round((timeoutMs / 3_600_000) * 10) / 10}h` : `${Math.round((timeoutMs / 60_000) * 10) / 10}min`;
    // 안내는 수신자 인지형(분리 검수 H1·M4) — 이 함수는 CLI 러너 턴에서만 발화하고, CLI 크루에는
    // start_long_task 도구가 없다(chat.mjs commonDirectives hasTools:false와 동일 사실). 잡 턴에
    // "장시간 작업으로 걸어라"는 자기모순이므로 쪼개기 안내로 갈라진다.
    const guide = kind === 'job'
      ? '작업을 더 작은 단위로 쪼개서 다시 걸어 주세요. '
      : '이 러너의 대화 턴에는 장시간 작업 도구가 없으니, 작업을 쪼개거나 SDK 러너(Claude·GLM·Kimi·OpenRouter·Grok) 크루에게 "장시간 작업으로 걸어줘"라고 맡기면 턴 밖에서 끝까지 돌아 결과가 배달됩니다. ';
    const guideEn = kind === 'job'
      ? 'Split the work into smaller pieces and queue it again.'
      : 'This runner\'s chat turns have no long-task tool — split the work, or ask a crew on an SDK runner (Claude, GLM, Kimi, OpenRouter, Grok) to run it as a long task.';
    return Object.assign(new Error(
      `시간 초과: 이 ${kind === 'job' ? '장시간 작업' : '턴'}이 상한 ${cap}을 넘겨 중단됐습니다. ${guide}`
      + `Timed out after the ${capEn} cap — ${guideEn}`,
    ), { timedOut: true });
  }
  if (e?.code === 'ENOENT' && stage === 'read') {
    // read 단계 한정 — exec 단계 ENOENT는 "CLI 미설치/PATH"라는 정확한 기존 진단(apiError)이 있다.
    // 여기서 가로채면 환경 오류 최다 케이스의 진단이 사라진다(분리 검수 M2 회귀 지적).
    return new Error('러너가 응답을 남기지 않고 종료했습니다(중단 또는 러너 내부 오류). The runner exited without writing a response.');
  }
  return apiError(e, runner);
}

/** 외부 CLI 러너 1턴 — 워크스페이스를 cwd로, 프롬프트 하나로 실행하고 마지막 응답을 받는다.
    cred = runnerCredEnv 결과({ env, home }) — 회사 자격이 있으면 그 env를 주입(API키/OAuth). 없으면 호스트 로그인.
    caps = 회사 로컬 능력({ fs, browser, shell }) — gemini 도구 게이팅·agy 반경 인자에 반영
    (codex는 2026-08-21부터 샌드박스 없음 — danger-full-access, 유건 지시 "샌드박스 없이"). */
export async function externalExec({ runner, model, cwd, prompt, timeoutMs = 300_000, cred = null, signal = null, caps = null, effort = '', workRoots = [], kind = 'chat', mcpServers = null }) {
  await ensureCliPath(); // GUI 기동 PATH 보강 — 아래 env 스냅샷(scrubServerSecrets)보다 먼저
  const t0 = Date.now(); // 실패의 정직 번역용 — cliTurnFailure가 경과 시간으로 시간 초과를 판정한다
  if (runner === 'codex') {
    const dir = await mkdtemp(join(tmpdir(), 'argo-codex-'));
    const out = join(dir, 'last.txt');
    // 회사 자격(apikey·oauth 모두 격리 홈의 auth.json — 'clean'+env키 모드는 codex CLI가 env 키를
    // 안 읽어 폐기 2026-07-26)이 있으면 그 홈, 없으면 호스트 로그인 상속
    const baseHome = cred?.home ? cred.home : await codexHome();
    // per-turn CODEX_HOME — baseHome은 회사 간 공유(codexHome)라 config.toml에 caps를 직접 쓰면 경합한다.
    // 이번 턴 전용 홈을 만들고 auth.json만 베이스에서 심링크한 뒤 config.toml에 caps를 써넣는다(격리 + 버전 안정).
    const CODEX_HOME = join(dir, 'home');
    await mkdir(CODEX_HOME, { recursive: true, mode: 0o700 });
    // 자격 반입(심링크 → 복사 폴백) + 턴 뒤 갱신 토큰 회수. 계약은 importCodexAuth/recoverCodexAuth의
    // 주석과 test/codex-auth-import.test.mjs가 잠근다(신규 설치 401의 근본 원인이었던 자리).
    const auth = await importCodexAuth(baseHome, CODEX_HOME);
    await writeCodexTurnConfig(CODEX_HOME, mcpServers); // MCP 주입만 — 샌드박스 섹션은 danger-full-access 전환으로 소멸
    const cmd = await codexCmd(); // 관리본(핀) 우선 > 즉석 조달 > PATH 폴백(2026-08-25 반전) — 사용자 설치 없이도 돈다
    try {
      const run = await exec(cmd.file, [
        ...cmd.args,
        // danger-full-access — 유건 지시 2026-08-21 "샌드박스 없이". workspace-write + 홈 한정
        // writable_roots가 "사용 권한이 없다" 차단의 뿌리였다(윈도우 쓰기 전멸 클러스터 포함).
        // 프로세스 수준 방어가 사라짐을 알고 유지 — 남는 방어는 프롬프트 금지 지시(2차)뿐이고,
        // 크루 자기 카드 수정으로 우회 가능하던 반쪽 격리였다(분리 검수 MED-3 판정: 경계 아님).
        'exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check',
        ...codexEffortArgs(effort), // 크루별 추론 강도 — codex도 지원(실측 2026-07-26)
        '--output-last-message', out,
        ...(model ? ['-m', model] : []),
        '--', prompt, // 프롬프트가 '---'(카드 frontmatter)로 시작해도 플래그로 오해하지 않도록
      ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, ...(signal ? { signal } : {}), env: { ...scrubServerSecrets(process.env, 'codex'), ...(cred?.env ?? {}), CODEX_HOME } })
        .catch((e) => {
          const t = cliTurnFailure(e, 'codex', Date.now() - t0, timeoutMs, { stage: 'exec', kind });
          if (CODEX_LOCKUP_RE.test(String(e?.stderr ?? ''))) t.toolLockup = true; // 실패 턴에도 잠김 신호가 실리면 L2로
          throw t;
        });
      // 도구 잠김은 "성공" 턴으로 위장한다 — 턴은 완주하고 모델이 "도구가 차단됐다"는 답만 남긴다
      // (2026-08-25 제보의 형태). stderr의 벤더 경고를 보고 잠김 턴을 실패로 승격해 자가치유(chat.mjs)에 넘긴다.
      if (CODEX_LOCKUP_RE.test(String(run?.stderr ?? ''))) throw codexLockupError();
      // readFile까지 번역 — kill 후 last.txt가 없어 생 ENOENT가 사용자에게 노출되던 위장 경로(QA P1-2)
      return (await readFile(out, 'utf8').catch((e) => { throw cliTurnFailure(e, 'codex', Date.now() - t0, timeoutMs, { stage: 'read', kind }); })).trim();
    } finally {
      await recoverCodexAuth(auth).catch(() => {}); // 복사 모드의 갱신 토큰 회수 — 임시 홈 삭제 전에
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (runner === 'gemini') {
    // 회사/host 자격이면 격리 HOME — 이번 턴 settings.json(인증 방식 + caps 도구 게이팅)을 매 턴 쓴다.
    // (자격 없는 경로는 명시 연결 원칙상 도달 안 하지만, 도달 시 호스트 HOME으로 폴백 — 도구 게이팅 없음)
    if (cred?.home && cred?.authType) await writeGeminiTurnSettings(cred.home, cred.authType, caps, workRoots, mcpServers);
    const cmd = await geminiCmd(); // PATH 설치본 > 관리본 > 즉석 조달 — 사용자 설치 없이도 돈다
    // 파일 반경 — gemini-cli는 workspaceContext(cwd + include-directories) **밖의 읽기·쓰기를 벤더
    // 도구가 거부**한다. 반경을 안 넘기면 크루 책상이 회사 폴더 하나로 쪼그라들어, 같은 지시가 codex
    // 크루는 되고 gemini 크루는 "허용된 작업 디렉토리 외부"로 거절된다(라이브 재현 2026-07-30).
    // 전달 채널은 settings.json(writeGeminiTurnSettings의 context.includeDirectories) **하나만** 쓴다
    // — `--include-directories` 플래그는 안 쓴다: ① 벤더가 콤마로 분해해 콤마 폴더가 깨진다(분리
    // 검수 LOW-1) ② 0.21.2에선 두 채널 다 비대화(-p)에서 미적용이라 플래그가 이득도 없다(검수 실증).
    const { stdout } = await exec(cmd.file, [
      ...cmd.args,
      '-p', prompt,
      ...(model ? ['-m', model] : []),
      // yolo — 유건 지시 2026-08-21 "샌드박스 없이, 다른 러너도 동일하게". auto_edit(편집만 자동
      // 승인)에선 셸이 비대화에서 실행 불가라 codex 크루는 되는 지시가 gemini 크루만 막혔다(러너
      // 중립성 위반). 벤더 choices 실측: default|auto_edit|yolo — yolo가 전권과 같은 방향이다.
      '--approval-mode', 'yolo',
    ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, ...(signal ? { signal } : {}), env: { ...scrubServerSecrets(process.env, 'gemini'), ...(cred?.env ?? {}) } })
      .catch((e) => { throw cliTurnFailure(e, 'gemini', Date.now() - t0, timeoutMs, { stage: 'exec', kind }); });
    return stdout
      .replace(/^(Loaded cached credentials\.|Data collection is .*|\[STARTUP\].*|\[dotenv.*)\s*$/gim, '')
      .trim();
  }
  if (runner === 'antigravity') {
    // BYOA — agy CLI 래핑(권한 근사 적용, codex/gemini와 같은 정직 표기 계열).
    // 자격은 OS 키링이라 env·격리 홈 반입이 없다(host 옵트인 전용, cred는 항상 null 경유).
    // --mode accept-edits — agy가 제공하는 최대 자율 모드다(--help 실측 2026-08-21: choices가
    //   accept-edits, plan 뿐 — codex danger-full-access·gemini yolo 같은 전권 모드가 벤더에 없다).
    //   "샌드박스 없이" 지시(2026-08-21)는 이 러너에선 --sandbox 미전달(전권 기본값에서 이미 그렇다)
    //   까지가 우리가 할 수 있는 전부 — 벤더 한계는 정직 표기 원칙대로 여기 남긴다.
    // --sandbox = 셸 능력 OFF의 근사(agy "terminal restrictions") — SDK 게이트와 달리 사전 카드가
    //   없으므로 근사임을 시스템 프롬프트 안내(commonDirectives)가 보완한다.
    // --print-timeout은 우리 kill(timeoutMs)보다 **30초 짧게** — agy의 이 타이머는 기동(글로그 초기화
    // ~6초+) **이후** 시작돼 총 수명이 타이머+기동이다. 마진이 그보다 작으면 agy가 자기 에러 문구
    // ("timeout waiting for response")를 찍기 전에 우리 kill이 이겨 스트림이 빈 채(killed:true)
    // 제네릭 "exit 1"로 떨어진다 — 5초 마진으로 불충분함을 실스모크로 확정(2026-07-27, ARGO_DEBUG_AGY
    // 관찰: killed:true·stdout/stderr 공백). 기본 5m 방치도 금지 — 우리 상한과 어긋나 이중 대기.
    const cmd = await agyCmd();
    // 마진 30초를 못 지키는 짧은 timeoutMs(<55s)면 --print-timeout을 생략한다 — 그 경우 우리 kill이
    // 지배해 매핑 없는 제네릭 에러가 되지만, 플로어로 마진을 줄여 경합(문구 유실)을 되살리는 것보다
    // 낫다(분리 검수 M3·N5). 현 호출자 최소값은 120s(oneshot)라 실발현 없음. 이 생략 분기에서만은
    // agy 기본 5m가 남는데 kill(timeoutMs)이 항상 먼저라 이중 대기도 없다.
    const agySec = Math.ceil(timeoutMs / 1000) - 30;
    const { stdout } = await exec(cmd.file, [
      '-p', prompt,
      ...(model ? ['--model', model] : []),
      // gemini와 같은 이유·같은 계산(agyDirArgs=openRoots). agy의 워크스페이스 강제 여부는 **추정**
      // — --add-dir 플래그 존재만 실측(--help), 밖 접근이 실제로 막히는지는 미확인(검수 MEDIUM-3:
      // 본문과 같은 강도로 표기). 막는 버전이면 이 인자가 열고, 안 막는 버전이면 무해.
      ...agyDirArgs(caps, workRoots),
      '--mode', 'accept-edits',
      ...(caps?.shell ? [] : ['--sandbox']), // fail-closed(분리 검수 H2) — caps 미전달(oneshot 등)이면 제한 켬. codex 상시 샌드박스와 같은 방향
      ...(agySec >= 25 ? ['--print-timeout', `${agySec}s`] : []),
    ], { cwd, timeout: timeoutMs, maxBuffer: 32e6, ...(signal ? { signal } : {}), env: { ...scrubServerSecrets(process.env, 'antigravity'), ...(cred?.env ?? {}) } })
      .catch((e) => { if (process.env.ARGO_DEBUG_AGY) console.error('[debug agy]', JSON.stringify({ code: e.code, killed: e.killed, signal: e.signal, so: String(e.stdout ?? '').slice(-60), se: String(e.stderr ?? '').slice(-120) })); throw cliTurnFailure(e, 'antigravity', Date.now() - t0, timeoutMs, { stage: 'exec', kind }); });
    return stdout.replace(/^[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+.*$/gm, '').trim(); // glog 제거 — 시각 필드까지 요구(분리 검수 M2: 'E1234 …'로 시작하는 정상 응답 오삭제 방지)
  }
  throw new Error(`알 수 없는 외부 러너: ${runner}`);
}

/** agy(Antigravity CLI) 실행 파일 — PATH 설치본 우선, 공식 인스톨러 고정 경로(~/.local/bin/agy) 폴백.
    codex/gemini와 달리 자동 조달은 하지 않는다(인스톨러가 바이너리 다운로드 + 셸 프로파일 수정 —
    사용자 홈을 건드리는 부작용이 있어 명시 설치 안내가 정직하다). */
async function agyCmd() {
  const onPath = await exec('agy', ['--version']).then(() => true, () => false);
  if (onPath) return { file: 'agy', args: [] };
  const local = join(homedir(), '.local', 'bin', 'agy');
  if (await exists(local)) return { file: local, args: [] };
  // Windows 공식 설치 경로(%LOCALAPPDATA%\agy\bin) — PATH 미등록 GUI 기동 대비. 실기기 미검증(설계 문서).
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winBin = join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (await exists(winBin)) return { file: winBin, args: [] };
  }
  throw new Error('Antigravity CLI(agy)가 설치되어 있지 않습니다. https://antigravity.google/docs/cli/install 에서 설치 후 터미널에서 agy를 실행해 Google 로그인해 주세요. '
    + 'Antigravity CLI (agy) is not installed — install it and sign in with Google, then retry.');
}

/** 이 턴이 **실제로 돈이 청구되는가** — 사용액 표시의 판정 기준(순수 규칙).
    apikey만 청구다. oauth(구독 로그인)·host(이 컴퓨터 CLI 로그인)·자격 없음(호스트 폴백)은 사용자의
    구독 안에서 돌아가므로 청구되지 않는다. SDK는 두 경우 모두 total_cost_usd에 정가 상당액을 리포트하는데,
    그걸 그대로 "이번 달 사용액"으로 보여주면 구독 사용자가 청구서로 오해한다(실사용 신고 2026-07-26:
    "구독료 안에서 쓰는 건지 추가로 청구되는 건지 헷갈린다"). (export: 회귀 테스트용) */
/** 러너 1개의 청구 판정(순수) — type = 회사 자격 타입(없으면 undefined).
    자격이 없을 때의 env 폴백 판정은 **레거시 무표지 행의 소급 판정에만** 실질 영향이 있다
    (신규 턴은 resolveRunner가 저장 자격만 가용으로 보므로 각인 시점엔 항상 자격이 있다 —
    2R 검수 MEDIUM-3). env는 기기 간 동기화되지 않으므로 기기별로 레거시 행 판정이 갈릴 수
    있다 — 알려진 한계로 수용(각인 도입으로 시간이 갈수록 적용 0 수렴). */
const billedByType = (type, runner) => {
  if (type) return type === 'apikey';
  if (runner === 'glm') return !!process.env.GLM_API_KEY;   // sdkEnvFor의 호스트 env 폴백 = 실제 과금(1R HIGH-1)
  if (runner === 'kimi') return !!process.env.KIMI_API_KEY;
  // claude: 두 인증 env 공존 시의 실행 우선순위는 SDK 내부라 추측하지 않는다 — sdkEnvFor가
  // 구독 토큰 존재 시 API 키를 소거해 **실행 자체를 구독으로 확정**한다(2R HIGH-2 결정론화).
  if (runner === 'claude') return !!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return false; // codex·gemini·antigravity 호스트 로그인 = 구독, openrouter 등은 회사 자격 필수
};

export async function isBilledRunner(wsId, runner) {
  return (await billedRunnerMap(wsId))[runner] ?? false;
}

/** { 러너id: 청구 여부 } — 금액 표면 단일 판정(rowBilled)의 두 번째 인자. billing.mjs와
    runnerStatus가 공유한다(중복 구현 금지 — 검수 LOW-9). 자격 파일은 **1회만** 읽는다
    (2R LOW-6: 러너별 병렬 5중 읽기는 손상 시 rename 경합을 만들었다). 손상은 여기서
    결정적으로 1회 throw — 표시 표면의 강등은 billing.mjs(mapOrSuppress)가 담당한다. */
export async function billedRunnerMap(wsId) {
  const s = await loadSecrets(wsId);
  const map = {};
  for (const id of Object.keys(RUNNERS)) map[id] = billedByType(s.runners?.[id]?.type, id);
  return map;
}

/** 러너별 회사+호스트 연결 상태 — 설정 UI·크루 카드가 먹는다. */
export async function runnerStatus(wsId) {
  const host = await detectRunners();
  const secrets = await loadSecrets(wsId);
  // 금액은 단일 판정(rowBilled + billedRunnerMap) — billing.mjs와 같은 함수를 쓴다(중복 금지).
  const usage = await monthCostByRunner(wsId, await billedRunnerMap(wsId)).catch(() => ({})); // 표시용 — 실패해도 상태를 막지 않는다
  const out = {};
  for (const [id, meta] of Object.entries(RUNNER_AUTH)) {
    const cred = secrets.runners?.[id];
    out[id] = {
      name: RUNNERS[id]?.name ?? id, // 표시 이름의 단일 진실 — 클라 하드코딩('Claude Agent SDK' 명판 실사고 2026-07-20) 방지
      month: usage[id] ?? null, // 이번 달 사용량(턴·비용) — 러너 카드에 "보이는 상태"
      methods: meta.methods,
      oauthPasteable: !!meta.oauthPasteable,
      connectable: !!meta.connect, // Connect 버튼(CLI 브라우저 로그인 대행) 지원 여부 — codex
      webConnect: !!meta.webConnect, // 웹 브리지(로그인 URL 표시 + 코드 입력) — claude
      hostUsable: hostOptInAllowed(id), // "이 컴퓨터 로그인 사용" 옵트인 — claude는 non-standalone에서만(키체인)
      cli: isCliRunner(id), // 외부 CLI 래핑 — 크루 도구(쪽지·루틴·위임)가 없어(chat.mjs hasTools:false) 카드가 정직 표기한다
      // claude 원클릭(setup-token)은 데스크톱 번들 사이드카에서만 완주 — 상주/웹은 붙여넣기가 정식 경로
      setupOneClick: id === 'claude' && process.env.ARGO_STANDALONE === '1',
      keyUrl: meta.keyUrl,
      hostInstalled: host[id]?.installed ?? false,
      hostAuthed: host[id]?.authed ?? false, // 호스트 CLI 로그인/env (OAuth 폴백 경로)
      hostAuthUnknown: host[id]?.authUnknown ?? false, // 키링 자격(antigravity) — 로그인 판정 불가, UI는 단정 금지
      company: cred?.value ? {
        connected: true,
        type: credType(cred.type),
        masked: cred.type === 'host' ? '' : maskCred(cred.value),
        // 저장 검증 도입 전(철회된 웹 브리지 등)에 들어온 무효 형식 토큰 — 카드가 "재연결 필요"를 보여준다
        ...(cred.type === 'oauth' && oauthFormatError(id, cred.value, 'ko') ? { invalid: true } : {}),
        // host 마커는 이 컴퓨터 CLI 로그인이 살아 있어야 유효 — 로그아웃·미설치면 "재연결 필요".
        // + 이 환경에서 host 옵트인이 허용되지 않으면(예: non-standalone에서 저장된 claude host 마커가
        //   동기화로 데스크톱 standalone에 넘어온 경우 — 재서명 node가 키체인에 막혀 "Not logged in")
        //   invalid로 표시해 pickRunner가 스킵하고 setup-token 재연결을 유도한다(검수 HIGH — 소비 측 대칭 게이트).
        ...(cred.type === 'host' && (!(host[id]?.installed && host[id]?.authed) || !hostOptInAllowed(id)) ? { invalid: true } : {}),
      } : { connected: false },
    };
  }
  return out;
}

/** 턴에 실제로 쓸 러너 결정 — 크루의 러너가 미가용이면 가용한 러너로 폴백(pickRunner).
    어떤 러너든 하나만 연결돼 있으면 모든 크루가 응답하게 하는 관문. */
export async function resolveRunner(wsId, want, { exclude = null } = {}) {
  // ponytail: 회사 기본 러너(K1, 유건 지시 2026-08-08). company.json 읽기 실패는 무해(기존 순서 폴백).
  let defaultRunner = null;
  try {
    const { loadCompany } = await import('./workspace.mjs');
    defaultRunner = (await loadCompany(wsId))?.defaultRunner ?? null;
  } catch { /* 미설정 = null — 기존 RUNNER_AUTH 순서 */ }
  return pickRunner(await runnerStatus(wsId), want, exclude, { defaultRunner });
}
