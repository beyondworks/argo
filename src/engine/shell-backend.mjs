// 윈도우 셸 백엔드 — Bash 도구가 명령을 **어느 실행기로** 보낼지(라우터)와 **어떤 POSIX sh**를 쓸지(사다리)를 정한다.
//
// 배경(2026-09-06 윈도우 CI 실측 — 모델이 흔히 내는 명령 59건을 셸 4종으로): cmd.exe는 POSIX 표준 30건 중 14건만 통과했고 그마저
// Git 유틸이 PATH에 있는 러너 기준이다. Node가 인자를 `\"`로 감싸는 것을 cmd가 못 풀어 따옴표 든 명령이 전부 손상됐고(`echo "$HOME"` →
// `\"$HOME\"`), 한글은 0/4, `mkdir -p`는 '-p' 디렉터리를 만들었다. Git Bash는 30/30이지만 경로를 `/d/…`(MSYS)로 내 모델이 Read·Edit 인자로
// 복사하면 Node가 못 연다(4건 중 1건만). busybox-w32 **UTF-8 빌드**는 30/30·한글 4/4·네이티브 경로 4/4·타임아웃 트리 종료까지 통과했다.
// 종전 cmd.exe 경로를 강제한 채 새 단언을 돌리면 윈도우 CI가 red(초안 PR #449 실증).
//
// 모델은 OS를 모르고 bash 문법으로 말한다(도구 이름이 Bash, 시스템 프롬프트에 OS 언급 없음). 그래서 기본은 POSIX sh이고, cmd 고유 문법
// (`dir`·`type 파일`·`copy`·`%VAR%`…)과 PowerShell 동사-명사만 원래 실행기로 보낸다 — 번역이 아니라 원래 실행기가 원래 의미대로 처리한다.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

/** 동봉 실행 파일 — busybox-w32 UTF-8 매니페스트 빌드(FRP, GPLv2 — THIRD-PARTY-NOTICES.md). 일반 빌드(busybox64.exe)는 한글 인자·파일명이 '?'가 된다(실측). */
export const BUSYBOX_FILE = 'busybox64u.exe';
/** cmd.exe **내장** 동사 — 실행 파일이 아니라 cmd 안에서만 있는 것들. findstr·where·tasklist·powershell은 exe라 어느 셸에서나 된다(실측). */
const CMD_BUILTINS = new Set(['dir', 'copy', 'del', 'erase', 'move', 'ren', 'rename', 'md', 'rd', 'cls', 'call', 'start', 'mklink']);
const SEGMENT_RE = /\|\||&&|;|\||&|\n/; // 명령 구획(cmd·POSIX 공통 연산자)
const VERB_NOUN_RE = /^[A-Z][a-z]+-[A-Z][A-Za-z]+(\s|$)/; // Get-ChildItem — powershell.exe 호출 자체는 실행 파일이라 sh

/** 따옴표 안 내용의 대체(순수) — 명령이 아닌 데이터는 비우되, 판정에 필요한 **모양**만 남긴다:
    `%VAR%\경로`(cmd 관용구 — 2R N1: 공백 든 윈도우 경로는 따옴표로 싼다) → `"%p%\p"`, `X=1`(`set "X=1"`) → `"p=p"`, 경로 모양(`.`·`\`·`/`) → `"p.p"`, 그 밖은 `""`. */
const WIN_ENV_RE = /^%(USERPROFILE|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|SYSTEMROOT|SYSTEMDRIVE|WINDIR|HOMEPATH|HOMEDRIVE|COMPUTERNAME|USERNAME|PUBLIC|CD|DATE|TIME|ERRORLEVEL|PATH|OS)%/i; // 윈도우 환경변수 — `"%VERSION%"` 같은 템플릿 자리표시와 구분
const quotedShape = (c, q) => (WIN_ENV_RE.test(c) || /^%[A-Za-z_]\w*%[\\/]/.test(c) ? `${q}%p%${/[\\/]/.test(c) ? '\\p' : ''}${q}` : /^[A-Za-z_]\w*=/.test(c) ? `${q}p=p${q}` : /[.\\/]/.test(c) ? `${q}p.p${q}` : `${q}${q}`);
/** 데이터 비우기(순수) — 히어독 본문과 따옴표 문자열은 명령이 아니다(1R M2: 커밋 메시지·grep 패턴·히어독 산문 속 `move`·`Start`·`%VERSION%`이 cmd로 샜다).
    히어독은 줄 단위로 걷어내고, 따옴표는 이어 붙인 전체에서 비운다(여러 줄에 걸친 커밋 본문도 데이터 — 2R N2). `<<<`(here-string)는 히어독이 아니다. */
export function stripDataText(command) {
  const out = []; let term = null;
  for (const line of String(command ?? '').split('\n')) {
    if (term !== null) { if (line.replace(/^\t+/, '') === term) term = null; continue; } // 히어독 본문(종결자 줄까지)은 버린다
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/); if (m) term = m[2];
    out.push(line);
  }
  return out.join('\n').replace(/"((?:[^"\\]|\\[\s\S])*)"/g, (_, c) => quotedShape(c, '"')).replace(/'([^']*)'/g, (_, c) => quotedShape(c, "'"));
}

/** 라우터(순수) — 'sh' | 'cmd' | 'powershell'. 데이터를 비운 뒤 구획마다 첫 단어와 `%VAR%` 토큰만 본다(대소문자 무관). */
export function classifyCommand(command) {
  const s = stripDataText(command).trim();
  if (!s) return 'sh';
  if (/(^|[\s=("'])%[A-Za-z_][A-Za-z0-9_]*%(?=[\s"'\\/;&|)]|$)/.test(s)) return 'cmd'; // %USERPROFILE% 토큰(따옴표 안 경로 모양 포함) — date +%Y%m%d·printf "%s"·echo 100%는 안 걸린다
  if (/\b[A-Za-z_]\w*\s*\(\)\s*\{/.test(s)) return 'sh'; // 셸 함수 정의(`copy() { … }`)는 POSIX — 그 이름이 cmd 동사여도 명령이 아니다(1R M2)
  for (const seg of s.split(SEGMENT_RE)) {
    const t = seg.trim(); if (!t) continue;
    if (VERB_NOUN_RE.test(t)) return 'powershell';
    const first = t.split(/\s+/)[0].toLowerCase().replace(/\.exe$/, '');
    if (first === 'set' && /^set\s+"?[A-Za-z_][A-Za-z0-9_]*=/i.test(t)) return 'cmd'; // set X=1·set "X=1"(cmd) vs set -e(POSIX)
    if (first === 'type' && /^type\s+(["'][^"']*[.\\/][^"']*["']|[^\s"'|;&-][^\s"'|;&]*[.\\/])/i.test(t)) return 'cmd'; // type 파일.ext·경로·"a b.txt"(cmd) vs type node(POSIX 내장)
    if (first === 'rmdir' && /\s\/[sq]\b/i.test(t)) return 'cmd';
    if (CMD_BUILTINS.has(first)) return 'cmd';
  }
  return 'sh';
}

/** 후보 사다리(순수) — ARGO_SHELL(개발자 지정) → 동봉 busybox(서버 디렉터리 bin/ — cwd·실행 파일 기준) → Git Bash(설치돼 있으면) → cmd.exe(마지막). */
export function shellCandidates({ env = process.env, cwd = process.cwd(), argv1 = process.argv[1] } = {}) {
  const out = [];
  if (env.ARGO_SHELL) out.push({ kind: /busybox/i.test(env.ARGO_SHELL) ? 'busybox' : 'gitbash', file: env.ARGO_SHELL });
  for (const base of [cwd, argv1 ? dirname(argv1) : null].filter(Boolean)) out.push({ kind: 'busybox', file: resolve(base, 'bin', BUSYBOX_FILE) });
  for (const p of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : null].filter(Boolean)) out.push({ kind: 'gitbash', file: join(p, 'Git', 'bin', 'bash.exe') });
  out.push({ kind: 'cmd', file: 'cmd.exe' });
  return out;
}

/** 백엔드별 spawn 인자(순수). cmd는 명령을 따옴표로 감싸 **그대로** 넘긴다(windowsVerbatimArguments) — Node의 `\"` 이스케이프를 cmd가 못 푼다(실측). */
export function shellSpawn(kind, command) {
  if (kind === 'busybox') return { args: ['sh', '-c', command], verbatim: false };
  if (kind === 'powershell') return { args: ['-NoProfile', '-NonInteractive', '-Command', command], verbatim: false };
  if (kind === 'cmd') return { args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
  return { args: ['-c', command], verbatim: false }; // sh · gitbash
}

export const PROBE_TIMEOUT_MS = 2000;
/** 자가 진단(비동기 — 서버 이벤트 루프를 막지 않는다, 1R L6): `echo argo-shell-ok`. true 또는 실패 사유 문자열. */
function probeAsync(cand) {
  return new Promise((res) => {
    const { args } = shellSpawn(cand.kind, 'echo argo-shell-ok'); let out = ''; let child;
    try { child = spawn(cand.file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return res(e.code || e.message); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 종료 */ } res('timeout'); }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); res(e.code || e.message); });
    child.on('close', (code) => { clearTimeout(timer); res(/argo-shell-ok/.test(out) ? true : `exit ${code}`); });
  });
}
export const FALLBACK_RECHECK_MS = 10 * 60_000; // 폴백 상태면 10분마다 동봉 실행기를 다시 시도 — 백신 예외 추가·재설치 뒤 재시작 없이 복구(1R L3)
let picked = null; let pickedAt = 0; let inflight = null; // 진행 중 공유 — 동시 첫 호출이 프로브를 중복하고 늦게 끝난 결과가 캐시를 덮던 것(2R N3)
/** 실제 POSIX sh 선택 — 동봉이 잡히면 프로세스당 1회, 폴백이면 FALLBACK_RECHECK_MS마다 재진단. 실패(없음·백신 격리·실행 거부)는 다음 후보로 내려가고 tried에 사유를 남긴다.
    비윈도우는 /bin/sh 고정. probe·platform·now 주입은 테스트용. */
export async function resolveShell(opts = {}) {
  const platform = opts.platform ?? process.platform; const now = opts.now ?? Date.now();
  if (platform !== 'win32') return { kind: 'sh', file: '/bin/sh', tried: [] };
  if (picked && !opts.force && (picked.kind === 'busybox' || now - pickedAt < FALLBACK_RECHECK_MS)) return picked;
  if (inflight && !opts.force) return inflight;
  const run = (async () => {
    const tried = []; const probe = opts.probe ?? probeAsync;
    for (const cand of shellCandidates(opts)) {
      if (cand.kind === 'cmd') break;
      if (!existsSync(cand.file)) { tried.push({ ...cand, reason: 'missing' }); continue; }
      const r = await probe(cand);
      if (r !== true) { tried.push({ ...cand, reason: String(r) }); continue; }
      picked = { ...cand, tried }; pickedAt = now; return picked;
    }
    picked = { kind: 'cmd', file: 'cmd.exe', tried }; pickedAt = now; return picked;
  })();
  inflight = run.finally(() => { inflight = null; });
  return inflight;
}
export const resetShellCache = () => { picked = null; pickedAt = 0; inflight = null; };
/** 폴백인가(순수) — 스탠드얼론(동봉 있음)에서 동봉 실행기를 못 쓰는 상태. 개발 실행(동봉 없음)은 폴백이 아니다. */
export const isShellFallback = (sel, env = process.env) => Boolean(env.ARGO_STANDALONE) && sel?.kind !== 'busybox';
/** Git Bash(MSYS) 출력의 `/c/Users/…`를 `C:/Users/…`로 — 모델이 pwd·find 출력을 Read·Edit 인자로 복사할 때 Node가 열 수 있게. URL(`http://x/c/y`)은 앞이 `/`라 안 걸린다.
    드라이브 문자 형태만 — MSYS 가상 경로(`/tmp`·`/usr`·`/home`)는 윈도우 경로를 알 수 없어 그대로(2단계 폴백의 알려진 한계, 회사 폴더는 드라이브 아래라 해당 없음). */
export const normalizeMsysPaths = (out) => String(out).replace(/(^|[\s"'=(:])\/([a-zA-Z])\/(?=[^\s"'/]|$)/g, (m, pre, d) => `${pre}${d.toUpperCase()}:/`);

/** 실행 계획 — runBash가 그대로 spawn한다. 비윈도우는 /bin/sh. normalize: Git Bash 출력 경로 정규화, fallback: 스탠드얼론에서 동봉을 못 쓰는 상태(회사당 1회 표시). */
export async function planShellRun(command, { env = process.env, platform = process.platform, ...rest } = {}) {
  if (platform !== 'win32') return { kind: 'sh', file: '/bin/sh', ...shellSpawn('sh', command), normalize: false, fallback: false, tried: [] };
  const route = classifyCommand(command);
  const sel = route === 'sh' ? await resolveShell({ env, platform, ...rest }) : { kind: route, file: route === 'cmd' ? 'cmd.exe' : 'powershell.exe', tried: [] };
  return { kind: sel.kind, file: sel.file, ...shellSpawn(sel.kind, command), normalize: sel.kind === 'gitbash', fallback: route === 'sh' && isShellFallback(sel, env), tried: sel.tried ?? [] };
}
