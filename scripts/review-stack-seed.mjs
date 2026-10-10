#!/usr/bin/env node
// 검수 스택 예시 데이터 — scripts/review-stack.sh가 부른다. 로컬 Supabase와 로컬 본체(:3500)에만 쓴다.
// 하위 명령:
//   seed          시험 계정·예시 회사·에이전트 4명·하트비트·일정을 넣는다(이미 있으면 빠진 것만)
//   event <분> [제목]  지금부터 <분> 뒤에 시작하는 개인 일정 하나(하트비트 '곧 시작' 알림 확인용)
//   login         본체 로그인 링크(한 번 쓰는 링크)를 만들어 기본 브라우저로 연다 — 주소는 파일(600)에만 남긴다
//   check         운영 주소로 가는 설정이 아닌지 확인(실행 전 관문)
// 필요한 환경변수(review-stack.sh가 `supabase status -o env`에서 읽어 넘긴다 — 값은 출력하지 않는다):
//   REVIEW_SB_URL · REVIEW_SB_ANON · REVIEW_SB_SERVICE · REVIEW_DB_CONTAINER · REVIEW_BODY_URL · REVIEW_ARGO_ROOT · REVIEW_SECRETS
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const env = process.env;
const need = (k) => { const v = env[k]; if (!v) { console.error(`[review] 환경변수 ${k}가 없습니다`); process.exit(2); } return v; };
const SB = need('REVIEW_SB_URL');
const ANON = need('REVIEW_SB_ANON');
const SERVICE = need('REVIEW_SB_SERVICE');
const DB = need('REVIEW_DB_CONTAINER');
const BODY = need('REVIEW_BODY_URL');
const ROOT = need('REVIEW_ARGO_ROOT');
const SECRETS = need('REVIEW_SECRETS');
const EMAIL = env.REVIEW_EMAIL || 'yugeon-review@argo.test';
const COMPANY = env.REVIEW_COMPANY || '검수 상사';

// 운영으로 새지 않게 — 로컬 주소가 아니면 아무것도 하지 않는다.
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
for (const [k, v] of [['REVIEW_SB_URL', SB], ['REVIEW_BODY_URL', BODY]]) {
  if (!LOCAL.test(v)) { console.error(`[review] ${k}가 로컬 주소가 아닙니다 — 중단`); process.exit(3); }
}

const log = (...a) => console.log('[review]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 비밀값 파일(600) — 시험 계정 비밀번호. 출력하지 않는다. ── */
function readSecrets() {
  try { return Object.fromEntries(readFileSync(SECRETS, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); }
  catch { return {}; }
}
function writeSecrets(obj) {
  mkdirSync(dirname(SECRETS), { recursive: true });
  writeFileSync(SECRETS, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
}

async function sb(path, { method = 'GET', key = SERVICE, body, headers = {} } = {}) {
  const res = await fetch(`${SB}${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* 본문이 JSON이 아님 */ }
  return { ok: res.ok, status: res.status, json };
}

function sql(text) {
  const r = spawnSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: text, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`SQL 실패: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* ── 시험 계정 ── */
async function ensureUser() {
  const s = readSecrets();
  const password = s.REVIEW_PASSWORD || randomBytes(18).toString('base64url');
  const found = await sb(`/auth/v1/admin/users?per_page=200`);
  const user = (found.json?.users ?? []).find((u) => u.email === EMAIL);
  let id = user?.id;
  if (!id) {
    const r = await sb('/auth/v1/admin/users', { method: 'POST', body: { email: EMAIL, password, email_confirm: true, user_metadata: { full_name: '유건(검수)' } } });
    if (!r.ok) throw new Error(`시험 계정 만들기 실패 ${r.status}`);
    id = r.json.id;
    log('시험 계정을 만들었습니다:', EMAIL);
  } else if (!s.REVIEW_PASSWORD) {
    const r = await sb(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: { password } });
    if (!r.ok) throw new Error(`시험 계정 비밀번호 설정 실패 ${r.status}`);
  }
  writeSecrets({ REVIEW_EMAIL: EMAIL, REVIEW_PASSWORD: password, REVIEW_USER_ID: id });
  return { id, password };
}

async function passwordGrant(password) {
  const r = await sb('/auth/v1/token?grant_type=password', { method: 'POST', key: ANON, body: { email: EMAIL, password } });
  if (!r.ok || !r.json?.access_token) throw new Error(`시험 계정 로그인 실패 ${r.status}`);
  return r.json;
}

/* ── DB 예시 데이터(서비스 계정 = postgres로 직접) ── */
function seedDb(uid) {
  sql(`
    -- 운영에서 손으로 만든 버킷(마이그레이션에 없음): companies = 본체 동기화·리스, msgr = 메신저 첨부
    insert into storage.buckets (id, name, public) values ('companies', 'companies', false), ('msgr', 'msgr', false) on conflict (id) do nothing;
    insert into public.entitlements (user_id, plan) values (${lit(uid)}, 'pro')
      on conflict (user_id) do update set plan = 'pro', updated_at = now();
    insert into public.msgr_profiles (user_id, display_name, handle) values (${lit(uid)}, '유건(검수)', 'yugeon_review')
      on conflict (user_id) do nothing;
  `);
}

/** 일정 — 시각은 지금 기준(KST). 이미 같은 출처 id가 있으면 건너뛴다(source = 'review-seed'). */
function seedEvents(uid) {
  const now = Date.now();
  const kstDay = (offsetDays, hh, mm = 0) => {
    const d = new Date(now + 9 * 3600_000); // KST 날짜
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate() + offsetDays;
    return new Date(Date.UTC(y, m, day, hh - 9, mm)).toISOString();
  };
  const rows = [
    ['soon', '디자인 검수 미팅', '회의실 A', new Date(now + 20 * 60_000).toISOString(), new Date(now + 50 * 60_000).toISOString()],
    ['later', '고객사 통화 — 견적 회신', '', new Date(now + 3 * 3600_000).toISOString(), new Date(now + 3.5 * 3600_000).toISOString()],
    ['tmr-am', '주간 회의', '본사 3층', kstDay(1, 10), kstDay(1, 11)],
    ['tmr-pm', '메신저 0.1.101 발행 검수', '', kstDay(1, 15), kstDay(1, 16)],
  ];
  const stamp = new Date(now).toISOString().slice(0, 10);
  let added = 0;
  for (const [tag, title, loc, from, to] of rows) {
    added += sql(`insert into public.office_events (id, org_id, owner, visibility, title, location, starts_at, ends_at, source, source_id)
         values (${lit(randomUUID())}, null, ${lit(uid)}, 'private', ${lit(title)}, ${lit(loc)}, ${lit(from)}, ${lit(to)}, 'review-seed', ${lit(`${stamp}:${tag}`)})
         on conflict (source, source_id) do nothing returning 1;`) ? 1 : 0;
  }
  log(added ? `일정 ${added}개를 넣었습니다(오늘·내일, 가장 이른 것은 20분 뒤 시작)` : '오늘 넣은 예시 일정이 이미 있습니다 — 곧 시작하는 일정은 event 명령으로');
}

function addEvent(uid, minutes, title) {
  const now = Date.now();
  const from = new Date(now + minutes * 60_000).toISOString();
  const to = new Date(now + (minutes + 30) * 60_000).toISOString();
  sql(`insert into public.office_events (id, org_id, owner, visibility, title, location, starts_at, ends_at)
       values (${lit(randomUUID())}, null, ${lit(uid)}, 'private', ${lit(title)}, '', ${lit(from)}, ${lit(to)});`);
  log(`일정을 넣었습니다: "${title}" — ${minutes}분 뒤 시작`);
}

/* ── 본체 API(루프백, 기기 쿠키) ── */
const COOKIE = 'argo-device=1; argo-lang=ko';
async function body(path, { method = 'GET', json } = {}) {
  const res = await fetch(`${BODY}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: COOKIE }, body: json ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let out = null; try { out = text ? JSON.parse(text) : null; } catch { /* HTML 등 */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${String(out?.error ?? text).slice(0, 200)}`);
  return out;
}
async function waitBody() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${BODY}/api/ping`); if (r.ok) return; } catch { /* 아직 안 뜸 */ }
    await sleep(1000);
  }
  throw new Error('본체 서버가 2분 안에 응답하지 않았습니다');
}

const AGENTS = [
  ['하람', 'haram-secretary', '비서·일정 담당', '운영', ['일정·할 일 정리와 알림', '회의 준비 자료 요약', '하루 마감 정리'], ['일정은 시간·장소·준비물 순서로 짧게 알린다', '바뀐 것이 없으면 다시 말하지 않는다', '외부 발송·결제는 결재를 먼저 올린다'], '짧고 정중하게.'],
  ['도윤', 'doyun-researcher', '리서처', '리서치', ['시장·경쟁사 조사', '고객 리뷰·반응 분석', '사실 확인과 출처 표기'], ['조사 결과는 출처와 함께 불릿으로 정리한다', '확실/추정을 구분해 표기한다'], '사실 중심으로 담백하게.'],
  ['세온', 'seon-marketer', '퍼포먼스 마케터', '마케팅', ['광고 카피와 랜딩 메시지', '채널별 규격·정책', 'A/B 테스트 설계'], ['카피는 2~3안과 선택 이유를 붙인다', '집행·게시는 결재를 먼저 올린다'], '실행 중심으로 명확하게.'],
  ['지호', 'jiho-ops', '운영 매니저', '운영', ['업무 진행 현황 정리', '거래처 응대 초안', '반복 업무 자동화 제안'], ['할 일은 담당·기한·다음 행동으로 적는다', '막힌 일은 바로 알린다'], '차분하고 구체적으로.'],
];
const card = ([name, slug, role, team, expertise, style, tone]) => `---\nteam: ${team}\nname: ${name}\nslug: ${slug}\nrole: ${role}\n---\n\n# ${name} — ${role}\n\n## 전문성\n${expertise.map((e) => `- ${e}`).join('\n')}\n\n## 일하는 방식\n${style.map((s) => `- ${s}`).join('\n')}\n\n## 톤\n${tone}\n`;

async function seedBody(uid, password) {
  await waitBody();
  const tok = await passwordGrant(password);
  // 기기 세션 연결 — 본체 기기 파일(ARGO_ROOT/.device-session.json)에 이 계정 세션을 둔다(앱 로그인과 같은 경로)
  const linked = await fetch(`${BODY}/api/device/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: tok.access_token, refresh_token: tok.refresh_token }) });
  if (!linked.ok) throw new Error(`기기 연결 실패 ${linked.status}`);
  log('본체 기기 세션을 시험 계정으로 연결했습니다');

  const { companies = [] } = await body('/api/companies');
  let ws = companies.find((c) => c.name === COMPANY)?.id;
  if (!ws) {
    ws = (await body('/api/companies', { method: 'POST', json: { name: COMPANY, owner: '유건', lang: 'ko' } })).company.id;
    log('예시 회사를 만들었습니다:', COMPANY, `(${ws})`);
  }
  const dir = join(ROOT, ws, 'agents');
  mkdirSync(dir, { recursive: true });
  const have = new Set(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  for (const a of AGENTS) if (!have.has(a[1])) writeFileSync(join(dir, `${a[1]}.md`), card(a));
  log(`에이전트 ${AGENTS.length}명:`, AGENTS.map((a) => `${a[0]}(${a[2]})`).join(', '));

  // 러너 — 이 맥에 로그인된 Claude Code·Codex를 그대로 쓴다("이 컴퓨터 로그인 사용"). 자격 파일은 복사하지 않는다(마커만 저장).
  for (const runner of ['claude', 'codex']) {
    try { await body(`/api/companies/${ws}/keys`, { method: 'PUT', json: { runner, type: 'host' } }); log(`러너 연결: ${runner}(이 컴퓨터 로그인)`); }
    catch (e) { log(`러너 연결 실패: ${runner} — ${e.message}`); }
  }

  // 하트비트는 기본으로 켜지 않는다 — 검수에서 화면으로 켜 보는 것부터 확인한다. REVIEW_HEARTBEAT=1이면 하람으로 켜 둔다(조용한 시간에도 일정 알림).
  if (env.REVIEW_HEARTBEAT === '1') {
    const hb = await body(`/api/companies/${ws}/assistant`, { method: 'PUT', json: {
      enabled: true, agent: 'haram-secretary', leadMinutes: 30, tz: 'Asia/Seoul', quiet: { from: '23:00', to: '08:00', calendarAlerts: true },
    } }).catch((e) => ({ error: e.message }));
    log(hb?.error ? `하트비트 켜기 실패 — ${hb.error}` : '하트비트를 켰습니다(하람, 30분 전 알림)');
  }
  return ws;
}

async function login() {
  const r = await sb('/auth/v1/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email: EMAIL } });
  const hash = r.json?.hashed_token ?? r.json?.properties?.hashed_token;
  if (!r.ok || !hash) throw new Error(`로그인 링크 만들기 실패 ${r.status}`);
  const url = `${BODY}/auth/confirm?token_hash=${encodeURIComponent(hash)}&type=magiclink`;
  const file = join(dirname(SECRETS), 'login-link.txt');
  writeFileSync(file, `${url}\n`, { mode: 0o600 }); chmodSync(file, 0o600);
  if (env.REVIEW_NO_OPEN !== '1') execFileSync('open', [url]);
  log(`본체 로그인 링크를 ${env.REVIEW_NO_OPEN === '1' ? '만들었습니다' : '브라우저로 열었습니다'}(한 번만 쓰임, 파일: ${file})`);
}

const [cmd = 'seed', ...rest] = process.argv.slice(2);
try {
  if (cmd === 'check') { log('설정 확인 통과(로컬 주소)'); }
  else if (cmd === 'seed') {
    const { id, password } = await ensureUser();
    seedDb(id);
    seedEvents(id);
    await seedBody(id, password);
    log(`시험 계정 비밀번호 파일: ${SECRETS}`);
  } else if (cmd === 'event') {
    const s = readSecrets();
    if (!s.REVIEW_USER_ID) throw new Error('시험 계정이 아직 없습니다 — 먼저 up 또는 reset');
    addEvent(s.REVIEW_USER_ID, Math.max(1, Number(rest[0]) || 10), rest.slice(1).join(' ') || '하트비트 확인용 일정');
  } else if (cmd === 'login') { await login(); }
  else { console.error('usage: review-stack-seed.mjs seed|event <분> [제목]|login|check'); process.exit(2); }
} catch (e) { console.error('[review] 실패:', e.message); process.exit(1); }
