#!/usr/bin/env node
// 피드백 쪽지 운영 알림(2026-10-28) — 운영 기기(맥 one 상주)에서 주기 실행해 public.feedback의 새 행을
// 운영자가 읽을 요약으로 낸다. 피드백 저장 경로(app/api/feedback/route.js)는 사용자 PC의 본체에서 돌고,
// GitHub 이슈 사본은 ARGO_GITHUB_ISSUE_TOKEN이 있는 기기에서만 생겨 설치본 제보가 운영진에게 안 닿았다
// (유료 사용자 쪽지 2026-10-27 21:20 KST를 하루 넘게 못 봄). 그래서 알림은 표를 읽는 쪽에서 만든다.
//
// 읽기만 한다 — DB 쓰기·RPC 없음. 요청: 실행 1회당 feedback select 1회, 새 행이 있을 때만 entitlements select 1회 더.
// 새 행이 없으면 상태 파일도 출력 파일도 쓰지 않는다(유휴 쓰기 0).
// 요약에 이메일은 넣지 않는다(위치만 "feedback 표 id=<id>"). 메시지 속 토큰·키·접속 문자열·이메일은 가린다.
//
// 환경변수(이름만 — 값은 출력·기록하지 않는다): SUPABASE_URL 또는 NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// 사용: node scripts/feedback-digest.mjs [--state <파일>] [--out <파일>] [--limit <1-200>] [--since <ISO 시각>]
//   --state  커서 파일(기본 ~/.argo-ops/feedback-digest.json) — { created_at, id } 마지막으로 본 행
//   --out    요약을 이 파일에 덧붙인다(없으면 stdout)
//   --since  상태 파일이 없을 때 이 시각 이후부터 본다(기본 7일 전). 상태 파일이 있으면 무시
// 종료 코드: 0 정상(새 행 없음 포함), 1 조회·출력 실패(커서 그대로 — 다음 주기에 다시 본다), 2 설정 오류
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const DEFAULT_STATE = join(homedir(), '.argo-ops', 'feedback-digest.json');
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;
// created_at은 사용자 insert가 직접 넣을 수 있다(feedback_insert 정책은 user_id만 묶는다). 2999년 행 하나가 커서가 되면
// 그 뒤 쪽지를 영영 못 보므로, 조회는 지금+5분까지만 하고 지금보다 뒤 시각의 행으로는 커서를 옮기지 않는다(PR #1185 검수).
const FUTURE_SLACK_MS = 5 * 60_000;
const MSG_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 메시지 속 비밀 값 가리기 — 자르기 전에 전체에 적용한다(경계에서 잘린 토큰 조각이 남지 않게). */
export function redactSecrets(s) {
  return String(s ?? '')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[가림:접속문자열]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [가림]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){0,2}/g, '[가림:JWT]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[가림:개인키]')
    .replace(/\b(?:sk-|re_|sb_secret_|ghp_|github_pat_|whsec_)[A-Za-z0-9_-]{8,}/g, '[가림:키]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[가림:이메일]');
}

/** 터미널·로그에 그대로 흘러가므로 제어 문자(ANSI 이스케이프 등)는 줄바꿈·탭만 남기고 뺀다. */
const stripControl = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

export function kst(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '시각 불명';
  const p = Object.fromEntries(new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}(${p.weekday}) ${p.hour}:${p.minute} KST`;
}

/** entitlements 행 → 요금제 표시. 행이 없으면 null(요약에서 생략). 체험·조직 자격은 보지 않는다(entitlements 기준). */
export function planLabel(ent, now = Date.now()) {
  if (!ent) return null;
  if (ent.granted === true) return 'pro(부여)';
  if (ent.plan === 'pro') {
    if (!ent.ends_at) return 'pro';
    const end = new Date(ent.ends_at).getTime();
    return end > now ? `pro(종료 예정 ${kst(ent.ends_at)})` : `pro 종료됨(${kst(ent.ends_at)})`;
  }
  return typeof ent.plan === 'string' ? ent.plan.replace(/[^a-z_-]/gi, '').slice(0, 20) || null : null;
}

/** 한 행의 운영자용 요약. 이메일 칸은 읽지도 않는다(select에서 뺐다). */
export function summarize(row, ent, now = Date.now()) {
  const ref = typeof row.meta?.ref === 'string' && /^[0-9a-f]{1,16}$/i.test(row.meta.ref) ? row.meta.ref : '없음';
  const uid = typeof row.user_id === 'string' ? row.user_id.replace(/[^0-9a-f-]/gi, '').slice(0, 8) || '없음' : '없음';
  const plan = planLabel(ent, now);
  const future = new Date(row.created_at).getTime() > now;
  const head = [`[Argo 피드백] ${kst(row.created_at)}${future ? ' ⚠ 지금보다 뒤 시각(created_at 확인)' : ''}`,`ref ${ref}`, `사용자 ${uid}`, ...(plan ? [`요금제 ${plan}`] : [])].join(' · ');
  const body = redactSecrets(stripControl(String(row.message ?? ''))).trim(); // 제어 문자를 먼저 빼야 토큰 사이에 끼운 문자로 가림을 피하지 못한다
  const cut = body.length > MSG_MAX ? `${body.slice(0, MSG_MAX)}… (${body.length}자 중 ${MSG_MAX}자)` : body;
  const id = UUID.test(String(row.id)) ? row.id : '?';
  return `${head}\n위치: feedback 표 id=${id}\n내용: ${cut.replace(/\n/g, '\n      ')}\n`;
}

/** 상태 파일 읽기. 없으면 { cursor: null }, 손상되면 { corrupt: true }. 값은 엄격히 검사한다 — 조회 필터에 들어간다. */
export function readState(path) {
  if (!existsSync(path)) return { cursor: null };
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const t = new Date(j?.created_at);
    if (typeof j?.created_at !== 'string' || Number.isNaN(t.getTime()) || !/^[0-9T:.+\- Z]+$/.test(j.created_at)) throw new Error('created_at');
    if (typeof j?.id !== 'string' || !UUID.test(j.id)) throw new Error('id');
    return { cursor: { created_at: j.created_at, id: j.id } };
  } catch {
    return { corrupt: true };
  }
}

function writeStateAtomic(path, cursor) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ ...cursor, saved_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function feedbackQuery(cursor, sinceIso, limit, capIso) {
  const q = new URLSearchParams();
  q.set('select', 'id,user_id,message,meta,created_at'); // email은 고르지 않는다
  if (cursor) {
    // (created_at, id) 키셋 — 같은 시각 행이 여럿이어도 빠지거나 겹치지 않는다
    q.set('or', `(created_at.gt."${cursor.created_at}",and(created_at.eq."${cursor.created_at}",id.gt.${cursor.id}))`);
  } else {
    q.append('created_at', `gt.${sinceIso}`);
  }
  q.append('created_at', `lte.${capIso}`); // 상한 — 미래로 위조한 created_at 행은 고르지 않는다(같은 칸 조건 반복은 PostgREST에서 AND)
  q.set('order', 'created_at.asc,id.asc');
  q.set('limit', String(limit));
  return q.toString();
}

async function getJson(fetchImpl, url, key) {
  const r = await fetchImpl(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (!r.ok) {
    let code = '';
    try { code = (await r.json())?.code ?? ''; } catch { /* 본문 없음 */ }
    throw new Error(`HTTP ${r.status}${code ? ` ${code}` : ''}`);
  }
  return r.json();
}

/**
 * 한 번 실행. 반환: { status, count, more, lines }. 출력이 성공한 뒤에만 커서를 옮긴다.
 * write(text)는 요약 출력(기본 stdout), warn(text)은 진단(기본 stderr) — 둘 다 비밀 값을 받지 않는다.
 */
export async function runDigest({
  url, key, statePath = DEFAULT_STATE, out = null, limit = 50, since = null,
  fetchImpl = globalThis.fetch, now = Date.now(),
  // stdout이 파이프면 쓰기가 비동기다 — 다 넘어간 뒤(또는 EPIPE)에야 커서를 옮기도록 콜백까지 기다린다(분리 검수 Important)
  write = (s) => new Promise((res, rej) => { process.stdout.write(s, (e) => (e ? rej(e) : res())); }),
  warn = (s) => process.stderr.write(s),
} = {}) {
  if (!url || !key) {
    warn('설정 오류: SUPABASE_URL(또는 NEXT_PUBLIC_SUPABASE_URL)과 SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다\n');
    return { status: 2, count: 0 };
  }
  const lim = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  const st = readState(statePath);
  let cursor = st.cursor ?? null;
  // 고치기 전 판이 이미 미래 시각을 커서로 저장했을 수 있다 — 그런 커서는 손상으로 보고 같은 복구 경로를 탄다
  if (cursor && new Date(cursor.created_at).getTime() > now + FUTURE_SLACK_MS) { st.corrupt = true; cursor = null; }
  if (st.corrupt) {
    // 손상된 커서는 지우지 않고 옆으로 옮긴다(원인 확인용). 되돌아보기 창부터 다시 본다 — 놓치는 것보다 겹치는 쪽이 안전하다.
    const aside = `${statePath}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    try { renameSync(statePath, aside); } catch (e) {
      warn(`커서 파일이 손상됐고 옮기지도 못했습니다(${e.code ?? 'error'}) — 실행하지 않습니다: ${statePath}\n`);
      return { status: 2, count: 0 };
    }
    warn(`커서 파일 손상 — ${aside}로 옮기고 되돌아보기 창부터 다시 봅니다(앞서 보낸 알림이 겹칠 수 있음)\n`);
    cursor = null;
  }
  let sinceIso = new Date(now - LOOKBACK_MS).toISOString();
  if (!cursor && since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) { warn('설정 오류: --since 시각을 읽지 못했습니다\n'); return { status: 2, count: 0 }; }
    sinceIso = d.toISOString();
  }

  const base = url.replace(/\/+$/, '');
  let rows;
  try {
    rows = await getJson(fetchImpl, `${base}/rest/v1/feedback?${feedbackQuery(cursor, sinceIso, lim, new Date(now + FUTURE_SLACK_MS).toISOString())}`, key);
  } catch (e) {
    warn(`feedback 조회 실패: ${e.message} — 커서 그대로, 다음 주기에 다시 봅니다\n`);
    return { status: 1, count: 0 };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { status: 0, count: 0 }; // 유휴: 쓰기 0

  // 요금제(있으면) — 실패해도 알림은 낸다(요금제만 생략)
  const ents = new Map();
  const uids = [...new Set(rows.map((r) => r.user_id).filter((u) => typeof u === 'string' && UUID.test(u)))];
  if (uids.length) {
    try {
      const q = new URLSearchParams({ select: 'user_id,plan,ends_at,granted', user_id: `in.(${uids.join(',')})` });
      const list = await getJson(fetchImpl, `${base}/rest/v1/entitlements?${q}`, key);
      for (const e of Array.isArray(list) ? list : []) ents.set(e.user_id, e);
    } catch (e) {
      warn(`요금제 조회 실패(${e.message}) — 요금제 없이 알립니다\n`);
    }
  }

  const more = rows.length >= lim;
  const lines = rows.map((r) => summarize(r, ents.get(r.user_id), now));
  const text = `${lines.join('\n')}${more ? `\n(한 번에 ${lim}건까지 — 나머지는 다음 실행에 이어서 나옵니다)\n` : ''}\n`;
  try {
    if (out) { mkdirSync(dirname(out), { recursive: true }); appendFileSync(out, text, { mode: 0o600 }); } else await write(text);
  } catch (e) {
    warn(`요약 출력 실패(${e.code ?? e.message}) — 커서 그대로, 다음 주기에 다시 냅니다\n`);
    return { status: 1, count: 0 };
  }
  // 커서는 지금 이하 시각의 마지막 행까지만 — 지금~지금+5분(시계 차이) 행은 낸 뒤 다음 실행에 한 번 더 나올 수 있다(놓치지 않는 쪽)
  const settled = rows.filter((r) => new Date(r.created_at).getTime() <= now);
  const last = settled[settled.length - 1];
  if (!last) {
    warn('이번 행이 모두 지금보다 뒤 시각이라 커서를 옮기지 않았습니다\n');
  } else if (typeof last?.created_at === 'string' && UUID.test(String(last.id))) {
    try { writeStateAtomic(statePath, { created_at: last.created_at, id: last.id }); } catch (e) {
      warn(`커서 저장 실패(${e.code ?? e.message}): ${statePath} — 다음 실행에서 같은 요약이 다시 나옵니다. 폴더 권한·디스크를 확인하세요\n`);
      return { status: 1, count: rows.length, more, lines };
    }
  } else {
    warn('마지막 행의 created_at·id가 비정상이라 커서를 옮기지 않았습니다\n');
  }
  return { status: 0, count: rows.length, more, lines };
}

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} 값이 없습니다`); i += 1; return v; };
    if (a === '--state') o.statePath = val();
    else if (a === '--out') o.out = val();
    else if (a === '--limit') o.limit = val();
    else if (a === '--since') o.since = val();
    else if (a === '--notion') throw new Error('--notion은 아직 없습니다(저장소에 노션 연동 코드가 없어 맥 one 설정 때 결정)');
    else throw new Error(`모르는 인자: ${a}`);
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`설정 오류: ${e.message}\n`); process.exit(2); }
  const r = await runDigest({
    ...opts,
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  process.exitCode = r.status; // exit()로 끊으면 파이프에 남은 출력이 잘린다
}
