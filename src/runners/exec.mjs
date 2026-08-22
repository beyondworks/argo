// 러너 실행 환경 — GUI 기동 PATH 보강·오류 번역(apiError)·설치/인증 감지·CLI 로그인 대행·
// claude setup-token 원클릭. (runners.mjs 관심사 분리 2026-07-28 — externalExec 본체는
// 배선 트립와이어 테스트가 소스 위치를 잠가 runners.mjs(facade)에 남았다)

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs'; // setup-token 코드 왕복 fifo(동기 fd — 이벤트 핸들러에서 사용)
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, execP, exists, maskKeyLike, mergePath } from './shared.mjs';
import { RUNNER_AUTH } from './catalog.mjs';
import { codexManagedBin } from './codex.mjs';
import { geminiManagedEntry } from './gemini.mjs';
import { saveRunnerCred, verifyRunnerCred } from './creds.mjs';

// GUI 기동 PATH 보강(정적 병합)은 shared.mjs로 하강 — codex/gemini 모듈 직접 임포트 경로에서도
// 병합이 보장되게(분리 검수 LOW-1). macOS 로그인 셸 캡처(ensureCliPath)만 여기 남는다.
let cliPathP = null; // 프로세스당 1회 — 실패해도 정적 병합만으로 진행(설치 후엔 앱 재시작 안내가 관례)
function ensureCliPath() {
  if (process.platform !== 'darwin') return Promise.resolve();
  // 플래그는 분리해 전달 — fish 등 결합 단축(-ilc)을 거부하는 셸에서도 동작(zsh/bash/fish/sh 공통)
  return (cliPathP ??= execP(process.env.SHELL?.trim() || '/bin/zsh', ['-i', '-l', '-c', 'echo "::ARGO_PATH::$PATH::ARGO_PATH::"'], { timeout: 5000 })
    .then(({ stdout }) => {
      // rc 파일이 stdout에 내는 잡음과 분리하기 위해 마커 사이만 취한다
      const m = String(stdout).match(/::ARGO_PATH::(.*?)::ARGO_PATH::/s);
      if (m) mergePath(m[1].split(':').map((s) => s.trim()).filter(Boolean));
    }, () => { /* 셸 실패·타임아웃 — 정적 병합으로 충분한 환경이 대부분 */ }));
}

/** 실패 출력에서 API 에러 메시지만 뽑는다 — 이벤트 로그에 명령·프롬프트 전문을 흘리지 않는다.
    키 패턴은 마스킹(벤더 401 바디의 "Incorrect API key provided: sk-…" 류가 그대로 영속되지 않게). */
export function apiError(e, runner = null) {
  // codex가 호스트 전역 스킬 디렉토리(~/.claude/skills, ~/.agents/skills)를 CODEX_HOME과 무관하게 읽어
  // 매 실행 ERROR 로그를 뱉는다(실측 2026-07-22) — 실패 시 이 노이즈가 stderr 꼬리를 덮어 빨간 메시지가
  // "failed to load skill …"로 오도된다. 진단에서 제거해 진짜 원인만 남긴다.
  const scrub = (s) => String(s ?? '').replace(/^.*ERROR codex_core.*failed to load skill.*$/gim, '').trim();
  const raw = `${scrub(e.stdout)}\n${scrub(e.stderr)}`;
  // A0 원인 분류(2026-07-23): 스폰 실패(바이너리 미발견) = PATH 누락/미설치가 원인 — 사용자가 겪는
  // "환경에 따른 러너 연결 오류"의 최다 케이스인데 이전엔 제네릭 "exit ?"로 뭉개졌다. 원인+처방을 준다.
  // 신호는 e.code==='ENOENT'(execFile 스폰 미발견의 확정 신호) + 셸 "command not found"/리터럴 ENOENT로 한정한다 —
  // bare "not found"는 게이트 모델 에러("requested entity was not found")와 충돌하므로 절대 쓰지 않는다(오분류 시 강등 로직 파괴).
  // 인증 실패는 여기서 손대지 않는다: 아래 제네릭으로 흘려보내 AUTH_ERR_RE 자가치유 재시도(chat.mjs)가 그대로 동작하게 한다.
  // 텍스트 매칭은 stderr로 한정한다(검수 2026-07-23): raw에는 stdout이 섞여 있어, 크루가 셸 도구로 실행한
  // 명령의 "command not found" 출력이 stdout에 실리면 무관한 실패(인증 만료·rate limit)를 CLI 미발견으로
  // 오분류하고 원래 벤더 메시지를 지워 자가치유(AUTH_ERR_RE)까지 막는다. e.code가 확정 신호.
  // stderr 텍스트 휴리스틱은 **진행 기록이 없는 짧은 stderr**에서만(2026-08-22 제보 "업데이트 후 CLI를 찾을 수
  // 없다" 지속 — 실측: codex exec는 크루 셸 명령의 출력까지 stderr에 쓴다. 0.1.43에서 샌드박스를 없애 셸이
  // 전면 허용되자 'command not found'가 stderr에 흔히 섞였고, 턴이 한도·인증 등 다른 이유로 실패하면 그
  // 원인이 'CLI 미발견'으로 덮였다). e.code가 확정 신호이고, 셸 래퍼가 한 줄로 죽는 경우만 텍스트로 보강한다.
  const stderrTail = String(e.stderr ?? '');
  if (e.code === 'ENOENT' || (stderrTail.length < 300 && /command not found|\bENOENT\b/i.test(stderrTail))) {
    return new Error('러너 CLI를 찾지 못했습니다 (설치 또는 PATH 문제). 설정 → AI 연결에서 다시 연결하거나 앱을 재시작해 주세요. '
      + 'Runner CLI not found (install or PATH issue) — reconnect in Settings → AI, or restart the app.');
  }
  // 구글이 개인 무료 OAuth(Code Assist for individuals)를 신형 CLI에서 차단(실측 2026-07-20:
  // 번들판 0.36~0.51 전부 IneligibleTierError, 구형 0.21만 통과 — 서버측 판정이라 버전 고정 우회는 시한부).
  // 영어 스택트레이스 대신 대안이 담긴 안내로 번역한다.
  if (/IneligibleTierError|no longer supported for Gemini Code Assist/i.test(raw)) {
    return new Error('구글이 Gemini 개인 OAuth(무료 Code Assist) 지원을 최신 CLI에서 중단했습니다. '
      + '구글 구독(로그인)으로 쓰려면 설정 → AI 연결에서 **Antigravity 러너**를 연결하고(터미널에서 agy 로그인), '
      + 'API 키로 쓰려면 Gemini를 API 키로 다시 연결해 주세요(Google AI Studio에서 무료 발급). '
      + 'Google moved personal OAuth to Antigravity — connect the Antigravity runner (agy login), or reconnect Gemini with an API key.');
  }
  // agy(Antigravity CLI)의 무응답 타임아웃 — 미로그인이 가장 흔한 원인(비대화 -p 모드는 로그인 플로우를
  // 못 열고 응답 대기만 하다 이 문구로 죽는다 — agy 1.1.7 실측 2026-07-27). 장시간 작업 초과와 문구가
  // 같아 구분 불가하므로 두 원인을 모두 안내한다.
  // **runner 게이트(분리 검수 M1)**: 실측(재검 N1)상 agy는 이 문구를 stderr로 낸다. 그래도 크루가
  // 셸로 실행한 명령의 출력(stdout)에 같은 문구가 섞이는 경로가 있어(위 stdout 오염 원칙과 동일
  // 클래스) raw 전체를 보되 **antigravity 실행 경로에서만** 발화한다 — 상위집합 방어.
  // 문구의 "not logged in"은 AUTH_ERR_RE(chat.mjs)와의 계약 — 자가치유(남은 가용 러너 순차 폴백)를 살린다.
  if (runner === 'antigravity' && /timeout waiting for response/i.test(raw)) {
    return new Error('Antigravity가 제한 시간 안에 응답하지 않았습니다. 이 컴퓨터에서 agy 로그인이 안 되어 있으면 '
      + '터미널에서 agy를 실행해 Google 로그인 후 다시 시도해 주세요. 로그인이 되어 있다면 작업이 제한 시간을 초과한 것입니다. '
      + 'Antigravity timed out — likely agy is not logged in on this machine (run agy in a terminal and sign in with Google), '
      + 'or the task exceeded the time limit.');
  }
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  return new Error(maskKeyLike(m ? m[1] : `러너 실행 실패 (exit ${e.code ?? '?'}): ${String(e.stderr ?? e.message).replace(/\s+/g, ' ').slice(-160)}`));
}

/** 설치·인증 감지 — 각 CLI의 로그인 산출물(OAuth 크리덴셜 파일)을 본다.
    force=true는 캐시 우회 — host 옵트인 클릭처럼 "지금 이 순간"의 로그인 검증이 목적인 경로용
    (감사 2026-07-20: 방금 `codex login`을 마친 사용자가 페이지 로드 때 예열된 authed:false 캐시에
    최대 60초간 오거절되던 함정 — 신선도가 정확성보다 싼 캐시를 검증 경로에 쓰면 안 된다).

    **캐시 수명이 체감 성능을 지배한다**(실사용 신고 2026-08-01 "앱이 한 박자 느리다", 실측):
    이 함수는 CLI 4종을 **프로세스로 띄워** 버전을 묻는다 — 콜드 2.7초. 러너가 하나도 연결돼 있지
    않으면 매번 4개를 전부 헛탐색해 그 값이 최악으로 나온다. 그런데 화면은 이걸 **페이지마다**
    부르고(데크 2회·설정·회사목록은 회사 수만큼), `argo:refresh`가 뜰 때마다 또 부른다. 60초짜리
    캐시로는 페이지를 옮겨 다니는 내내 2.7초 블로킹이 반복된다.
    10분으로 늘린다. CLI 설치·로그인 상태는 분 단위로 바뀌지 않고, **바뀌는 그 순간에는 이미
    force 경로가 있다**(host 옵트인·연결 버튼). 즉 신선도가 필요한 자리는 캐시를 안 본다. */
const DETECT_CACHE_MS = 10 * 60_000;
let cache = null;
let cacheAt = 0;
export async function detectRunners(force = false) {
  if (!force && cache && Date.now() - cacheAt < DETECT_CACHE_MS) return cache;
  await ensureCliPath(); // GUI 기동 PATH 보강 — homebrew/npm 전역 CLI 오탐 방지
  const home = homedir();
  const [codexV, codexManaged, geminiV, geminiManaged, agyV, agyLocalBin, codexAuth, geminiAuth, claudeCredFile, claudeCfgLogin] = await Promise.all([
    exec('codex', ['--version']).then((r) => r.stdout.trim(), () => null),
    exists(codexManagedBin()),    // 관리본(자동 조달)도 설치로 취급 — PATH 없이도 돈다
    exec('gemini', ['--version']).then((r) => r.stdout.trim(), () => null),
    exists(geminiManagedEntry()),
    exec('agy', ['--version']).then((r) => r.stdout.trim(), () => null),
    exists(join(home, '.local', 'bin', 'agy')), // 공식 인스톨러 고정 경로 — GUI PATH 누락 대비

    exists(join(home, '.codex', 'auth.json')),
    exists(join(home, '.gemini', 'oauth_creds.json')),
    // 리눅스 — 파일 보관(macOS도 키체인 불가 환경은 이 파일 폴백이라 무시하면 역회귀).
    // ⚠ 스테일 잔재가 authed 오탐을 낼 수 있다(실사용 2026-07-19: 죽은 Claude 흔적이 유효한 Codex를
    // 밀어내고 "Not logged in"으로 턴 사망) — 그 케이스는 chat/runOneShot의 인증 오류 자가 치유
    // (남은 가용 러너를 차례로 재시도)가 회수한다. 감지 단계에서 유효성까지는 판정하지 않는다.
    exists(join(home, '.claude', '.credentials.json')),
    // macOS/Windows — OAuth 토큰은 키체인/OS 보관이라 .claude.json의 로그인 계정 기록(oauthAccount)으로
    // 판정한다. 파일 존재만으론 안 됨: 로그인 없이 CLI가 실행만 돼도(번들 SDK 포함) 생성된다 — 미로그인
    // 기기가 설정에서 "연결중 · 이 컴퓨터 로그인"으로 오표시되고 턴은 Not logged in으로 죽던 원인.
    readFile(join(home, '.claude.json'), 'utf8')
      .then((s) => !!JSON.parse(s)?.oauthAccount?.accountUuid, () => false),
  ]);
  const claudeCred = claudeCredFile || claudeCfgLogin;
  cache = {
    claude: { installed: true, authed: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || claudeCred) },
    codex: { installed: !!codexV || codexManaged, authed: (!!codexV || codexManaged) && codexAuth }, // gemini와 대칭 — 관리본도 로그인 파일을 상속해 돈다
    gemini: { installed: !!geminiV || geminiManaged, authed: (!!geminiV || geminiManaged) && (geminiAuth || !!process.env.GEMINI_API_KEY) },
    glm: { installed: true, authed: !!process.env.GLM_API_KEY },
    kimi: { installed: true, authed: !!process.env.KIMI_API_KEY }, // env 주입 = 운영자 명시 옵트인(glm 관례)
    openrouter: { installed: true, authed: false }, // 호스트 개념 없음 — 회사 자격(BYOK)만. env 폴백도 두지 않는다(설계 2026-07-27 YAGNI)
    grok: { installed: true, authed: false }, // 동일 — 회사 자격(BYOK 키 또는 BYOA 기기 코드)만. 호스트 CLI 스캐빈징 없음(명시 연결 원칙)
    // antigravity: 자격이 OS 키링이라 로그인 여부를 파일로 판정할 수 없다 — authed=installed(낙관).
    // 위 2026-07-19 주석과 같은 원칙("감지 단계에서 유효성까지는 판정하지 않는다"): 미로그인은 첫 턴의
    // apiError 매핑("timeout waiting for response" → 로그인 안내)이 잡는다. host 마커 invalid 판정
    // (runnerStatus)이 authed=false면 옵트인 직후부터 "재연결 필요"로 오표시되는 것을 막는 값이기도 하다.
    antigravity: { installed: !!agyV || agyLocalBin, authed: !!agyV || agyLocalBin, authUnknown: !!agyV || agyLocalBin }, // authUnknown(설치 시): UI는 '로그인됨' 단정 대신 '확인 불가'를 그린다(거짓 유효 표기 금지 — 분리 검수 H1c)
  };
  cacheAt = Date.now();
  return cache;
}

/** OAuth 연결 시작 — 벤더 CLI의 브라우저 로그인을 서버가 대신 실행한다(서버가 사용자 PC에 있는
    로컬/데스크톱 전용). detached spawn이라 서버 응답을 막지 않고, CLI가 시스템 브라우저를 연다.
    완료는 runnerLoginStatus 폴링으로 감지. runner는 RUNNER_AUTH 화이트리스트 + 고정 인자라 인젝션 없음. */
export async function startRunnerLogin(runner) {
  const c = RUNNER_AUTH[runner]?.connect;
  if (!c) return { ok: false, reason: 'unsupported' }; // claude(토큰 붙여넣기)·glm(API키)
  const host = await detectRunners();
  if (!host[runner]?.installed) return { ok: false, reason: 'not-installed' }; // gemini 등 미설치
  try {
    // windowsHide — 로그인 CLI의 콘솔 창이 작업표시줄에 뜨지 않게(브라우저는 CLI가 따로 연다)
    const child = spawn(c.bin, c.loginArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref(); // 서버와 독립 실행 — 브라우저 로그인이 끝날 때까지 서버를 막지 않는다
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', message: String(e.message || e) };
  }
}

/** OAuth 연결 상태 — 벤더 CLI status를 읽기전용으로 확인(폴링용). */
export async function runnerLoginStatus(runner) {
  const c = RUNNER_AUTH[runner]?.connect;
  if (!c) return { supported: false, authed: false };
  await ensureCliPath(); // GUI 기동 PATH 보강
  // codex login status는 "Logged in ..."을 stderr로 낸다 — stdout·stderr 둘 다 검사
  const r = await exec(c.bin, c.statusArgs).catch((e) => e); // 비영점 종료도 출력은 캡처됨
  return { supported: true, authed: !!r && c.ok.test(`${r.stdout || ''}\n${r.stderr || ''}`) };
}

/* ─── Claude 원클릭 연결 — 공식 `claude setup-token`을 서버가 PTY로 대행(로컬/데스크톱 전용) ───
   왜 이 방식인가: 웹 브리지(구세대 엔드포인트 재현)는 러너가 거절하는 토큰을 저장해 철회했다
   (WEB_OAUTH 주석). setup-token은 CLAUDE_CODE_OAUTH_TOKEN의 유일한 공식 발급 경로라, 명령을
   그대로 대행하면 내부 플로우가 개편돼도 안전하다. 실측(2026-07-18): 비TTY에선 조용히 종료하므로
   script(1)로 PTY를 입힌다. PTY에선 코드 프롬프트 없이 브라우저를 열어 승인을 자동 수신하고,
   완료 시 stdout의 sk-ant-oat01- 토큰을 형식 검증 후 회사 자격으로 저장한다(터미널 불필요).
   기존 수동 붙여넣기 경로는 그대로 유지 — 이 대행이 실패하는 환경의 폴백이다(회귀 없음). */
const SETUP_TOKEN_TIMEOUT_MS = 10 * 60_000; // 브라우저 승인 대기 상한

/** PTY 출력에서 setup-token의 최종 토큰 추출(순수) — ANSI 제거 후 매치.
    PTY(기본 80칸)가 긴 토큰을 줄바꿈으로 감싼다 — 토큰 문자 사이의 개행을 접합해 복원한다
    (실사고 2026-07-19 재현: 108자 토큰이 80자로 절단 저장 → '연결됨'인데 전 호출 인증 실패).
    접합이 뒤따르는 텍스트를 흡수하는 엣지에 대비해 [접합본, 원본] 두 후보를 반환하고,
    호출부(startClaudeSetupToken)가 저장 전 HTTP 검증으로 유효한 쪽만 저장한다.
    (export: 회귀 테스트용 — 첫 번째 후보가 기본값) */
export function extractSetupTokenCandidates(text) {
  const clean = String(text ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
  const joined = clean.replace(/([A-Za-z0-9_-])\r?\n(?=[A-Za-z0-9_-])/g, '$1');
  const re = /sk-ant-oat01-[A-Za-z0-9_-]{16,}/;
  return [...new Set([joined.match(re)?.[0], clean.match(re)?.[0]].filter(Boolean))];
}
export function extractSetupToken(text) {
  return extractSetupTokenCandidates(text)[0] ?? null;
}

/** PTY 출력에서 인증 URL 추출(순수) — 신형 CLI(2.1.x)의 setup-token은 승인 후 브라우저에 코드를
    표시하고 터미널 입력을 요구한다(redirect_uri=platform.claude.com/oauth/code/callback — 실측
    2026-07-22). 브라우저가 안 열린 기기(신규 맥 신고)를 위해 이 URL을 UI에 링크로 노출한다.
    PTY 80칸 줄바꿈을 접합해 복원(extractSetupTokenCandidates와 동일 처리). (export: 회귀 테스트용) */
export function extractSetupAuthUrl(text) {
  const clean = String(text ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
  const joined = clean.replace(/([!-~])\r?\n(?=[!-~])/g, '$1'); // URL 문자(인쇄 가능 비공백) 사이 개행 접합
  const url = joined.match(/https:\/\/claude\.com\/[A-Za-z0-9/_.~?&=%+-]+/)?.[0] ?? null;
  // 접합이 URL 바로 뒤에 붙은 프롬프트 문구("Paste code here…")까지 흡수하는 오염 제거(검수 MED —
  // 빈 줄 없이 이어지는 실측 레이아웃에서 state 값 끝에 문구가 접합된다). CLI 문구는 영어 고정.
  return url ? url.replace(/Paste.*$/i, '') : null;
}

/** 내장 SDK 네이티브 claude CLI 경로 — 앱/서버가 이미 품고 있는 바이너리(stage-sidecar 3.4가 보장).
    실측: setup-token 서브커맨드 지원. 터미널 무경험 초보자도 설치 0으로 원클릭(브라우저 승인) 연결이
    되게 하는 핵심 폴백이다(유건 지시 2026-07-19: 초보자 여정에서 터미널 요구 제거).
    (export: 회귀 테스트용) */
export async function bundledClaudeCli() {
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const p = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
    if (await exists(p)) return p;
  } catch { /* 플랫폼 패키지 미포함 — 아래 null */ }
  return null;
}

/** setup-token을 실행할 claude CLI 경로 — env 오버라이드 → 호스트 PATH → 내장 SDK CLI 폴백.
    전부 없으면 null(수동 붙여넣기 안내). */
async function resolveClaudeCli() {
  if (process.env.CLAUDE_CLI?.trim()) return process.env.CLAUDE_CLI.trim();
  await ensureCliPath(); // GUI 기동 PATH 보강 — which가 로그인 셸 PATH를 본다
  try { const r = await exec('which', ['claude']); const p = r.stdout.trim(); if (p) return p; } catch { /* 미설치 */ }
  return bundledClaudeCli();
}

const setupState = (globalThis.__argoSetupToken ??= {}); // wsId → { status: running|saved|failed, error, ts }

export function setupTokenStatus(wsId) {
  const s = setupState[wsId];
  // authUrl = 브라우저가 안 열린 기기의 폴백 링크, awaitCode = 신형 CLI 코드 프롬프트 감지(UI가 입력칸을 연다)
  return s ? { status: s.status, error: s.error ?? '', authUrl: s.authUrl ?? '', awaitCode: !!s.awaitCode } : { status: 'idle' };
}

/** 신형 CLI 코드 플로우 — 브라우저 승인 후 표시되는 코드를 UI에서 받아 CLI stdin으로 전달한다.
    (setup-token이 localhost 자동 콜백에서 코드 표시형으로 바뀌어 — 실측 2026-07-22 — stdin 없는
    PTY 대행은 영원히 완주 불가였다. 이 왕복이 원클릭 연결의 완결 경로다.) */
export function submitSetupCode(wsId, code) {
  const s = setupState[wsId];
  const v = String(code ?? '').trim();
  if (!s || s.status !== 'running' || typeof s.write !== 'function') return { ok: false, reason: 'not-running' };
  if (!v || v.length > 4096 || /[\r\n]/.test(v)) return { ok: false, reason: 'bad-code' };
  try { s.write(`${v}\n`); return { ok: true }; } catch (e) { return { ok: false, reason: String(e.message || e).slice(0, 120) }; }
}

export async function startClaudeSetupToken(wsId) {
  // 원클릭(setup-token PTY 대행)이 완주하려면 서버가 (a) 사용자 GUI 세션에서 브라우저를 열 수 있고
  // (b) setup-token의 localhost 콜백 리스너가 승인 시점까지 살아 있어야 한다. 이 둘이 성립하는 곳은
  // 데스크톱 번들 사이드카(ARGO_STANDALONE=1 — Tauri가 GUI·프로세스 수명을 관리)뿐이다.
  // 상주(launchd 백그라운드 데몬)·웹·dev는 브라우저를 못 열거나 콜백이 끊겨(승인 후 localhost:콜백이
  // ERR_CONNECTION_REFUSED — 실사용 신고 2026-07-19) 스피너만 돈다. 그 환경들은 원클릭을 열지 않고
  // 'manual'(터미널에서 claude setup-token 실행 → 토큰 붙여넣기)로 안내한다.
  // (앞선 #44의 loopback 판정은 이 완주 조건을 담지 못해 상주에서 스피너 함정을 만들었다 — standalone으로 교정.)
  // ARGO_TENANT_OWNER는 벨트앤서스펜더 하드 차단 — 누군가 호스팅 런타임에 실수로 ARGO_STANDALONE=1을
  // 넣어도(standalone 서버라 "필요해 보이는" 흔한 실수) 다중테넌트에선 원클릭이 재개방되지 않도록(검수 LOW).
  if (process.env.ARGO_TENANT_OWNER || process.env.ARGO_STANDALONE !== '1') return { ok: false, reason: 'manual' };
  if (process.platform === 'win32') return { ok: false, reason: 'unsupported-platform' }; // script(1) 부재 — 후속(node-pty 검토)
  // 재클릭 = 재시작 — 승인 없이 브라우저를 닫으면 이전 시도가 10분 타임아웃까지 'running'으로 잠겨
  // 모든 재클릭이 busy로 거절되고 브라우저가 다시는 안 열리던 함정 제거(실사용 신고 2026-07-20:
  // "인증을 취소했으면 처음부터 다시 시도할 수 있어야 한다"). 이전 시도는 죽이고 새로 연다.
  const prev = setupState[wsId];
  if (prev?.status === 'running') { try { prev.cancel?.(); } catch { /* 이미 종료 */ } }
  // 조기 반환(no-cli·fifo/spawn 실패) 시 이전 'running' 잔상이 슬롯에 남으면 — cancel로 이미 죽어
  // finish가 영영 안 옴 — UI 폴링이 11분을 헛돈다(검수 LOW). 시작 실패는 슬롯을 비워 idle로 돌린다.
  const bail = (r) => { delete setupState[wsId]; return r; };
  const cli = await resolveClaudeCli();
  if (!cli) return bail({ ok: false, reason: 'no-cli' });
  // 코드 왕복 채널 — 신형 CLI(2.1.x)는 승인 후 브라우저에 표시된 코드를 stdin으로 받아야 완주한다
  // (실측 2026-07-22 "Paste code here if prompted"). node의 pipe는 socketpair라 macOS script(1)가
  // stdin에서 tcgetattr 실패로 즉사한다(실측 exit 1, "Operation not supported on socket") — script의
  // stdin은 /dev/null로 두고, **CLI의 stdin만** named fifo로 리다이렉트해 UI가 받은 코드를 흘려보낸다.
  let fifoDir = null, fifo = null, wfd = null;
  try {
    fifoDir = await mkdtemp(join(tmpdir(), 'argo-setup-'));
    fifo = join(fifoDir, 'in');
    await exec('mkfifo', [fifo]);
    wfd = openSync(fifo, 'r+'); // r+ — reader(CLI)보다 먼저 열어도 블록되지 않는다
  } catch (e) {
    return bail({ ok: false, reason: 'spawn-failed', message: String(e.message || e) });
  }
  // 경로는 단일인용 이스케이프(공백·메타문자 인젝션 차단 — env/PATH 유래 값). fifo는 mkdtemp 산출이라 안전.
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const shCmd = `exec ${q(cli)} setup-token < ${q(fifo)}`;
  const args = process.platform === 'darwin'
    ? ['-q', '/dev/null', 'sh', '-c', shCmd]
    : ['-qec', shCmd, '/dev/null'];
  const cleanupFifo = () => {
    try { if (wfd != null) closeSync(wfd); } catch { /* 이미 닫힘 */ }
    wfd = null;
    if (fifoDir) rm(fifoDir, { recursive: true, force: true }).catch(() => {});
  };
  let child;
  try {
    child = spawn('script', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    cleanupFifo();
    return bail({ ok: false, reason: 'spawn-failed', message: String(e.message || e) });
  }
  let buf = '';
  let done = false;
  let timer;
  const gen = (prev?.gen ?? 0) + 1; // 세대 — 구시도의 늦은 finish/저장이 새 시도 상태를 덮지 않게
  const cancel = () => { done = true; clearTimeout(timer); try { child.kill(); } catch { /* 이미 종료 */ } cleanupFifo(); };
  const write = (s) => { if (wfd != null) writeSync(wfd, s); }; // 코드 왕복(fifo → CLI stdin) — submitSetupCode가 부른다
  // 슬롯의 세대가 내 것일 때만 기록 — 새 시도가 인수했거나 슬롯이 폐기(삭제)됐으면 늦은 결과는 버린다
  const commit = (next) => { if (setupState[wsId]?.gen !== gen) return; setupState[wsId] = { ...next, gen, cancel, write }; };
  // 부분 갱신(authUrl·awaitCode) — running 상태를 유지한 채 필드만 덧댄다
  const patch = (fields) => { if (setupState[wsId]?.gen !== gen) return; setupState[wsId] = { ...setupState[wsId], ...fields }; };
  const finish = (status, error = '') => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    // 실패 진단 표면화 — 신규 기기에서만 나는 실패는 개발 PC에서 재현이 안 된다("내 PC 테스트는 소용
    // 없다" — 유건 지적 2026-07-22). CLI가 마지막에 뱉은 말을 화면까지 들고 온다(토큰류는 마스킹).
    let diag = '';
    if (status === 'failed') {
      const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
        .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
        .replace(/[?&](code|state|code_challenge)=[^&\s]+/g, '')
        .replace(/\s+/g, ' ').trim().slice(-180);
      if (clean) diag = ` (CLI: …${clean})`;
    }
    commit({ status, error: error ? `${error}${diag}` : error, ts: Date.now() });
    try { child.kill(); } catch { /* 이미 종료 */ }
    cleanupFifo();
  };
  timer = setTimeout(() => finish('failed', '승인 대기 시간(10분)이 지났습니다 — 다시 시도하거나 토큰을 직접 붙여넣어 주세요'), SETUP_TOKEN_TIMEOUT_MS);
  timer.unref?.();
  setupState[wsId] = { status: 'running', ts: Date.now(), gen, cancel, write };
  const onData = (d) => {
    if (done) return;
    buf = (buf + d.toString()).slice(-20_000); // 꼬리만 유지 — 토큰은 마지막에 출력된다
    // 신형 CLI 코드 플로우 관측 — 인증 URL(브라우저 미개방 기기의 폴백 링크)과 코드 프롬프트를
    // 상태로 노출해 UI가 링크·코드 입력칸을 연다(submitSetupCode → stdin 왕복).
    if (!setupState[wsId]?.authUrl) {
      const url = extractSetupAuthUrl(buf);
      if (url) patch({ authUrl: url });
    }
    if (!setupState[wsId]?.awaitCode) {
      const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\s+/g, '');
      if (/pastecodehere/i.test(clean)) patch({ awaitCode: true });
    }
    const candidates = extractSetupTokenCandidates(buf);
    if (!candidates.length) return;
    // 토큰 감지 즉시 선점 — setup-token은 토큰 출력 직후 종료하므로, 비동기 저장이 끝나기 전의
    // 정상 exit가 finish('failed')로 덮으면 "저장됐는데 실패 표시"가 된다(검수 MEDIUM: 저장-exit 레이스).
    // done을 먼저 잠그고 저장 결과가 최종 상태를 정한다(그동안 상태는 running 유지 — UI는 진행 중 표시).
    done = true;
    clearTimeout(timer);
    try { child.kill(); } catch { /* 이미 종료 */ }
    cleanupFifo(); // 성공 경로에서도 fifo fd·임시 디렉토리 정리 — 상주 사이드카의 fd 누적 방지(검수 MED)
    // 저장 전 실검증(HTTP Bearer, verifyRunnerCred) — 잘린/무효 토큰이 '연결됨'으로 저장되는 것을
    // 원천 차단(실사고 2026-07-19: PTY 줄바꿈 절단 토큰 저장 → 연결됨 표시인데 전 호출 인증 실패).
    // 후보(접합본→원본) 중 검증을 통과한 것만 저장. 네트워크 불가(ok:null)는 첫 후보 관용 저장(오프라인 온보딩).
    // 토큰 평문은 저장 외 어디에도 남기지 않는다(로그·상태 객체 금지).
    (async () => {
      let chosen = null;
      let sawInvalid = false;
      let sawOffline = false;
      for (const t of candidates) {
        const v = await verifyRunnerCred('claude', 'oauth', t);
        if (v.ok === false) { sawInvalid = true; continue; }
        if (v.ok === true) { chosen = t; break; }
        sawOffline = true; // ok:null — 판정 불가. 확정하지 않고 다음 후보를 계속 본다(검수 LOW:
        // 첫 후보(접합본)가 흡수 오염본일 때 블립이 겹치면 오염 저장 — 관용은 아래에서 원본으로만)
      }
      // 관용 저장은 후보가 하나뿐일 때만 — 둘 이상인데 전부 판정 불가면 어느 쪽이 온전한지 알 수
      // 없으므로(줄바꿈 케이스에선 마지막=절단본!) 저장하지 않고 재시도를 유도한다(검수 LOW 반영).
      if (!chosen && sawOffline && !sawInvalid && candidates.length === 1) chosen = candidates[0];
      if (!chosen) {
        commit({ status: 'failed', error: sawInvalid ? '토큰 검증에 실패했습니다(잘려 읽혔거나 무효) — 다시 시도해 주세요' : '토큰을 읽지 못했습니다 — 다시 시도해 주세요', ts: Date.now() });
        return;
      }
      await saveRunnerCred(wsId, 'claude', 'oauth', chosen)
        .then(() => { commit({ status: 'saved', ts: Date.now() }); })
        .catch((e) => { commit({ status: 'failed', error: String(e.message || e).slice(0, 160), ts: Date.now() }); });
    })();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', () => finish('failed', '로그인이 완료되지 않았습니다 — 브라우저에서 승인한 뒤 표시된 코드를 입력칸에 붙여넣어야 완료됩니다. 다시 시도하거나 토큰을 직접 붙여넣어 주세요'));
  child.on('error', (e) => finish('failed', String(e.message || e).slice(0, 160)));
  return { ok: true };
}

export { ensureCliPath }; // 러너 모듈 내부 공용(facade 미노출 — externalExec가 쓴다)
