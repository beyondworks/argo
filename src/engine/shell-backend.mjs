// 윈도우 셸 백엔드 — Bash 도구가 명령을 **어느 실행기로** 보낼지(라우터)와 **어떤 POSIX sh**를 쓸지(사다리)를 정한다.
//
// 배경(2026-09-06 윈도우 CI 실측 — 모델이 흔히 내는 명령 59건을 셸 4종으로): cmd.exe는 POSIX 표준 30건 중 14건만 통과했고 그마저
// Git 유틸이 PATH에 있는 러너 기준이다. Node가 인자를 `\"`로 감싸는 것을 cmd가 못 풀어 따옴표 든 명령이 전부 손상됐고(`echo "$HOME"` →
// `\"$HOME\"`), 한글은 0/4, `mkdir -p`는 '-p' 디렉터리를 만들었다. Git Bash는 30/30이지만 경로를 `/d/…`(MSYS)로 내 모델이 Read·Edit 인자로
// 복사하면 Node가 못 연다(4건 중 1건만). busybox-w32 **UTF-8 빌드**는 30/30·한글 4/4·네이티브 경로 4/4·타임아웃 트리 종료까지 통과했다.
//
// 모델은 OS를 모르고 bash 문법으로 말한다(도구 이름이 Bash, 시스템 프롬프트에 OS 언급 없음). 그래서 기본은 POSIX sh이고, cmd 고유 문법
// (`dir`·`type 파일`·`copy`·`%VAR%`…)과 PowerShell 동사-명사만 원래 실행기로 보낸다 — 번역이 아니라 원래 실행기가 원래 의미대로 처리한다.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

/** 동봉 실행 파일 — busybox-w32 UTF-8 매니페스트 빌드(FRP, GPLv2 — THIRD-PARTY-NOTICES.md). 일반 빌드(busybox64.exe)는 한글 인자·파일명이 '?'가 된다(실측). */
export const BUSYBOX_FILE = 'busybox64u.exe';
/** cmd.exe **내장** 동사 — 실행 파일이 아니라 cmd 안에서만 있는 것들. findstr·where·tasklist·powershell은 exe라 어느 셸에서나 된다(실측). */
const CMD_BUILTINS = new Set(['dir', 'copy', 'del', 'erase', 'move', 'ren', 'rename', 'md', 'rd', 'cls', 'call', 'start', 'mklink']);
const SEGMENT_RE = /\|\||&&|;|\||&|\n/; // 명령 구획(cmd·POSIX 공통 연산자)

/** 라우터(순수) — 'sh' | 'cmd' | 'powershell'. 구획마다 첫 단어와 `%VAR%` 토큰만 본다. */
export function classifyCommand(command) {
  const s = String(command ?? '').trim();
  if (!s) return 'sh';
  if (/^[A-Z][a-z]+-[A-Z][A-Za-z]+(\s|$)/.test(s)) return 'powershell'; // Get-ChildItem 같은 동사-명사(powershell.exe 호출 자체는 실행 파일이라 sh)
  if (/(^|[\s"'=])%[A-Za-z_][A-Za-z0-9_]*%(?=[\s"'\\/;&|]|$)/.test(s)) return 'cmd'; // %USERPROFILE% 토큰 — date +%Y%m%d·printf "%s"는 안 걸린다
  for (const seg of s.split(SEGMENT_RE)) {
    const t = seg.trim(); if (!t) continue;
    const first = t.split(/\s+/)[0].toLowerCase().replace(/\.exe$/, '');
    if (first === 'set' && /^set\s+[A-Za-z_][A-Za-z0-9_]*=/.test(t)) return 'cmd'; // set X=1(cmd) vs set -e(POSIX)
    if (first === 'type' && /^type\s+("[^"]*[.\\/][^"]*"|[^\s"|;&-][^\s"|;&]*[.\\/])/.test(t)) return 'cmd'; // type 파일.ext·경로·"a b.txt"(cmd) vs type node(POSIX 내장)
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

function defaultProbe(cand) {
  const { args } = shellSpawn(cand.kind, 'echo argo-shell-ok');
  const r = spawnSync(cand.file, args, { windowsHide: true, timeout: 5000, encoding: 'utf8' });
  if (r.error) return r.error.code || r.error.message;
  return /argo-shell-ok/.test(r.stdout || '') ? true : `exit ${r.status}`;
}
let picked = null;
/** 실제 POSIX sh 선택 — 프로세스당 1회 자가 진단(`echo argo-shell-ok`). 실패(없음·백신 격리·실행 거부)는 다음 후보로 내려가고 tried에 사유를 남긴다.
    비윈도우는 /bin/sh 고정. probe·platform 주입은 테스트용. */
export function resolveShell(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { kind: 'sh', file: '/bin/sh', tried: [] };
  if (picked && !opts.force) return picked;
  const tried = []; const probe = opts.probe ?? defaultProbe;
  for (const cand of shellCandidates(opts)) {
    if (cand.kind === 'cmd') { picked = { ...cand, tried }; return picked; }
    if (!existsSync(cand.file)) { tried.push({ ...cand, reason: 'missing' }); continue; }
    const r = probe(cand);
    if (r !== true) { tried.push({ ...cand, reason: String(r) }); continue; }
    picked = { ...cand, tried }; return picked;
  }
  picked = { kind: 'cmd', file: 'cmd.exe', tried }; return picked;
}
export const resetShellCache = () => { picked = null; };
/** 폴백인가(순수) — 스탠드얼론(동봉 있음)에서 동봉 실행기를 못 쓰는 상태. 개발 실행(동봉 없음)은 폴백이 아니다. */
export const isShellFallback = (sel, env = process.env) => Boolean(env.ARGO_STANDALONE) && sel?.kind !== 'busybox';
/** Git Bash(MSYS) 출력의 `/c/Users/…`를 `C:/Users/…`로 — 모델이 pwd·find 출력을 Read·Edit 인자로 복사할 때 Node가 열 수 있게. URL(`http://x/c/y`)은 앞이 `/`라 안 걸린다. */
export const normalizeMsysPaths = (out) => String(out).replace(/(^|[\s"'=(:])\/([a-zA-Z])\/(?=[^\s"'/]|$)/g, (m, pre, d) => `${pre}${d.toUpperCase()}:/`);
