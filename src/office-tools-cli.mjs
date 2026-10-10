// argo office <영역> <동작> — Claude Code·Codex·아르고 등 바깥 에이전트가 아르고 오피스를 읽고 쓰는 CLI·MCP의 핵심(유건 10/10 "CRUD CLI부터").
//   argo office work tasks --status doing            argo office work task_add --title "견적 회신" --due-on 2026-10-12
//   argo office deals customers --q 한빛               argo office calendar list --from 2026-10-10
//   argo office orgs                                  argo office tools [--json]           argo office mcp(표준 입출력 MCP 서버)
// 도구 정의·처리기는 아르고 본체 에이전트와 같은 것(gateway/office-tools.mjs) — 권한은 서버 함수가, 바깥 글 경계·주인 일만 바꾸기 같은 에이전트 규칙은 처리기가 그대로 지킨다.
// 문맥 = cliContext(주인이 자기 터미널에서 부른다 = 주인 혼자 보는 자리). 인증 = 데이터 폴더(ARGO_ROOT)의 기기 세션 하나를 여러 클라이언트가 같이 쓴다
// (회전은 getFreshDeviceSession의 프로세스 간 잠금으로만). 되돌릴 수 없는 동작(일정 영구 삭제)은 CLI·MCP에 열지 않는다(유건 10/10 결정 3 — 메일은 원래 초안까지).
// 부하: 명령 한 번 = 처리기가 부르는 RPC 1~3건(+ 조직 이름으로 고르면 조직 목록 1건). 주기 호출 없음.
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { officeToolSpecs } from './gateway/office-tools.mjs';
import { cliContext } from './gateway/office-audience.mjs';
import { workDeps } from './gateway/office-work.mjs';
import { dealsDeps } from './gateway/office-deals.mjs';
import { calendarDeps } from './gateway/office-calendar.mjs';
import { companyDeps } from './gateway/office-company.mjs';
import { filesDeps } from './gateway/office-files.mjs';
import { mailDeps } from './gateway/office-mail.mjs';
import { briefingDeps } from './gateway/office-briefing.mjs';
import { markedAncestor } from './agent-peer.mjs';

/** CLI 영역 이름 → 도구 이름 */
export const AREAS = { work: 'office_work', deals: 'office_deals', calendar: 'calendar', company: 'office', files: 'office_files', mail: 'office_mail', briefing: 'office_briefing' };
/** 바깥(CLI·MCP)에 열지 않는 동작 — 되돌릴 수 없다(일정 delete = 행 삭제, 휴지통 없음). 아르고 본체 에이전트에는 그대로 있다 */
export const BLOCKED = { calendar: ['delete'] };
/** 조직 없이(개인 공간) 쓰는 도구 — 나머지는 조직이 있어야 한다 */
export const PERSONAL = new Set(['calendar', 'office_mail', 'office_briefing']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inner = (s) => { let t = s; while (t?.def && ['optional', 'default', 'nullable'].includes(t.def.type)) t = t.def.innerType; return t; };
const typeOf = (s) => inner(s)?.def?.type ?? 'string';
/** 도구 정의에서 바깥에 열지 않는 동작을 뺀 것 — 인자 형식의 action 목록에서도 빠진다(에이전트가 시도하지 않게) */
export function cliSpecs(lang = 'ko') {
  return officeToolSpecs(lang).map((spec) => {
    const blocked = BLOCKED[spec.name] ?? [];
    const actions = inner(spec.shape.action).options.filter((x) => !blocked.includes(x));
    const note = lang === 'en' ? `\n[argo office CLI·MCP] Called by the signed-in owner from their own terminal (owner-only view). The org comes from the org argument or the default org; without one, only the personal space.${blocked.length ? ` Not available here: ${blocked.join(', ')} (cannot be undone — do it in Argo Office).` : ''}`
      : `\n[argo office CLI·MCP] 로그인한 주인이 자기 터미널에서 부른다(주인 혼자 보는 자리). 조직은 org 인자나 기본 조직, 없으면 개인 공간만.${blocked.length ? ` 여기서는 열지 않음: ${blocked.join(', ')}(되돌릴 수 없음 — 아르고 오피스 화면에서).` : ''}`;
    return { ...spec, description: spec.description + note, actions, blocked, shape: { ...spec.shape, action: z.enum(actions) } };
  });
}

/** --key value · --key=value · --flag(불리언) → 인자. key는 kebab-case도 받는다(due-on → due_on). 반환 { args, errors } */
export function parseFlags(tokens, shape) {
  const args = {}, errors = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('--')) { errors.push(`unexpected: ${tok}`); continue; }
    const eq = tok.indexOf('=');
    const key = (eq > 0 ? tok.slice(2, eq) : tok.slice(2)).replace(/-/g, '_');
    if (!Object.hasOwn(shape, key) || key === 'action') { errors.push(`unknown option: --${key}`); continue; }
    const type = typeOf(shape[key]);
    let raw = eq > 0 ? tok.slice(eq + 1) : null;
    if (type === 'boolean') { args[key] = raw == null ? true : !/^(false|0|no)$/i.test(raw); continue; }
    if (raw == null) { raw = tokens[i + 1]; if (raw == null || raw.startsWith('--')) { errors.push(`--${key} needs a value`); continue; } i++; } // 다음 옵션을 값으로 삼키지 않는다
    if (type === 'number') { const n = /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN; if (!Number.isFinite(n)) errors.push(`--${key} must be a number`); else args[key] = n; continue; } // 빈 값·0x10 같은 것은 숫자가 아니다
    if (type === 'array' || type === 'object') { try { args[key] = JSON.parse(raw); } catch { errors.push(`--${key} must be JSON`); } continue; }
    args[key] = raw;
  }
  return { args, errors };
}
/** 인자를 그 도구의 형식으로 검사 — 반환 { ok, args } | { ok: false, issues: [문장] } */
export function checkArgs(spec, args) {
  const r = z.object(spec.shape).strict().safeParse(args);
  return r.success ? { ok: true, args: r.data } : { ok: false, issues: r.error.issues.map((x) => `${x.path.join('.') || 'args'}: ${x.message}`) };
}

/* ─── 세션 ─── */
/** 데이터 폴더의 기기 세션으로 처리기들의 세션·토큰·작업 폴더를 묶는다. 반환 { client, uid } | null(로그인 없음). _fresh·_mkClient는 테스트 주입용 */
export async function bindSession(root, { _fresh, _mkClient, cwd = process.cwd() } = {}) {
  const fresh = _fresh ?? (await import('./devicesession.mjs')).getFreshDeviceSession;
  const sess = await fresh({ root, ...(_mkClient ? { _mkClient } : {}) });
  if (!sess?.access_token || !sess.user?.id) return null;
  const mk = _mkClient ?? (await import('@supabase/supabase-js')).createClient;
  const client = mk(sess.url, sess.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${sess.access_token}` } } });
  const c = { client, uid: sess.user.id };
  const session = async () => c;
  for (const d of [workDeps, dealsDeps, calendarDeps, companyDeps, filesDeps, mailDeps, briefingDeps]) d.session = session;
  const jwt = async () => (await fresh({ root }))?.access_token ?? null; // 오피스 서버(메일·드라이브)는 요청 직전 토큰으로
  mailDeps.jwt = jwt; filesDeps.jwt = jwt;
  filesDeps.wsRoot = async () => cwd; filesDeps.workRoots = async () => []; // 문서함에 올릴 파일은 지금 작업 폴더 안에서만(금지 구역은 처리기가 막는다)
  return c;
}

/** 내가 속한 조직(손님 포함) — [{ id, name, slug, role }] */
export async function myOrgs(c) {
  const { data, error } = await c.client.from('msgr_org_members').select('role, org:msgr_orgs(id, name, slug, deleted_at)').eq('user_id', c.uid).is('removed_at', null);
  if (error) throw new Error(error.message);
  return (data ?? []).filter((m) => m.org && !m.org.deleted_at).map((m) => ({ id: m.org.id, name: m.org.name, slug: m.org.slug, role: m.role }));
}
/** --org(uuid·slug·이름) → 조직 id. 비우면 기본 조직(config.json). 반환 { org } | { error } */
export async function resolveOrg(c, want, fallback = null) {
  const w = String(want ?? '').trim();
  if (!w) return { org: fallback };
  if (UUID.test(w)) return { org: w };
  const orgs = await myOrgs(c);
  const hit = orgs.filter((o) => o.slug === w.toLowerCase() || o.name.toLowerCase() === w.toLowerCase());
  if (hit.length === 1) return { org: hit[0].id };
  return { error: hit.length ? `org "${w}" matches several — use its id (argo office orgs)` : `no org "${w}" — see argo office orgs` };
}

/** 아르고 에이전트 턴 안(셸·MCP 자식)인가 — 러너 환경(scrubServerSecrets)이 붙이는 표지. 에이전트는 자기 오피스 도구(방을 누가 보는지 판정)를 쓴다(분리 검수 MEDIUM-1) */
export const inAgentTurn = (env = process.env) => !!env.ARGO_AGENT_TURN;
/** 아르고 에이전트 턴 판정 — 'agent'(자기 env 표지 또는 조상 프로세스 표지) | 'unknown'(판정 실패 — 호출부가 거절, fail-closed) | null(사람).
    자기 env 표지는 셸에서 지울 수 있어 조상(러너 CLI)의 표지를 같이 본다(agent-peer markedAncestor — 방지턱이고 한계는 그 주석). 보안 리뷰(10/10) */
export async function agentTurnState({ env = process.env, _ancestor = markedAncestor } = {}) {
  if (inAgentTurn(env)) return 'agent';
  try { return (await _ancestor()) > 0 ? 'agent' : null; } catch { return 'unknown'; }
}
/** 거절 문장 — 'unknown'은 이유가 다르다(분리 검수 M3: Codex 샌드박스 셸은 /bin/ps를 못 띄워 사람도 여기 걸린다) */
export const agentTurnRefusal = (state, lang = 'ko') => state === 'unknown'
  ? (lang === 'en' ? 'Could not check whether this runs inside an Argo agent turn (ps unavailable — e.g. a sandboxed shell), so it was refused. Connect argo office mcp instead, or run it from a normal terminal.' : '아르고 에이전트 턴 안인지 확인하지 못해 거절했습니다(ps를 실행할 수 없음 — 샌드박스 셸 등). argo office mcp로 붙이거나 일반 터미널에서 실행하세요.')
  : (lang === 'en' ? 'Inside an Argo agent turn — use your own Office tools (office_work, office_deals, calendar…), not the argo office CLI/MCP.' : '아르고 에이전트 턴 안입니다 — argo office CLI·MCP 대신 이 대화의 오피스 도구(office_work·office_deals·calendar 등)를 쓰세요.');
const SECRET_NAME = /^(id_[a-z0-9_]+|.*\.(pem|key|p12|pfx|keychain|keychain-db|kdbx)|credentials(\..*)?|secrets?(\..*)?|.*token.*\.json)$/i;
/** 문서함에 올릴 파일(files attach --path) — 지금 작업 폴더 안의 보통 파일만. 작업 폴더가 홈이거나 그 위면 거절, 경로 어느 자리든 점으로 시작하는 이름(.env·.ssh·.git…)·비밀 파일 이름은 거절,
    심볼릭 링크는 실제 위치로 다시 본다(분리 검수 MEDIUM-2 — 본체 판정은 회사 폴더 전제라 깊은 .env를 막지 못했다). 반환 null(통과) | 거절 문장 */
export async function attachPathRefusal(path, cwd = process.cwd(), home = process.env.HOME || homedir(), lang = 'ko') {
  const no = (ko, en) => (lang === 'en' ? en : ko);
  const base = resolve(cwd), h = resolve(home);
  if (base === h || !relative(base, h).startsWith('..') || base === sep) return no('홈 폴더(또는 그 위)에서는 문서함에 올리지 않습니다 — 올릴 파일이 있는 프로젝트 폴더에서 실행하세요.', 'Not uploading from the home folder (or above) — run it from the project folder that has the file.');
  const inside = (abs) => { const r = relative(base, abs); return r && !r.startsWith('..') && !isAbsolute(r); };
  const bad = (abs) => relative(base, abs).split(/[\\/]/).some((seg) => seg.startsWith('.') || SECRET_NAME.test(seg)) || SECRET_NAME.test(basename(abs));
  const abs = resolve(base, String(path ?? ''));
  if (!inside(abs) || bad(abs)) return no('그 경로는 올리지 않습니다 — 지금 작업 폴더 안의 보통 파일만(점으로 시작하는 폴더·파일과 비밀 파일은 안 됨).', 'That path is not uploaded — only regular files inside the current folder (no dot files/folders or secret files).');
  let real; try { real = await realpath(abs); } catch { return null; } // 없는 파일은 처리기가 알린다
  let realBase; try { realBase = await realpath(base); } catch { realBase = base; }
  const r = relative(realBase, real);
  if (!r || r.startsWith('..') || isAbsolute(r) || r.split(/[\\/]/).some((seg) => seg.startsWith('.') || SECRET_NAME.test(seg))) return no('그 경로는 올리지 않습니다 — 링크가 작업 폴더 밖이나 숨은 파일을 가리킵니다.', 'That path is not uploaded — the link points outside the current folder or to a hidden file.');
  return null;
}

/** 도구 한 번 — 처리기가 돌려준 글(거절·오류도 한 줄 글). source = 쓰기 기록의 출처 세션 이름(업무 현황이 그 세션 카드에 묶는다) */
export async function runTool(spec, args, { c, org = null, sourceName = 'CLI', lang = 'ko', filesCwd = process.cwd() }) {
  if (!org && !PERSONAL.has(spec.name)) return lang === 'en' ? `${spec.name} needs an org — pass --org (argo office orgs) or set a default org.` : `${spec.name}는 조직이 필요합니다 — --org를 주거나(argo office orgs) 기본 조직을 정하세요.`;
  if (spec.name === 'office_files' && args.action === 'attach') { const why = await attachPathRefusal(args.path, filesCwd, undefined, lang); if (why) return why; }
  const ctx = cliContext({ uid: c.uid, orgId: org, source: { kind: 'session', name: sourceName } });
  return spec.run(args, { ctx, crew: null, crewName: sourceName, lang, ownerId: c.uid });
}

const COMMON = ['--org <id|slug|이름>', '--source-name <이름>', '--json', '--lang ko|en'];
function usage(specs, lang) {
  const area = Object.entries(AREAS).map(([k, name]) => `  ${k.padEnd(9)} ${specs.find((s) => s.name === name).actions.join(' · ')}`);
  return [lang === 'en' ? 'Usage: argo office <area> <action> [--option value …]' : '사용법: argo office <영역> <동작> [--옵션 값 …]', ...area,
    `  ${'orgs'.padEnd(9)} ${lang === 'en' ? 'my organizations' : '내 조직 목록'}`, `  ${'tools'.padEnd(9)} ${lang === 'en' ? 'areas, actions and options' : '영역·동작·옵션 목록'}`,
    `  ${'mcp'.padEnd(9)} ${lang === 'en' ? 'MCP server on stdio (Claude Code·Codex)' : 'MCP 서버(표준 입출력, Claude Code·Codex)'}`,
    `${lang === 'en' ? 'Common' : '공통'}: ${COMMON.join(' ')}`, lang === 'en' ? 'Options of one area: argo office <area> --help' : '한 영역의 옵션: argo office <영역> --help'].join('\n');
}
function areaHelp(spec, lang) {
  const opts = Object.entries(spec.shape).filter(([k]) => k !== 'action').map(([k, s]) => {
    const t = inner(s), type = t?.def?.type, choices = type === 'enum' ? ` (${t.options.join('|')})` : type === 'boolean' ? ' (flag)' : type === 'array' ? ' (JSON)' : '';
    return `  --${k.replace(/_/g, '-')}${choices}${s.description ? ` — ${s.description}` : ''}`;
  });
  return [`${spec.name}: ${spec.actions.join(' · ')}${spec.blocked.length ? (lang === 'en' ? ` (not available here: ${spec.blocked.join(', ')})` : ` (여기서는 열지 않음: ${spec.blocked.join(', ')})`) : ''}`, ...opts, '', spec.description].join('\n');
}

/**
 * argo office <영역>|orgs|tools|mcp … — 종료 코드(0 성공, 1 입력·서버 오류, 2 로그인 필요).
 * 처리기의 거절(권한·없는 id 등)도 글로 오므로 0 — 에이전트가 그 글을 읽고 다음을 정한다.
 */
export async function toolsMain(sub, argv, { root, lang = 'ko', out = (s) => console.log(s), err = (s) => console.error(s), cfgOrg = null, needLogin = '', _fresh, _mkClient, _ancestor, cwd } = {}) {
  const pull = (name, flag = false) => { const i = argv.findIndex((x) => x === `--${name}` || x.startsWith(`--${name}=`)); if (i < 0) return undefined; const t = argv[i]; if (flag) { argv.splice(i, 1); return true; } const v = t.includes('=') ? t.slice(t.indexOf('=') + 1) : argv[i + 1]; argv.splice(i, t.includes('=') ? 1 : 2); return v; };
  const hi = argv.indexOf('-h'); if (hi >= 0) argv.splice(hi, 1, '--help');
  const json = !!pull('json', true), help = !!pull('help', true);
  const orgFlag = argv.findIndex((x) => x === '--org');
  if (orgFlag >= 0 && (argv[orgFlag + 1] == null || argv[orgFlag + 1].startsWith('--'))) { err(lang === 'en' ? '--org needs a value (argo office orgs)' : '--org에 조직을 적으세요(argo office orgs)'); return 1; } // 값 없는 --org가 기본 조직으로 새지 않게
  const L = pull('lang') ?? lang, orgWant = pull('org'), sourceName = String(pull('source-name') ?? process.env.ARGO_OFFICE_SOURCE ?? 'CLI').trim().slice(0, 120) || 'CLI';
  const specs = cliSpecs(L);
  if (sub === 'tools') {
    if (json) out(JSON.stringify(Object.entries(AREAS).map(([area, name]) => { const s = specs.find((x) => x.name === name); return { area, tool: name, actions: s.actions, blocked: s.blocked, input: z.toJSONSchema(z.object(s.shape)) }; })));
    else out(usage(specs, L));
    return 0;
  }
  if (sub !== 'tools') { const st = await agentTurnState({ _ancestor }); if (st) { err(agentTurnRefusal(st, L)); return 1; } }
  if (sub === 'mcp' && help) { out(L === 'en' ? 'argo office mcp — MCP server on stdio. Claude Code: claude mcp add argo-office -- node <argo>/bin/argo.mjs office mcp' : 'argo office mcp — 표준 입출력 MCP 서버. Claude Code: claude mcp add argo-office -- node <argo>/bin/argo.mjs office mcp'); return 0; }
  if (sub === 'mcp') return (await import('./office-mcp.mjs')).serveMcp({ root, lang: L, cfgOrg, _fresh, _mkClient, _ancestor });
  const spec = specs.find((s) => s.name === AREAS[sub]);
  if (sub !== 'orgs' && !spec) { err(usage(specs, L)); return 1; }
  if (help) { out(spec ? areaHelp(spec, L) : usage(specs, L)); return 0; }
  if (sub !== 'orgs' && (!argv[0] || argv[0].startsWith('--'))) { err(areaHelp(spec, L)); return 1; } // 동작이 없으면 로그인 전에 사용법
  const c = await bindSession(root, { _fresh, _mkClient, cwd });
  if (!c) { err(needLogin); return 2; }
  if (sub === 'orgs') {
    const orgs = await myOrgs(c).catch((e) => { err(String(e.message ?? e)); return null; });
    if (!orgs) return 1;
    if (json) out(JSON.stringify(orgs.map((o) => ({ ...o, default: o.id === cfgOrg }))));
    else out(orgs.length ? orgs.map((o) => `- ${o.name} (${o.slug}) · ${o.role} · id=${o.id}${o.id === cfgOrg ? ' · 기본' : ''}`).join('\n') : (L === 'en' ? 'No organizations.' : '속한 조직이 없습니다.'));
    return 0;
  }
  const [action, ...rest] = argv;
  if (spec.blocked.includes(action)) { err(L === 'en' ? `${action} is not available from the CLI (it cannot be undone) — do it in Argo Office.` : `${action}는 CLI에서 열지 않습니다(되돌릴 수 없음) — 아르고 오피스 화면에서 하세요.`); return 1; }
  const { args, errors } = parseFlags(rest, spec.shape);
  if (errors.length) { err(`${errors.join('\n')}\n${areaHelp(spec, L)}`); return 1; }
  const checked = checkArgs(spec, { action, ...args });
  if (!checked.ok) { err(checked.issues.join('\n')); return 1; }
  const o = await resolveOrg(c, orgWant, cfgOrg).catch((e) => ({ error: String(e.message ?? e) }));
  if (o.error) { err(o.error); return 1; }
  const text = await runTool(spec, checked.args, { c, org: o.org, sourceName, lang: L, filesCwd: cwd ?? process.cwd() });
  out(json ? JSON.stringify({ area: sub, tool: spec.name, action, org: o.org, text }) : text);
  return 0;
}
