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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

const mailRoot = (wsId) => join(paths(wsId).root, 'mail');
const mailDir = (wsId, slug) => join(mailRoot(wsId), String(slug));
// 이 프로세스가 지금 배달 중인 claim 경로 — stale 회수가 자기 진행분을 건드리지 않게(HIGH-1)
const inFlight = new Set();

/** 메시지 적재 — 수신자(to)와 참조(cc, 상한 CC_MAX) 각각의 우편함에 사본을 쓴다. 반환: 메시지 id. */
export async function sendCrewMail(wsId, { from, fromName, to, cc = [], message, hop = 0, chain = [] }) {
  if (!to || !String(message ?? '').trim()) throw new Error('수신 크루와 내용이 필요합니다');
  const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const base = {
    id, from, fromName: fromName || from, message: String(message).trim(),
    hop, chain, ts: new Date().toISOString(), attempts: 0,
  };
  const seen = new Set([String(to)]);
  const rcpts = [{ slug: String(to), kind: 'to' }];
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
    // 선점 — rename 원자성만 신뢰(승자 1명). 패자는 ENOENT로 continue.
    const claimedPath = `${item.full}.claimed`;
    try { await rename(item.full, claimedPath); } catch { continue; }
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
      inFlight.delete(claimedPath);
      continue;
    }
    // claimedAt 각인 — 선점 **후** 갱신(선점 프리미티브와 분리). 실패해도 배달은 계속(mtime 폴백).
    await writeJsonAtomic(claimedPath, { ...msg, claimedAt: new Date(now).toISOString() }).catch(() => {});
    try {
      await runTurn(item.slug, msg, { from: msg.from, hop: msg.hop ?? 0, chain: msg.chain ?? [] });
      await rm(claimedPath, { force: true }).catch(() => {});
    } catch (e) {
      const attempts = (msg.attempts ?? 0) + 1;
      if (attempts >= MAIL_MAX_ATTEMPTS) {
        console.error(`[argo] 크루 우편 배달 소진(${wsId}/${item.slug}/${msg.id}):`, e.message);
        await moveToDead(wsId, item.slug, item.file, claimedPath, { ...msg, attempts, lastError: String(e.message ?? e).slice(0, 200) });
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
