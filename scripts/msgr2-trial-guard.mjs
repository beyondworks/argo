#!/usr/bin/env node
// 메신저 v2 체험 환경(유건님 직접 체험) 관문 — scripts/msgr2-trial-web.sh·msgr2-trial-body.sh가 띄우기 전에 부른다. 하나라도 걸리면 아무것도 띄우지 않는다.
// 1) 주소: qbwr(예비 프로젝트) 하나만 허용. 로컬 하네스(127.0.0.1·localhost)는 --fake일 때만. 운영 주소가 섞이면 여기서 멈춘다(허용 목록 — 운영 주소를 적지 않는다).
// 2) 키: 공개 키(anon·publishable)만. JWT면 role = anon이고 ref가 qbwr인지 본다. 비밀 키(service_role·sb_secret_)는 거부한다. 키 값은 어디에도 출력하지 않는다.
// 3) 체크아웃: 실행할 폴더(루트·apps/messenger)에 .env 파일이 없어야 한다 — Next·Vite가 그 파일을 스스로 읽어 운영 값(서비스 키 등)이 섞인다.
// 4) 데이터 폴더(본체): 이름에 msgr2-trial이 들어간 임시 폴더만. 실제 workspaces·상주 :3001 데이터 폴더를 쓰지 않는다.
// 키 파일: 저장소 밖 ~/.argo/msgr2-trial.env (MSGR2_TRIAL_URL=…, MSGR2_TRIAL_ANON_KEY=…). 값은 총괄이 qbwr 공개 키로 채운다.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const QBWR_REF = 'qbwrlynzvjmphwuqglsx';
export const QBWR_URL = `https://${QBWR_REF}.supabase.co`;
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** JWT 가운데 조각 → 객체(서명은 보지 않는다 — 모양만). 아니면 null. */
function jwtPayload(key) {
  const p = String(key).split('.');
  if (p.length !== 3) return null;
  try { return JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
}

/** 주소·키 → 걸린 이유 목록(빈 배열 = 통과). 이유 문구에 키 값을 싣지 않는다. */
export function targetProblems({ url, anonKey, fake = false }) {
  const out = [];
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  if (!u) out.push('주소가 없습니다(MSGR2_TRIAL_URL)');
  else if (u === QBWR_URL) { /* 통과 */ } else if (fake && LOCAL.test(u)) { /* 가짜 하네스 */ } else out.push(`허용하지 않은 주소입니다 — qbwr(${QBWR_URL})만 씁니다${fake ? ' (가짜 모드는 127.0.0.1·localhost도)' : ''}`);
  const k = String(anonKey ?? '').trim();
  if (!k) out.push('공개 키가 없습니다(MSGR2_TRIAL_ANON_KEY)');
  else if (/^sb_secret_/.test(k)) out.push('비밀 키(sb_secret_)입니다 — 공개 키(anon·publishable)만 씁니다');
  else if (/^sb_publishable_/.test(k)) { /* 새 공개 키 — ref가 없어 주소로만 판정 */ } else {
    const p = jwtPayload(k);
    if (p) {
      if (p.role !== 'anon') out.push(`공개 키가 아닙니다(role=${String(p.role ?? '?')}) — anon 키만 씁니다`);
      if (u === QBWR_URL && p.ref !== QBWR_REF) out.push('키의 프로젝트(ref)가 qbwr가 아닙니다');
    } else if (!fake) out.push('키 모양을 알 수 없습니다(JWT anon 키 또는 sb_publishable_만)');
  }
  return out;
}

/** 체크아웃 폴더들에 .env 파일이 있으면 그 경로(이름만). .env.example은 값이 없는 견본이라 둔다. */
export function envFilesIn(dirs) {
  const out = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/^\.env/.test(f) && f !== '.env.example') out.push(join(d, f));
  }
  return out;
}

/** 본체 데이터 폴더 → 걸린 이유(빈 배열 = 통과). 이름에 msgr2-trial이 있어야 하고, 체크아웃 안 workspaces는 안 된다. */
export function rootProblems(root, checkout) {
  const r = resolve(String(root ?? ''));
  const out = [];
  if (!root) out.push('데이터 폴더가 없습니다(ARGO_ROOT)');
  else if (!/msgr2-trial/.test(r)) out.push('데이터 폴더 이름에 msgr2-trial이 들어가야 합니다(실제 workspaces를 쓰지 않게)');
  if (root && checkout && (r === resolve(checkout, 'workspaces') || r.startsWith(resolve(checkout, 'workspaces') + sep))) out.push('체크아웃의 workspaces 폴더는 쓰지 않습니다');
  return out;
}

/** KEY=VALUE 파일 읽기(따옴표 벗김, # 주석). 없으면 {}. */
export function readEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// CLI: node scripts/msgr2-trial-guard.mjs --checkout <폴더> [--root <폴더>] [--fake] [--env-file <파일>]
// 통과하면 표준 출력으로 셸 변수 두 줄(MSGR2_TRIAL_URL·MSGR2_TRIAL_ANON_KEY)을 낸다 — 셸이 eval로 받는다(화면에는 찍지 않는다). 걸리면 이유를 표준 오류로, exit 5.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const fake = process.argv.includes('--fake');
  const checkout = arg('--checkout');
  const file = readEnvFile(arg('--env-file') ?? join(process.env.HOME ?? '', '.argo', 'msgr2-trial.env'));
  const url = fake ? (process.env.MSGR2_TRIAL_URL || 'http://127.0.0.1:5297') : (process.env.MSGR2_TRIAL_URL || file.MSGR2_TRIAL_URL);
  const anonKey = fake ? (process.env.MSGR2_TRIAL_ANON_KEY || 'fake-anon-key') : (process.env.MSGR2_TRIAL_ANON_KEY || file.MSGR2_TRIAL_ANON_KEY);
  const problems = [...targetProblems({ url, anonKey, fake })];
  if (checkout) for (const f of envFilesIn([checkout, join(checkout, 'apps', 'messenger')])) problems.push(`.env 파일이 있습니다: ${f} — 운영 값이 섞일 수 있어 .env가 없는 체크아웃(예: 체험용 워크트리)에서 실행하세요`);
  const root = arg('--root');
  if (root !== null && process.argv.includes('--root')) problems.push(...rootProblems(root, checkout));
  if (problems.length) { for (const p of problems) console.error(`[msgr2-trial] 멈춤: ${p}`); process.exit(5); }
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  process.stdout.write(`MSGR2_TRIAL_URL=${q(String(url).trim().replace(/\/+$/, ''))}\nMSGR2_TRIAL_ANON_KEY=${q(String(anonKey).trim())}\n`);
}
