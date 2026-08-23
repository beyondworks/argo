// 크루 우편함 — 비동기 크루 간 메시지(to·cc) + 스케줄러 배달.
//
// delegate(chat.mjs, 동기 hop≤2)와의 차이: **발신 턴이 수신 턴을 기다리지 않는다.** 파일로 적재만
// 하고 즉시 끝나며, 스케줄러 틱이 수신 크루의 새 턴으로 배달한다 — 다른 세션·다른 시각에도 크루끼리
// 이어진다(실사용 요청 2026-07-27: "다른 세션에서도 서로 연결되어 소통"). hop·chain은 메시지에 실려
// 전파되므로 delegate와 같은 연쇄 상한(2)이 비동기 경로에도 그대로 적용된다.
//
// 저장: <ws root>/mail/<수신 slug>/<msgId>-<kind>.json (kind: to|cc). **로컬 큐 — 동기화 제외**
// (sync.mjs EXCLUDE, 분리 검수 CRITICAL-2): .claimed·attempts는 기기 로컬 처리 상태라 동기화를 타면
// 두 기기가 같은 쪽지를 이중 배달한다(.gw-queue 선례와 동일 결함 계급). 세션 간 소통은 배달 결과가
// 스레드(동기화 대상)로 남는 것으로 성립한다 — 큐 자체는 발신 기기 소유이며, 배달도 그 기기의
// 스케줄러가 한다(클라우드 리더 게이트 미적용 — 걸면 비리더 기기 발신분이 무증상 소실, 2026-07-28).
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { writeJsonAtomic } from './jsonstore.mjs';

/** 틱당 회사별 배달 상한. [규모 질문] 배달 1건 = LLM 턴 1개 — 상한이 없으면 크루 N명이 서로에게
    보낸 폭주가 한 틱에 N² 턴을 만든다. 초과분은 다음 틱(60s)으로 밀린다 — 지연은 무해, 폭발은 유해. */
export const MAIL_PER_TICK = 3;
/** cc 상한 — 팬아웃 총량 방어(분리 검수 MEDIUM). 쪽지 1건의 최대 턴 = 1(to) + CC_MAX. */
export const CC_MAX = 4;
/** 유계 재시도 — 무계 재시도 금지(2026-07-27 기억 정리 재설계와 같은 원칙). 소진 시 .dead/로 이동해
    조용히 사라지지 않게 한다(무증상 실패가 가장 비싸다). */
export const MAIL_MAX_ATTEMPTS = 3;
/** 처리 중 표시(.claimed)가 이보다 오래 방치되면 크래시 잔재로 보고 회수한다.
    45분 = 최장 정상 턴(위임 연쇄 3단 × CLI 300s = 15분)의 3배 여유 — 진행 중 턴에는 하트비트가
    없으므로(분리 검수 HIGH-1) 짧으면 장기 턴을 크래시로 오판해 이중 배달을 만든다. 같은 프로세스가
    진행 중인 claim은 inFlight로 아예 회수 대상에서 뺀다. */
const CLAIM_STALE_MS = 45 * 60_000;
/** 예약 디렉터리 — dot 접두라 크루 slug와 충돌하지 않는다(slug는 WS_ID류 영숫자, 분리 검수 LOW). */
const DEAD_DIR = '.dead';
/** 배달 기록(jsonl) — 쪽지함 화면의 "배달 기록" 섹션. mail/ 아래라 동기화 제외(sync.mjs EXCLUDE). */
const LOG_FILE = '.log.jsonl';
/** ponytail: 로그는 단순 유지 — 읽을 때 LOG_TRIM_AT 줄을 넘으면 최근 LOG_KEEP 줄로 잘라 다시 쓴다.
    회전·락 없음: 잘라 쓰는 사이 append가 끼면 그 한 줄은 유실될 수 있다(기록 전용 — 배달에 영향 없음). */
const LOG_TRIM_AT = 2000;
const LOG_KEEP = 1000;
const LOG_SHOW = 200;

const mailRoot = (wsId) => join(paths(wsId).root, 'mail');
const mailDir = (wsId, slug) => join(mailRoot(wsId), String(slug));
// 이 프로세스가 지금 배달 중인 claim 경로 — stale 회수가 자기 진행분을 건드리지 않게(HIGH-1)
const inFlight = new Set();

/** 메시지 적재 — 수신자(to)와 참조(cc, 상한 CC_MAX) 각각의 우편함에 사본을 쓴다. 반환: 메시지 id.
    kind: 주 수신자에게 붙일 종류. 기본 'to'(회신 기대). 회의실에서 사장이 "cc @이름"으로 참조만
    돌릴 때는 'cc'를 넘긴다 — 수신자가 하나여도 의미는 참조다(회신 의무 없음).
    fromRole: 'captain'이면 동료가 아니라 사장이 보낸 것으로 문구가 갈린다(room.mjs 경유). */
export async function sendCrewMail(wsId, { from, fromName, fromRole = null, to, cc = [], message, hop = 0, chain = [], kind = 'to' }) {
  if (!to || !String(message ?? '').trim()) throw new Error('수신 크루와 내용이 필요합니다');
  // 자기 자신에게는 보낼 수 없다 — 배달 턴이 또 쪽지를 내면 hop 상한(왕복 방어)이 무의미해진다.
  // cc는 이미 `s === from`으로 걸러내는데(아래) 주 수신자만 무방비였다. 호출부(cli-directives)에서도
  // 막지만 근본 방어를 저장 관문에 둔다 — 새 호출부가 조용히 같은 구멍을 내지 않게(격리 재현 2026-07-30).
  // 비교는 NFC+소문자 정규화 — cli-directives의 norm()과 같은 기준(분리 검수 LOW: 'ALPHA'≠'alpha'로 통과).
  const eqSlug = (a, b) => String(a ?? '').normalize('NFC').toLowerCase().trim() === String(b ?? '').normalize('NFC').toLowerCase().trim();
  if (from && eqSlug(to, from)) throw new Error('자기 자신에게는 쪽지를 보낼 수 없습니다');
  if (kind !== 'to' && kind !== 'cc') throw new Error('kind는 to 또는 cc입니다');
  // 수신 slug는 곧 디렉터리명 — 쪽지함 API(사장 발신)가 화면 입력을 그대로 넘기므로 저장 관문에서 검증한다
  // (격리 재현 2026-08-23: to:'../x'가 <ws root>/x/에 파일을 만들었다).
  assertSlug(to); for (const c of cc) assertSlug(c);
  const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const base = {
    id, from, fromName: fromName || from, ...(fromRole ? { fromRole } : {}), message: String(message).trim(),
    hop, chain, ts: new Date().toISOString(), attempts: 0,
  };
  const seen = new Set([String(to)]);
  const rcpts = [{ slug: String(to), kind }];
  for (const c of cc) {
    const s = String(c);
    if (seen.has(s) || s === from) continue; // 중복·자기 참조 제거
    if (rcpts.length > CC_MAX) throw new Error(`참조는 ${CC_MAX}명까지입니다`); // 팬아웃 총량 방어
    seen.add(s);
    rcpts.push({ slug: s, kind: 'cc' });
  }
  for (const r of rcpts) {
    await mkdir(mailDir(wsId, r.slug), { recursive: true });
    // 파일명에 kind — 같은 id의 to/cc 사본이 서로 덮지 않는다. writeJsonAtomic — 절단본이 손상
    // 삭제 경로로 새지 않게(분리 검수 HIGH-3, 레포 표준).
    await writeJsonAtomic(join(mailDir(wsId, r.slug), `${id}-${r.kind}.json`), { ...base, kind: r.kind });
  }
  return id;
}

/** 대기 메시지 수집(수신 slug별) — 배달 순서는 파일명(시각 접두) 순. */
async function pendingBySlug(wsId) {
  const out = []; // { slug, file, full, claimed? }
  let slugs = [];
  try { slugs = await readdir(mailRoot(wsId), { withFileTypes: true }); } catch { return out; }
  for (const d of slugs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue; // .dead 등 예약 디렉터리 제외
    let files = [];
    try { files = await readdir(mailDir(wsId, d.name)); } catch { continue; }
    for (const f of files.sort()) {
      if (f.endsWith('.json')) out.push({ slug: d.name, file: f, full: join(mailDir(wsId, d.name), f) });
      else if (f.endsWith('.claimed')) out.push({ slug: d.name, file: f, full: join(mailDir(wsId, d.name), f), claimed: true });
    }
  }
  return out;
}

/** 배달 기록 한 줄 append — 실패는 배달을 막지 않는다(기록은 부가, 배달이 본업). */
async function appendLog(wsId, entry) {
  try {
    await mkdir(mailRoot(wsId), { recursive: true });
    await appendFile(join(mailRoot(wsId), LOG_FILE), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn(`[argo] 크루 우편 배달 기록 실패(${wsId}):`, e.message);
  }
}

/** 배달 기록 읽기 — 최신순 LOG_SHOW건. 파일이 LOG_TRIM_AT 줄을 넘으면 최근 LOG_KEEP 줄로 잘라 다시 쓴다. */
async function readLog(wsId) {
  const file = join(mailRoot(wsId), LOG_FILE);
  let lines = [];
  try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
  if (lines.length > LOG_TRIM_AT) {
    lines = lines.slice(-LOG_KEEP);
    await writeFile(file, lines.join('\n') + '\n').catch(() => {});
  }
  const out = [];
  for (const l of lines.slice(-LOG_SHOW).reverse()) {
    try { out.push(JSON.parse(l)); } catch { /* 절단 줄 — 건너뜀 */ }
  }
  return out;
}

// 경로 조립 전 검증 — 화면 입력이 그대로 파일 경로가 되므로 slug·id·파일명은 허용 문법만 통과시킨다.
const SLUG_RE = /^[^/\\.][^/\\]*$/;          // 구분자 금지, dot 접두 금지(.dead·.log 예약)
const ID_RE = /^m[a-z0-9]+$/;                 // sendCrewMail이 만드는 id 형태
const DEAD_RE = /^[^/\\.][^/\\]*-m[a-z0-9]+-(to|cc)\.json$/; // .dead/의 기록 파일명 `<slug>-<id>-<kind>.json`
function assertSlug(slug) { if (!SLUG_RE.test(String(slug ?? '')) || String(slug).includes('..')) throw new Error('잘못된 크루 slug'); }
function assertId(id) { if (!ID_RE.test(String(id ?? ''))) throw new Error('잘못된 쪽지 id'); }
function assertDeadFile(file) { if (!DEAD_RE.test(String(file ?? '')) || String(file).includes('..')) throw new Error('잘못된 실패함 파일명'); }

/** 쪽지함 목록 — 화면용. pending(대기·배달 중), dead(실패함), log(배달 기록 최신순). */
export async function listMail(wsId) {
  const pending = [];
  for (const item of await pendingBySlug(wsId)) {
    let body = {};
    try { body = JSON.parse(await readFile(item.full, 'utf8')); } catch { /* 손상 — 파일명 정보만 */ }
    const m = /^(m[a-z0-9]+)-(to|cc)\.json(\.claimed)?$/.exec(item.file);
    pending.push({
      id: body.id ?? m?.[1] ?? item.file, to: item.slug, from: body.from ?? null, fromName: body.fromName ?? body.from ?? null,
      fromRole: body.fromRole ?? null, kind: body.kind ?? m?.[2] ?? null, message: body.message ?? '',
      ts: body.ts ?? null, attempts: body.attempts ?? 0, claimed: !!item.claimed, claimedAt: body.claimedAt ?? null,
      lastError: body.lastError ?? null, file: item.file,
    });
  }
  const dead = [];
  try {
    for (const f of (await readdir(join(mailRoot(wsId), DEAD_DIR))).sort()) {
      if (f.endsWith('.corrupt')) { dead.push({ file: f, corrupt: true }); continue; }
      if (!f.endsWith('.json')) continue;
      let body = {};
      try { body = JSON.parse(await readFile(join(mailRoot(wsId), DEAD_DIR, f), 'utf8')); } catch { dead.push({ file: f, corrupt: true }); continue; }
      const tail = `-${body.id}-${body.kind}.json`;
      dead.push({
        file: f, id: body.id ?? null, to: body.id && body.kind && f.endsWith(tail) ? f.slice(0, f.length - tail.length) : null,
        from: body.from ?? null, fromName: body.fromName ?? body.from ?? null, fromRole: body.fromRole ?? null,
        kind: body.kind ?? null, message: body.message ?? '', ts: body.ts ?? null, attempts: body.attempts ?? 0, lastError: body.lastError ?? null,
      });
    }
  } catch { /* .dead 없음 */ }
  return { pending, dead, log: await readLog(wsId) };
}

/** 대기 쪽지 취소 — .json만. .claimed(배달 진행 중)는 거부: 턴이 이미 도는 중이라 지워도 배달은 끝난다. */
export async function cancelMail(wsId, slug, id) {
  assertSlug(slug); assertId(id);
  const dir = mailDir(wsId, slug);
  let files = [];
  try { files = await readdir(dir); } catch { throw new Error('쪽지를 찾을 수 없습니다'); }
  const claimed = files.find((f) => f.startsWith(`${id}-`) && f.endsWith('.claimed'));
  if (claimed) throw new Error('배달 중인 쪽지는 취소할 수 없습니다');
  const target = files.find((f) => f.startsWith(`${id}-`) && f.endsWith('.json'));
  if (!target) throw new Error('쪽지를 찾을 수 없습니다');
  let body = {};
  try { body = JSON.parse(await readFile(join(dir, target), 'utf8')); } catch { /* 기록은 파일명 기준 */ }
  await rm(join(dir, target), { force: true });
  await appendLog(wsId, { id, to: slug, from: body.from ?? null, fromName: body.fromName ?? null, kind: body.kind ?? null, ok: false, error: 'cancelled', attempts: body.attempts ?? 0 });
  return { ok: true };
}

/** 실패함 → 원래 우편함 복귀. attempts 0·lastError 제거. .corrupt는 불가(재기록할 원문이 없다). */
export async function requeueDead(wsId, file) {
  assertDeadFile(file);
  const src = join(mailRoot(wsId), DEAD_DIR, file);
  const { lastError: _drop, claimedAt: _drop2, ...body } = JSON.parse(await readFile(src, 'utf8'));
  if (!body.id || !body.kind) throw new Error('복귀할 수 없는 기록입니다');
  const slug = file.slice(0, file.length - `-${body.id}-${body.kind}.json`.length);
  assertSlug(slug);
  await mkdir(mailDir(wsId, slug), { recursive: true });
  await writeJsonAtomic(join(mailDir(wsId, slug), `${body.id}-${body.kind}.json`), { ...body, attempts: 0 });
  await rm(src, { force: true });
  return { ok: true, to: slug, id: body.id };
}

/** 실패함 기록 삭제(.corrupt 포함). */
export async function deleteDead(wsId, file) {
  if (!DEAD_RE.test(String(file ?? '')) && !/^[^/\\.][^/\\]*\.corrupt$/.test(String(file ?? ''))) throw new Error('잘못된 실패함 파일명');
  if (String(file).includes('..')) throw new Error('잘못된 실패함 파일명');
  await rm(join(mailRoot(wsId), DEAD_DIR, file), { force: true });
  return { ok: true };
}

/** 배달 프롬프트 — 수신 크루 턴의 사용자 메시지. delegate 프리픽스와 같은 문법(스레드에 그대로 보임).
    회신 안내는 **회신이 실제로 가능한 턴에만**(kind=to && hop<2 — hop≥2 배달 턴은 도구가 없다,
    분리 검수 HIGH-2: 존재하지 않는 도구를 지시하던 프롬프트).
    hasTools=false(수신 크루가 외부 CLI 러너 — send_to_crew가 표면에 없다)도 같은 이유로 회신 지시를
    뺀다(분리 검수 MEDIUM 2026-07-28, HIGH-2와 동일 사고). 판정은 호출자(scheduler)가 수신 크루의
    유효 러너로 내린다. */
export function mailPrompt(msg, lang = 'ko', { hasTools = true } = {}) {
  const canReply = msg.kind === 'to' && (msg.hop ?? 0) < 2 && hasTools;
  const ccNote = msg.kind === 'cc'
    ? (lang === 'en' ? ' (CC — for your awareness; no reply expected)' : ' (참조 — 알아두라고 보낸 사본이다. 회신 의무는 없다)')
    : '';
  // 사장이 회의실에서 참조로 돌린 것 — "동료의 쪽지"라고 하면 발신자를 잘못 알려준다(회의실 cc 경로).
  if (msg.fromRole === 'captain') {
    return lang === 'en'
      ? `(From the captain — shared from the meeting room${ccNote}) ${msg.message}`
      : `(사장이 회의실에서 공유${ccNote}) ${msg.message}`;
  }
  return lang === 'en'
    ? `(Message from colleague ${msg.fromName}${ccNote}) ${msg.message}${canReply ? `\n(If a reply is needed, use send_to_crew to message ${msg.fromName} back.)` : ''}`
    : `(동료 ${msg.fromName}의 쪽지${ccNote}) ${msg.message}${canReply ? `\n(회신이 필요하면 send_to_crew 도구로 ${msg.fromName}에게 답장을 보내라.)` : ''}`;
}

/** 우편 배달 — 스케줄러 틱에서 호출. runTurn(slug, msg, { from, hop, chain })을 주입받는다
    (chat.mjs 직접 import는 순환이 되고, 주입이라야 단위 테스트가 배선까지 태울 수 있다).
    선점은 **rename 단독** — 원자적이라 승자가 1명이다(분리 검수 CRITICAL-1: writeFile 선행 방식은
    rename으로 집힌 원본을 되살려 이중 배달을 만들었다 — 21회 중 3회 실측). 반환: 이번 틱 처리 수. */
export async function deliverCrewMail(wsId, runTurn, { limit = MAIL_PER_TICK, now = Date.now() } = {}) {
  const all = await pendingBySlug(wsId);
  let done = 0;
  for (const item of all) {
    if (done >= limit) break;
    // 크래시 잔재 회수 — 이 프로세스 진행분(inFlight)은 제외, 오래된 .claimed만 .json으로 복귀
    if (item.claimed) {
      if (inFlight.has(item.full)) continue;
      let stampMs = 0;
      try {
        const st = JSON.parse(await readFile(item.full, 'utf8'));
        stampMs = Date.parse(st.claimedAt ?? st.ts ?? 0) || 0;
      } catch { /* 읽기 실패 — mtime 폴백 */ }
      if (!stampMs) { try { stampMs = (await stat(item.full)).mtimeMs; } catch { continue; } }
      if (now - stampMs > CLAIM_STALE_MS) {
        await rename(item.full, item.full.replace(/\.claimed$/, '')).catch(() => {});
      }
      continue;
    }
    // 선점 — mkdir 뮤텍스 + rename. rename 단독은 **윈도우에서 승자가 둘**일 수 있다(MoveFileEx 내부
    // 핸들 TOCTOU, CI 실측 2026-08-06·2026-08-23: 같은 원본에 두 rename이 모두 성공해 이중 배달).
    // mkdir은 모든 OS에서 배타적이라 승자 선출에 쓰고, rename이 끝나면 바로 지운다 — 늦은 패자는
    // mkdir 성공 뒤 rename에서 ENOENT로 빠진다. 크래시 잔재(.lockd)는 stale 회수가 치운다.
    const claimedPath = `${item.full}.claimed`;
    const lockDir = `${item.full}.lockd`;
    try { await mkdir(lockDir); } catch {
      // 잔재 락(프로세스 크래시) — 오래됐으면 치우고 다음 틱에 맡긴다
      try { if (now - (await stat(lockDir)).mtimeMs > CLAIM_STALE_MS) await rm(lockDir, { recursive: true, force: true }); } catch { /* 이미 사라짐 */ }
      continue;
    }
    let won = false;
    try { await rename(item.full, claimedPath); won = true; } catch { /* 패자 */ }
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    if (!won) continue;
    inFlight.add(claimedPath);
    done += 1;
    let msg = null;
    try {
      msg = JSON.parse(await readFile(claimedPath, 'utf8'));
    } catch (e) {
      // 손상 — 배달 불가. 조용히 지우지 않는다(HIGH-3②): .dead/로 이동 + 로그.
      console.error(`[argo] 크루 우편 손상(${wsId}/${item.slug}/${item.file}):`, e.message);
      await moveToDead(wsId, item.slug, item.file, claimedPath, { corrupt: true });
      inFlight.delete(claimedPath);
      continue;
    }
    // 소진 선확인 — .dead 기록이 실패해 회수-재배달 루프에 들어온 메시지가 매 회차 LLM 턴을
    // 태우지 않게, 턴 실행 **전에** 상한을 본다(재검 LOW: "상한이 결국 잡는다"가 이 경로에선 거짓이었다).
    if ((msg.attempts ?? 0) >= MAIL_MAX_ATTEMPTS) {
      await moveToDead(wsId, item.slug, item.file, claimedPath, { ...msg, lastError: msg.lastError ?? 'attempts exhausted' });
      await appendLog(wsId, { id: msg.id, to: item.slug, from: msg.from, fromName: msg.fromName, kind: msg.kind, ok: false, error: msg.lastError ?? 'attempts exhausted', attempts: msg.attempts ?? 0 });
      inFlight.delete(claimedPath);
      continue;
    }
    // claimedAt 각인 — 선점 **후** 갱신(선점 프리미티브와 분리). 실패해도 배달은 계속(mtime 폴백).
    await writeJsonAtomic(claimedPath, { ...msg, claimedAt: new Date(now).toISOString() }).catch(() => {});
    try {
      await runTurn(item.slug, msg, { from: msg.from, hop: msg.hop ?? 0, chain: msg.chain ?? [] });
      await rm(claimedPath, { force: true }).catch(() => {});
      await appendLog(wsId, { id: msg.id, to: item.slug, from: msg.from, fromName: msg.fromName, kind: msg.kind, ok: true, attempts: (msg.attempts ?? 0) + 1 });
    } catch (e) {
      const attempts = (msg.attempts ?? 0) + 1;
      const error = String(e.message ?? e).slice(0, 200);
      await appendLog(wsId, { id: msg.id, to: item.slug, from: msg.from, fromName: msg.fromName, kind: msg.kind, ok: false, error, attempts, exhausted: attempts >= MAIL_MAX_ATTEMPTS });
      if (attempts >= MAIL_MAX_ATTEMPTS) {
        console.error(`[argo] 크루 우편 배달 소진(${wsId}/${item.slug}/${msg.id}):`, e.message);
        await moveToDead(wsId, item.slug, item.file, claimedPath, { ...msg, attempts, lastError: error });
      } else {
        console.warn(`[argo] 크루 우편 배달 실패(${attempts}/${MAIL_MAX_ATTEMPTS}) ${wsId}/${item.slug}/${msg.id}:`, e.message);
        // 재시도 — attempts 올려 .json으로 복귀(다음 틱). 갱신 실패 시에도 복귀는 시도한다
        // (attempts 미증가로 한 회차 더 돌 수 있으나, 소실보다 낫고 상한이 결국 잡는다).
        await writeJsonAtomic(claimedPath, { ...msg, attempts }).catch(() => {});
        await rename(claimedPath, item.full).catch(() => {});
      }
    } finally {
      inFlight.delete(claimedPath);
    }
  }
  return done;
}

/** .dead/ 이동 — 기록이 **성공한 뒤에만** 원본을 지운다(HIGH-3①: 기록 실패 + 원본 삭제 = 무증상 소실).
    기록 실패 시 원본(.claimed)을 남겨 다음 틱의 stale 회수가 재시도하게 한다. */
async function moveToDead(wsId, slug, file, claimedPath, record) {
  try {
    const deadDir = join(mailRoot(wsId), DEAD_DIR);
    await mkdir(deadDir, { recursive: true });
    if (record.corrupt) {
      await rename(claimedPath, join(deadDir, `${slug}-${file}.corrupt`)); // 원문 보존 이동 — 파싱 불가라 재기록 불가
    } else {
      await writeJsonAtomic(join(deadDir, `${slug}-${file}`), record);
      await rm(claimedPath, { force: true });
    }
  } catch (e) {
    console.error(`[argo] 크루 우편 .dead 기록 실패(${wsId}/${slug}/${file}) — 원본 유지, 다음 틱 재시도:`, e.message);
  }
}
