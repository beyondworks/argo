// argo office — 맥 세션(Claude Code 등)이 아르고 오피스 '업무 현황'에 자기 상태와 보류한 일을 남기는 명령(설계 2026-10-08, 유건 확정 "권장안대로").
//   argo office report --org <uuid> --id <세션 uuid> --name <제목> [--project <p>] [--task <uuid>]   → office_session_report
//   argo office hold "<제목>" --reason "<사유>" --source-name <세션 제목> [--org <uuid>]             → office_task_write task.create(status hold)
//   argo office hold --task <uuid> --reason "<사유>" [--org <uuid>]                                  → office_task_write task.status hold(이미 보류면 reason_only — 사유만)
//   argo office tasks [--org <uuid>] [--json]                                                        → office_task_list(끝내지 않은 일)
// 인증은 기기 세션 getFreshDeviceSession({ root })만 쓴다 — 회전은 그 함수의 프로세스 간 잠금 경로로만(직접 refresh 금지: 같은 refresh 토큰을
// 두 곳이 회전하면 GoTrue가 세션 가족째 폐기한다, devicesession.mjs). root = ARGO_ROOT(훅은 ~/.argo/office-hook — 앱·상주·CLI 폴더와 따로).
// 올리는 것: 세션 제목·프로젝트 폴더 이름·마지막 활동·맡은 할 일 id. 대화 내용·프롬프트는 올리지 않는다.
// 부하: 훅은 Stop·UserPromptSubmit·PostToolUse마다 실행되지만 값이 바뀌었거나 4분이 지났을 때만 부른다(shouldReport) — 세션 10개면 분당 약 2.5회.
//   서버도 같은 값·4분 안이면 쓰지 않는다. 이름(custom-title)이 없는 세션은 부르지 않는다(총괄 결정 10/8 — 헤드리스 자동 실행이 하루 200개 넘게 생긴다).
// 이 파일 맨 위는 node 내장만 불러온다 — 훅이 '부르지 않음'을 판정할 때 supabase-js·코어 모듈을 싣지 않게(기기 세션·클라이언트는 쓸 때 불러온다).
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { open, readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const REPORT_EVERY_MS = 4 * 60_000;   // 같은 값이면 4분에 한 번(서버 office_session_report의 쓰기 조건과 같은 값)
export const FAIL_PAUSE_MS = 60_000;         // 실패(로그인 없음·네트워크) 뒤 1분은 다시 부르지 않는다 — 턴마다 3초씩 기다리지 않게
export const DENY_PAUSE_MS = 6 * 3600e3;     // 영구 거절(권한·입력) 뒤에는 보낼 값(조직 포함)이 바뀌거나 6시간이 지날 때까지 부르지 않는다 — 같은 거절을 분마다 되풀이하지 않게(DB 오류 0)
export const STATE_KEEP_MS = 8 * 24 * 3600e3; // 상태 파일 기록 보존 8일(서버 세션 보존과 같다)
/** 다시 불러도 같은 답이 오는 서버 거절 — 네트워크·로그인 실패(1분 쉬기)와 가른다 */
export const PERMANENT_DENY = /session_forbidden|session_input/; // 서버는 200행 상한에서 거절하지 않고 오래된 행을 밀어낸다(session_limit 없음)
// 로그인 안내에 쓰는 명령 — 이 저장소의 bin/argo.mjs를 지금 node로(맥에 설치된 argo가 office가 없는 예전 판일 수 있다, 10/8 실측)
const LOGIN = `ARGO_ROOT=~/.argo/office-hook '${process.execPath}' '${fileURLToPath(new URL('../bin/argo.mjs', import.meta.url))}' login`;
export const NAME_MAX = 120, TITLE_MAX = 200, REASON_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_FILE = 'sessions.json';
const CONFIG_FILE = 'config.json';

/** 훅 전용 데이터 폴더 — 앱(~/Library/…)·상주(~/.argo/workspaces)·CLI(~/.argo/cli-workspaces)와 따로 둔다(기기 세션 단일 소유). */
export const hookRoot = (env = process.env) => join(env.ARGO_CLI_HOME || join(env.HOME || homedir(), '.argo'), 'office-hook');
/** 한 줄로 — 줄바꿈·연속 공백을 공백 하나로, 앞뒤 공백 제거, 글자(코드 포인트) 단위로 자른다. */
export const oneLine = (s, max = Infinity) => [...String(s ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
const readJson = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };

/** 폴더의 config.json { org } — 조직 id가 uuid가 아니면 없는 것으로 본다. */
export async function readOfficeConfig(root) {
  const c = await readJson(join(root, CONFIG_FILE));
  return { org: typeof c?.org === 'string' && UUID.test(c.org.trim()) ? c.org.trim() : null };
}

/* ─── 상태 파일(마지막으로 보낸 값·시각) ─── */
/** { [세션 id]: { sent: { org, name, project, task }, at, failAt, task, title, offset, file, seen } } */
export async function readState(root) {
  const s = await readJson(join(root, STATE_FILE));
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}
/** 원자 교체로 쓴다. 8일 넘게 안 본 기록은 버린다(파일이 쌓이기만 하지 않게). 고쳐 쓸 때는 updateState를 쓴다(잠금 안에서 다시 읽고 고친다). */
export async function writeState(root, state, now = Date.now()) {
  const keep = Object.fromEntries(Object.entries(state).filter(([, v]) => now - Math.max(Number(v?.at) || 0, Number(v?.seen) || 0, Number(v?.failAt) || 0) < STATE_KEEP_MS));
  await mkdir(root, { recursive: true });
  const tmp = join(root, `${STATE_FILE}.tmp-${process.pid}-${Date.now().toString(36)}`); // 점으로 시작하지 않는 이름 — 데이터 폴더 바로 아래 점 파일은 셸 방어 목록이 관리한다(forbidden-zone 드리프트 검사)
  await writeFile(tmp, JSON.stringify(keep), { mode: 0o600 });
  await rename(tmp, join(root, STATE_FILE));
}
/** 잠금 안에서 상태 파일을 다시 읽고 mutate(state)로 고친 뒤 쓴다 — 훅(여러 세션)과 argo office report --task가 같은 파일을 번갈아 써도
    서로의 항목(맡은 할 일 task 등)을 지우지 않는다. 잠금은 기존 프로세스 간 잠금(src/mutex.mjs, `sessions.json.lockd` 폴더 — mkdir은 배타적)을 쓴다.
    주인이 죽어 남은 잠금은 10초 뒤 회수한다. timeoutMs 안에 못 잡으면 던진다(ELOCKTIMEOUT) — 훅은 그 턴을 건너뛴다. */
export async function updateState(root, mutate, { now = Date.now(), timeoutMs = 15_000 } = {}) {
  await mkdir(root, { recursive: true });
  const { withLock } = await import('./mutex.mjs');
  const file = join(root, STATE_FILE);
  return withLock(`office-state:${file}`, async () => {
    const state = await readState(root);
    mutate(state);
    await writeState(root, state, now);
    return state;
  }, { file, staleMs: 10_000, timeoutMs, refreshMs: 0 });
}

/** 보낸 값의 비교 열쇠 — 조직(config org)·제목·폴더·할 일 */
export const sentKey = (v) => JSON.stringify([v?.org ?? null, v?.name ?? null, v?.project ?? null, v?.task ?? null]);
/** 보낼 값이 마지막으로 보낸 값과 같고 4분 안이면 false(호출 0). 값이 바뀌었거나 4분이 지났으면(경계 포함) true. 실패 직후 1분은 false.
    영구 거절(denyAt·denyKey) 뒤에는 보낼 값이 거절당한 값과 같으면 6시간 동안 false. */
export function shouldReport(prev, next, now) {
  if (prev?.denyAt && now - prev.denyAt < DENY_PAUSE_MS && prev.denyKey === sentKey(next)) return false;
  if (prev?.failAt && now - prev.failAt < FAIL_PAUSE_MS) return false;
  const s = prev?.sent;
  const same = !!s && s.org === next.org && s.name === next.name && s.project === next.project && s.task === next.task;
  return !same || !(now - (Number(prev.at) || 0) < REPORT_EVERY_MS);
}

/* ─── 대화 기록에서 마지막 세션 제목 ─── */
const MARK = Buffer.from('"custom-title"');
const LINE_CAP = 64 * 1024; // 제목 줄은 짧다 — 이보다 긴 줄(그림·도구 결과)은 담지 않고 건너뛴다
/** jsonl을 from 바이트부터 줄 단위로 읽어 마지막 {"type":"custom-title","customTitle":…}을 찾는다. 반환 { title, offset } — offset = 마지막 완성된 줄 끝.
    다음 턴에는 offset부터만 읽는다(커다란 기록을 턴마다 처음부터 읽지 않게). 파일이 줄었으면(새로 쓰임) 처음부터. */
export async function scanTitle(file, { from = 0, title = null } = {}) {
  let size;
  try { size = (await stat(file)).size; } catch { return { title, offset: 0 }; }
  if (size < from) { from = 0; title = null; }
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let pos = from, done = from, carry = null, skip = false;
    const take = (line) => {
      if (skip || line.length > LINE_CAP || line.indexOf(MARK) === -1) return; // 긴 줄은 한 읽기 단위 안에 다 들어와도 보지 않는다(기준을 하나로)
      try { const o = JSON.parse(line.toString('utf8')); if (o?.type === 'custom-title' && typeof o.customTitle === 'string' && oneLine(o.customTitle)) title = oneLine(o.customTitle); } catch { /* 깨진 줄 */ }
    };
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0, i;
      while ((i = chunk.indexOf(10, start)) !== -1) {
        const piece = chunk.subarray(start, i);
        take(carry ? Buffer.concat([carry, piece]) : piece);
        carry = null; skip = false; start = i + 1;
        done = pos + start;
      }
      if (start < bytesRead && !skip) {
        carry = carry ? Buffer.concat([carry, chunk.subarray(start)]) : Buffer.from(chunk.subarray(start));
        if (carry.length > LINE_CAP) { carry = null; skip = true; }
      }
      pos += bytesRead;
    }
    return { title, offset: done };
  } finally { await fh.close(); }
}

/* ─── 서버 호출 ─── */
/** 기기 세션으로 만든 클라이언트 또는 null(로그인 없음·세션 사망). _mkClient·_fresh는 테스트 주입용. */
async function sessionClient(root, { _mkClient, _fresh } = {}) {
  const fresh = _fresh ?? (await import('./devicesession.mjs')).getFreshDeviceSession;
  const sess = await fresh({ root, ...(_mkClient ? { _mkClient } : {}) });
  if (!sess) return null;
  const mk = _mkClient ?? (await import('@supabase/supabase-js')).createClient;
  return mk(sess.url, sess.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${sess.access_token}` } } });
}
/** rpc 한 번 — 시간 제한(abortSignal). 반환 { data } | { error: 코드 또는 문구 } */
async function call(client, fn, args, timeoutMs) {
  try {
    const { data, error } = await client.rpc(fn, args).abortSignal(AbortSignal.timeout(timeoutMs));
    return error ? { error: String(error.message ?? error) } : { data };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

/** 세션 상태 보고 — 반환 { ok, written, task } | { login: true } | { error }. task=false: 보낸 할 일이 내 일이 아니라(그사이 남에게 다시 맡겨짐 등) 서버가 붙이지 않았다 */
export async function reportSession({ root, org = null, id, name, project = null, task = null, timeoutMs = 15_000, _mkClient, _fresh, _ancestor } = {}) {
  const client = await sessionClient(root, { _mkClient, _fresh });
  if (!client) return { login: true };
  const r = await call(client, 'office_session_report', { p_id: id, p_org: org, p_name: name, p_project: project, p_task: task }, timeoutMs);
  if (r.error) return { error: r.error };
  return { ok: true, written: !!r.data?.written, task: r.data?.task !== false };
}

/** 보낸 값을 상태 파일에 남긴다 — 훅과 이 명령이 같은 폴더를 쓰면 훅이 같은 값을 4분 안에 다시 보내지 않고, 명령으로 정한 할 일(task)을 이어 보낸다. */
export async function rememberSent(root, id, sent, now = Date.now()) {
  await updateState(root, (state) => { state[id] = { ...state[id], sent, at: now, failAt: 0, denyAt: 0, denyKey: null, task: sent.task ?? null }; }, { now });
}

/** 이 세션의 지금 제목 — 상태 파일에 남은 제목에서 이어 읽는다(쓰지 않는다). 보류 안내 훅이 안내 문구에 실제 세션 제목을 넣을 때 쓴다. */
export async function sessionTitle(root, id, file) {
  if (!file) return null;
  const prev = (await readState(root))[id] ?? {};
  return (await scanTitle(file, prev.file === file ? { from: prev.offset ?? 0, title: prev.title ?? null } : {})).title;
}

/* ─── 명령 ─── */
const T = {
  ko: {
    usage: [
      '사용법:',
      '  argo office report --org <조직 id> --id <세션 id> --name <제목> [--project <폴더>] [--task <할 일 id>]',
      '  argo office hold "<제목>" --reason "<사유>" --source-name "<세션 제목>" [--org <조직 id>]',
      '  argo office hold --task <할 일 id> --reason "<사유>" [--org <조직 id>]',
      '  argo office tasks [--org <조직 id>] [--json]',
      '  argo office <영역> <동작> [--옵션 값 …]   영역: work deals calendar company files mail briefing (argo office tools)',
      '  argo office orgs · argo office mcp (Claude Code·Codex가 붙는 MCP 서버)',
      '조직 id를 비우면 데이터 폴더(ARGO_ROOT)의 config.json {"org":"…"}을 씁니다.',
    ].join('\n'),
    needLogin: `먼저 로그인해야 합니다 — ${LOGIN}`,
    needOrg: '조직 id가 필요합니다 — --org <조직 id> 또는 config.json {"org":"…"}',
    badId: (k) => `${k}는 uuid여야 합니다.`,
    badName: `--name은 1~${NAME_MAX}자입니다.`, badProject: `--project는 ${NAME_MAX}자까지입니다.`,
    badTitle: `제목은 1~${TITLE_MAX}자입니다.`, badReason: `--reason(보류 사유)은 1~${REASON_MAX}자입니다.`, badSource: `--source-name "<세션 제목>"을 꼭 넣어 주세요(1~${NAME_MAX}자) — 업무 현황이 그 세션의 카드에 이 일을 붙입니다.`,
    titleAndTask: '새 일의 제목과 --task를 같이 줄 수 없습니다 — 새 일이면 제목만, 있는 일이면 --task만 주세요.',
    taskDropped: '그 할 일은 내 일이 아니라(다른 사람에게 다시 맡겨졌을 수 있습니다) 붙이지 않았습니다.',
    reported: '업무 현황에 보고했습니다.', unchanged: '바뀐 것이 없어 다시 쓰지 않았습니다(4분에 한 번).',
    heldNew: (t, id) => `보류한 일로 남겼습니다: ${t} (id=${id})`, heldOld: (id) => `보류로 바꿨습니다: id=${id}`, reasonOnly: (id) => `보류 사유를 고쳤습니다: id=${id}`,
    none: '끝내지 않은 일이 없습니다.', count: (n) => `끝내지 않은 일 ${n}건:`,
    status: { todo: '할 일', doing: '진행 중', hold: '보류' }, due: '기한', reason: '사유',
    failed: (m) => `실패: ${m}`,
    err: {
      session_signin: '로그인이 필요합니다 — argo login', session_forbidden: '권한이 없습니다(그 조직의 손님 아닌 멤버만, 남의 세션은 바꾸지 않습니다).',
      session_input: '입력이 올바르지 않습니다(제목 1~120자, 폴더 이름 120자까지).',
      business_forbidden: '권한이 없습니다(이 조직의 손님 아닌 멤버만).', task_input: '입력이 올바르지 않습니다(제목 1~200자, 보류 사유 500자까지).',
      task_forbidden: '권한이 없습니다(맡은 사람·관리자만 상태를 바꿉니다).', task_not_found: '그 할 일이 없습니다 — argo office tasks로 확인하세요.',
      task_cancelled: '취소한 일입니다.', task_done: '끝낸 일입니다 — 오피스에서 다시 연 뒤 보류하세요.', task_limit: '한도에 걸렸습니다(할 일 하나의 고친 기록 200번, 1년에 만드는 일 5,000건).',
      task_conflict: '같은 id의 다른 할 일이 있습니다 — 다시 시도하세요.',
    },
  },
  en: {
    usage: [
      'Usage:',
      '  argo office report --org <org id> --id <session id> --name <title> [--project <folder>] [--task <task id>]',
      '  argo office hold "<title>" --reason "<reason>" --source-name "<session title>" [--org <org id>]',
      '  argo office hold --task <task id> --reason "<reason>" [--org <org id>]',
      '  argo office tasks [--org <org id>] [--json]',
      '  argo office <area> <action> [--option value …]   areas: work deals calendar company files mail briefing (argo office tools)',
      '  argo office orgs · argo office mcp (MCP server for Claude Code·Codex)',
      'Without an org id, config.json {"org":"…"} in the data folder (ARGO_ROOT) is used.',
    ].join('\n'),
    needLogin: `Sign in first — ${LOGIN}`,
    needOrg: 'An org id is needed — --org <org id> or config.json {"org":"…"}',
    badId: (k) => `${k} must be a uuid.`,
    badName: `--name must be 1-${NAME_MAX} characters.`, badProject: `--project is limited to ${NAME_MAX} characters.`,
    badTitle: `The title must be 1-${TITLE_MAX} characters.`, badReason: `--reason (why it is on hold) must be 1-${REASON_MAX} characters.`, badSource: `Give --source-name "<session title>" (1-${NAME_MAX} characters) — Work status puts the task on that session's card.`,
    titleAndTask: 'Give either a title (new task) or --task (existing task), not both.',
    reported: 'Reported to Work status.', taskDropped: 'That task is not yours (it may have been reassigned), so it was not attached.', unchanged: 'Nothing changed, so nothing was written (once every 4 minutes).',
    heldNew: (t, id) => `Saved as an on-hold task: ${t} (id=${id})`, heldOld: (id) => `Put on hold: id=${id}`, reasonOnly: (id) => `Updated the reason: id=${id}`,
    none: 'No open tasks.', count: (n) => `${n} open tasks:`,
    status: { todo: 'to do', doing: 'doing', hold: 'on hold' }, due: 'due', reason: 'reason',
    failed: (m) => `Failed: ${m}`,
    err: {
      session_signin: 'Sign in first — argo login', session_forbidden: "Not allowed (non-guest members of that org only; other people's sessions are not changed).",
      session_input: 'Invalid input (title 1-120 chars, folder name up to 120).',
      business_forbidden: 'Not allowed (non-guest members of this org only).', task_input: 'Invalid input (title 1-200 chars, reason up to 500).',
      task_forbidden: 'Not allowed (only the assignee or an admin changes the status).', task_not_found: 'No such task — check with argo office tasks.',
      task_cancelled: 'The task is cancelled.', task_done: 'The task is done — reopen it in Office first.', task_limit: 'Limit reached (200 edits per task, 5,000 new tasks a year).',
      task_conflict: 'id conflict — try again.',
    },
  },
};
const errText = (t, msg) => t.err[Object.keys(t.err).find((k) => String(msg).includes(k))] ?? String(msg).slice(0, 300);

export const TOOL_SUBS = ['work', 'deals', 'calendar', 'company', 'files', 'mail', 'briefing', 'orgs', 'tools', 'mcp'];
const OPTIONS = {
  org: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, project: { type: 'string' }, task: { type: 'string' },
  reason: { type: 'string' }, 'source-name': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};

/**
 * argo office <하위 명령> — 종료 코드를 돌려준다(0 성공, 1 입력·서버 오류, 2 로그인 필요).
 * deps: { root, lang, out, err, newId, now, timeoutMs, _mkClient, _fresh } — 테스트가 주입한다.
 */
export async function officeMain(argv, { root = process.env.ARGO_ROOT, lang = 'ko', out = (s) => console.log(s), err = (s) => console.error(s), newId = randomUUID, now = Date.now, timeoutMs = 15_000, _mkClient, _fresh, _ancestor } = {}) {
  const t = T[lang] ?? T.ko;
  const [sub, ...rest] = argv;
  // 영역 명령(10/10 — 할 일·페이지·거래·일정·회사·문서함·메일·브리핑 읽기·쓰기, 조직 목록, MCP 서버) — 옵션이 영역마다 달라 여기 parseArgs를 거치지 않는다.
  // 맨 위 import에 싣지 않는다(훅이 report만 부를 때 zod·도구 처리기를 싣지 않게)
  if (TOOL_SUBS.includes(sub)) {
    const { toolsMain } = await import('./office-tools-cli.mjs');
    return toolsMain(sub, rest, { root, lang, out, err, cfgOrg: (await readOfficeConfig(root)).org, needLogin: t.needLogin, _fresh, _mkClient, _ancestor });
  }
  let v, pos;
  try { ({ values: v, positionals: pos } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true })); }
  catch (e) { err(`${t.failed(e.message)}\n${t.usage}`); return 1; }
  if (v.help || !['report', 'hold', 'tasks'].includes(sub)) { (v.help || sub === 'help' ? out : err)(t.usage); return v.help || sub === 'help' ? 0 : 1; }
  // 예전 하위 명령(tasks·hold·report — Claude Code 훅이 부른다)도 같은 판정(분리 검수 M1: 할 일 읽기·쓰기가 판정 없이 열려 있었다).
  // 도움말 판단은 인자 글자가 아니라 parseArgs 결과로 한다(보안 리뷰: `hold … -- --help`처럼 해석기와 다른 판단으로 판정을 건너뛰지 않게)
  {
    const { agentTurnState, agentTurnRefusal } = await import('./office-tools-cli.mjs');
    const st = await agentTurnState({ _ancestor });
    if (st) { err(agentTurnRefusal(st, lang)); return 1; }
  }

  const cfgOrg = (await readOfficeConfig(root)).org;
  const org = v.org != null ? v.org.trim() : cfgOrg;
  if (org && !UUID.test(org)) { err(t.badId('--org')); return 1; }
  const client = async () => {
    const c = await sessionClient(root, { _mkClient, _fresh });
    if (!c) err(t.needLogin);
    return c;
  };

  if (sub === 'report') {
    const id = String(v.id ?? '').trim(); const task = v.task ? v.task.trim() : null;
    if (!UUID.test(id)) { err(t.badId('--id')); return 1; }
    if (task && !UUID.test(task)) { err(t.badId('--task')); return 1; }
    const name = oneLine(v.name); const project = v.project != null ? oneLine(v.project) || null : null;
    if (!name || [...name].length > NAME_MAX) { err(t.badName); return 1; }
    if (project && [...project].length > NAME_MAX) { err(t.badProject); return 1; }
    const r = await reportSession({ root, org: org ?? null, id, name, project, task, timeoutMs, _mkClient, _fresh });
    if (r.login) { err(t.needLogin); return 2; }
    if (r.error) { err(t.failed(errText(t, r.error))); return 1; }
    await rememberSent(root, id, { org: org ?? null, name, project, task: r.task ? task : null }, now()).catch(() => {});
    if (v.json) out(JSON.stringify(r)); else { out(r.written ? t.reported : t.unchanged); if (task && !r.task) err(t.taskDropped); }
    return 0;
  }

  if (!org) { err(t.needOrg); return 1; }

  if (sub === 'hold') {
    const reason = oneLine(v.reason);
    if (!reason || [...reason].length > REASON_MAX) { err(t.badReason); return 1; }
    const title = oneLine(pos.join(' '));
    if (v.task != null) {
      if (title) { err(t.titleAndTask); return 1; }
      const id = v.task.trim();
      if (!UUID.test(id)) { err(t.badId('--task')); return 1; }
      const c = await client(); if (!c) return 2;
      // 이미 보류인 일이면 사유만 바꾼다(reason_only — 서버는 그사이 보류가 풀렸으면 task_conflict를 내고 상태를 바꾸지 않는다).
      // 보류가 아닌 일은 보류로 바꾼다. 목록에서 못 찾은 일(끝낸 일·없는 일)은 보류 요청을 보내 서버가 사유를 말하게 한다.
      const list = await call(c, 'office_task_list', { p_org: org }, timeoutMs);
      if (list.error) { err(t.failed(errText(t, list.error))); return 1; }
      const row = (Array.isArray(list.data) ? list.data : []).find((x) => x?.id === id);
      const write = (only) => call(c, 'office_task_write', { p_org: org, p_action: 'task.status', p_data: { id, status: 'hold', hold_reason: reason, ...(only ? { reason_only: true } : {}) } }, timeoutMs);
      let only = row?.status === 'hold';
      let r = await write(only);
      if (only && r.error && String(r.error).includes('task_conflict')) { only = false; r = await write(false); } // 목록을 읽은 뒤 보류가 풀렸다 — 보류로 바꾼다
      if (r.error) { err(t.failed(errText(t, r.error))); return 1; }
      out(v.json ? JSON.stringify(r.data ?? null) : only ? t.reasonOnly(id) : t.heldOld(id));
      return 0;
    }
    if (!title || [...title].length > TITLE_MAX) { err(t.badTitle); return 1; }
    // 출처 세션 이름은 꼭 받는다 — 없으면 업무 현황이 이 일을 '에이전트 없이 맡긴 일'로 잘못 분류한다(검수 10/8)
    const sourceName = v['source-name'] != null ? oneLine(v['source-name']) : '';
    if (!sourceName || [...sourceName].length > NAME_MAX) { err(t.badSource); return 1; }
    const id = newId();
    const c = await client(); if (!c) return 2;
    // 맡은 사람은 비운다 = 호출한 사람(서버 기본값). 출처 = 세션 — 업무 현황이 그 세션 이름의 사람에게 묶는다
    const data = { id, title, status: 'hold', hold_reason: reason, source: { kind: 'session', name: sourceName } };
    const r = await call(c, 'office_task_write', { p_org: org, p_action: 'task.create', p_data: data }, timeoutMs);
    if (r.error) { err(t.failed(errText(t, r.error))); return 1; }
    out(v.json ? JSON.stringify(r.data ?? null) : t.heldNew(title, id));
    return 0;
  }

  // tasks — 끝내지 않은 일(취소한 일은 서버 목록에 없다)
  const c = await client(); if (!c) return 2;
  const r = await call(c, 'office_task_list', { p_org: org }, timeoutMs);
  if (r.error) { err(t.failed(errText(t, r.error))); return 1; }
  const open = (Array.isArray(r.data) ? r.data : []).filter((x) => !x.done_at && !x.cancelled_at);
  if (v.json) { out(JSON.stringify(open)); return 0; }
  if (!open.length) { out(t.none); return 0; }
  out([t.count(open.length), ...open.map((x) => {
    const bits = [`[${t.status[x.status] ?? t.status.todo}] ${oneLine(x.title)}`];
    if (x.due_on) bits.push(`${t.due} ${String(x.due_on).slice(0, 10)}`);
    if (x.status === 'hold' && x.hold_reason) bits.push(`${t.reason}: ${oneLine(x.hold_reason, 120)}`);
    bits.push(`id=${x.id}`);
    return `- ${bits.join(' · ')}`;
  })].join('\n'));
  return 0;
}
