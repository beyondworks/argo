// 우측 도구 패널용 로컬 셸 세션.
// PTY 의존성을 번들에 추가하지 않고도 cd/export 상태가 이어지는 실제 장기 실행 셸을 stdin/stdout으로 유지한다.
// 전체화면 TUI·터미널 크기 제어는 지원하지 않지만 일반 명령, 장기 프로세스 출력, 중단은 같은 세션에서 동작한다.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { scrubServerSecrets } from './runners.mjs';

const STORE_KEY = Symbol.for('argo.tool-terminal.sessions.v1');
const MAX_OUTPUT = 1024 * 1024;
const MAX_INPUT = 16 * 1024;
const MAX_SESSIONS = 8;
const IDLE_MS = 30 * 60 * 1000;

const sessions = globalThis[STORE_KEY] ??= new Map();

/** CSI/OSC 등 화면 제어만 걷는다. 탭·줄바꿈과 사람이 읽을 텍스트는 보존한다. */
export function cleanTerminalOutput(input) {
  return String(input ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\x09\x0a\x20-\x7e\u0080-\uffff]/g, '');
}

function childEnv(env = process.env) {
  // runner='terminal'은 어느 모델 제공사 소유자도 아니므로 서버 시크릿과 모든 모델 키가 함께 제거된다.
  const clean = scrubServerSecrets(env, 'terminal');
  for (const key of Object.keys(clean)) {
    if (key.startsWith('ARGO_') || key.startsWith('NEXT_PUBLIC_') || key.startsWith('SUPABASE_')) delete clean[key];
  }
  return { ...clean, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' };
}

function append(session, chunk) {
  const text = cleanTerminalOutput(chunk);
  if (!text) return;
  session.output += text;
  if (session.output.length > MAX_OUTPUT) {
    const trim = session.output.length - MAX_OUTPUT;
    session.output = session.output.slice(trim);
    session.base += trim;
  }
  session.updatedAt = Date.now();
}

function dispose(session, signal = 'SIGTERM') {
  if (!session || session.closed) return;
  session.closed = true;
  try {
    if (process.platform !== 'win32' && session.child.pid) process.kill(-session.child.pid, signal);
    else session.child.kill(signal);
  } catch { /* 이미 종료됨 */ }
}

function sweep() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt <= IDLE_MS) continue;
    dispose(session);
    sessions.delete(id);
  }
}

function lookup(id, wsId) {
  sweep();
  const session = sessions.get(id);
  if (!session || session.wsId !== wsId) throw Object.assign(new Error('terminal-not-found'), { code: 'terminal-not-found', status: 404 });
  session.updatedAt = Date.now();
  return session;
}

export function startToolTerminal({ wsId, cwd, env = process.env }) {
  sweep();
  if (sessions.size >= MAX_SESSIONS) {
    throw Object.assign(new Error('terminal-limit'), { code: 'terminal-limit', status: 429 });
  }
  if (!isAbsolute(cwd)) throw Object.assign(new Error('terminal-invalid-cwd'), { code: 'terminal-invalid-cwd', status: 400 });

  const shell = process.platform === 'win32'
    ? (env.ComSpec || env.COMSPEC || 'cmd.exe')
    : (isAbsolute(env.SHELL || '') ? env.SHELL : '/bin/sh');
  const args = process.platform === 'win32' ? ['/Q'] : [];
  const child = spawn(shell, args, {
    cwd,
    env: childEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const now = Date.now();
  const session = {
    id: randomUUID(),
    wsId,
    cwd,
    shell,
    child,
    output: '',
    base: 0,
    createdAt: now,
    updatedAt: now,
    exited: false,
    exitCode: null,
    closed: false,
  };
  append(session, `Argo terminal · ${cwd}\n`);
  child.stdout.on('data', (chunk) => append(session, chunk));
  child.stderr.on('data', (chunk) => append(session, chunk));
  child.on('error', (error) => append(session, `셸 시작 실패: ${error.message}\n`));
  child.on('exit', (code, signal) => {
    session.exited = true;
    session.exitCode = code;
    append(session, `\n[프로세스 종료${signal ? ` · ${signal}` : code == null ? '' : ` · ${code}`}]\n`);
  });
  sessions.set(session.id, session);
  return { id: session.id, shell, cwd, cursor: 0 };
}

export function writeToolTerminal({ wsId, id, input }) {
  const session = lookup(id, wsId);
  if (session.exited || session.closed || !session.child.stdin?.writable) {
    throw Object.assign(new Error('terminal-exited'), { code: 'terminal-exited', status: 409 });
  }
  const command = String(input ?? '').replace(/\r\n?/g, '\n');
  if (!command.trim() || command.length > MAX_INPUT || command.includes('\0')) {
    throw Object.assign(new Error('terminal-invalid-input'), { code: 'terminal-invalid-input', status: 400 });
  }
  append(session, `$ ${command.replace(/\n+$/g, '')}\n`);
  session.child.stdin.write(command.endsWith('\n') ? command : `${command}\n`);
  return { ok: true };
}

export function readToolTerminal({ wsId, id, cursor = 0 }) {
  const session = lookup(id, wsId);
  const requested = Number.isFinite(Number(cursor)) ? Math.max(0, Number(cursor)) : 0;
  const start = Math.max(requested, session.base);
  const output = session.output.slice(start - session.base);
  return {
    output,
    cursor: session.base + session.output.length,
    truncated: requested < session.base,
    exited: session.exited,
    exitCode: session.exitCode,
    cwd: session.cwd,
  };
}

export function interruptToolTerminal({ wsId, id }) {
  const session = lookup(id, wsId);
  if (session.exited || session.closed) return { ok: true, exited: true };
  try {
    if (process.platform !== 'win32' && session.child.pid) process.kill(-session.child.pid, 'SIGINT');
    else session.child.kill('SIGINT');
  } catch { /* 종료 경합 */ }
  append(session, '^C\n');
  return { ok: true };
}

export function closeToolTerminal({ wsId, id }) {
  const session = lookup(id, wsId);
  dispose(session);
  sessions.delete(id);
  return { ok: true };
}

export function toolTerminalCount() {
  sweep();
  return sessions.size;
}
