// 크루 우편함 — 비동기 크루 간 메시지(to·cc) + 스케줄러 배달.
//
// delegate(chat.mjs, 동기 hop≤2)와의 차이: **발신 턴이 수신 턴을 기다리지 않는다.** 파일로 적재만
// 하고 즉시 끝나며, 스케줄러 틱이 수신 크루의 새 턴으로 배달한다 — 다른 세션·다른 시각에도 크루끼리
// 이어진다(실사용 요청 2026-07-27: "다른 세션에서도 서로 연결되어 소통"). hop·chain은 메시지에 실려
// 전파되므로 delegate와 같은 연쇄 상한(2)·순환 차단이 비동기 경로에도 그대로 적용된다.
//
// 저장: <ws root>/mail/<수신 slug>/<msgId>-<kind>.json (kind: to|cc). 워크스페이스 경계 안 —
// 동기화 대상이며 시크릿 없음. cc는 사본 수신(회신 기대 없음)임을 프롬프트 프레임이 알린다.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';

/** 틱당 회사별 배달 상한. [규모 질문] 배달 1건 = LLM 턴 1개 — 상한이 없으면 크루 N명이 서로에게
    보낸 폭주가 한 틱에 N² 턴을 만든다. 초과분은 다음 틱(60s)으로 밀린다 — 지연은 무해, 폭발은 유해. */
export const MAIL_PER_TICK = 3;
/** 유계 재시도 — 무계 재시도 금지(2026-07-27 기억 정리 재설계와 같은 원칙). 소진 시 dead/로 이동해
    조용히 사라지지 않게 한다(무증상 실패가 가장 비싸다). */
export const MAIL_MAX_ATTEMPTS = 3;
/** 처리 중 표시(.claimed)가 이보다 오래 방치되면 크래시 잔재로 보고 회수한다. */
const CLAIM_STALE_MS = 15 * 60_000;

const mailRoot = (wsId) => join(paths(wsId).root, 'mail');
const mailDir = (wsId, slug) => join(mailRoot(wsId), String(slug));

/** 메시지 적재 — 수신자(to)와 참조(cc) 각각의 우편함에 사본을 쓴다. 반환: 메시지 id. */
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
    seen.add(s);
    rcpts.push({ slug: s, kind: 'cc' });
  }
  for (const r of rcpts) {
    await mkdir(mailDir(wsId, r.slug), { recursive: true });
    // 파일명에 kind — 같은 id의 to/cc 사본이 서로 덮지 않는다
    await writeFile(join(mailDir(wsId, r.slug), `${id}-${r.kind}.json`), JSON.stringify({ ...base, kind: r.kind }, null, 2));
  }
  return id;
}

/** 대기 메시지 수집(수신 slug별) — 배달 순서는 파일명(시각 접두) 순. */
async function pendingBySlug(wsId) {
  const out = []; // { slug, file, full }
  let slugs = [];
  try { slugs = await readdir(mailRoot(wsId), { withFileTypes: true }); } catch { return out; }
  for (const d of slugs) {
    if (!d.isDirectory() || d.name === 'dead') continue;
    let files = [];
    try { files = await readdir(mailDir(wsId, d.name)); } catch { continue; }
    for (const f of files.sort()) {
      if (f.endsWith('.json')) out.push({ slug: d.name, file: f, full: join(mailDir(wsId, d.name), f) });
      else if (f.endsWith('.claimed')) out.push({ slug: d.name, file: f, full: join(mailDir(wsId, d.name), f), claimed: true });
    }
  }
  return out;
}

/** 배달 프롬프트 — 수신 크루 턴의 사용자 메시지. delegate 프리픽스와 같은 문법(스레드에 그대로 보임). */
export function mailPrompt(msg, lang = 'ko') {
  const ccNote = msg.kind === 'cc'
    ? (lang === 'en' ? ' (CC — for your awareness; no reply expected)' : ' (참조 — 알아두라고 보낸 사본이다. 회신 의무는 없다)')
    : '';
  return lang === 'en'
    ? `(Message from colleague ${msg.fromName}${ccNote}) ${msg.message}${msg.kind === 'to' ? `\n(If a reply is needed, use send_to_crew to message ${msg.fromName} back.)` : ''}`
    : `(동료 ${msg.fromName}의 쪽지${ccNote}) ${msg.message}${msg.kind === 'to' ? `\n(회신이 필요하면 send_to_crew 도구로 ${msg.fromName}에게 답장을 보내라.)` : ''}`;
}

/** 우편 배달 — 스케줄러 틱에서 호출. runTurn(slug, prompt, { from, hop, chain })을 주입받는다
    (chat.mjs 직접 import는 순환이 되고, 주입이라야 단위 테스트가 배선까지 태울 수 있다 —
    "부품만 잠그고 배선 무방비" 교훈). 반환: 이번 틱 처리 수. */
export async function deliverCrewMail(wsId, runTurn, { limit = MAIL_PER_TICK, now = Date.now() } = {}) {
  const all = await pendingBySlug(wsId);
  let done = 0;
  for (const item of all) {
    if (done >= limit) break;
    // 크래시 잔재 회수 — 오래된 .claimed는 .json으로 되돌려 다음 루프에서 재시도
    if (item.claimed) {
      let st = null;
      try { st = JSON.parse(await readFile(item.full, 'utf8')); } catch { await rm(item.full, { force: true }).catch(() => {}); continue; }
      if (now - Date.parse(st.claimedAt ?? st.ts ?? 0) > CLAIM_STALE_MS) {
        await rename(item.full, item.full.replace(/\.claimed$/, '')).catch(() => {});
      }
      continue;
    }
    let msg = null;
    try { msg = JSON.parse(await readFile(item.full, 'utf8')); }
    catch { await rm(item.full, { force: true }).catch(() => {}); continue; } // 손상 — 배달 불가, 제거
    // 선점 — rename은 같은 fs에서 원자적. 이미 다른 주체가 집었으면(ENOENT) 스킵.
    const claimedPath = `${item.full}.claimed`;
    try { await writeFile(item.full, JSON.stringify({ ...msg, claimedAt: new Date(now).toISOString() }, null, 2)); await rename(item.full, claimedPath); }
    catch { continue; }
    done += 1;
    try {
      await runTurn(item.slug, msg, { from: msg.from, hop: msg.hop ?? 0, chain: msg.chain ?? [] });
      await rm(claimedPath, { force: true }).catch(() => {});
    } catch (e) {
      const attempts = (msg.attempts ?? 0) + 1;
      if (attempts >= MAIL_MAX_ATTEMPTS) {
        // 소진 — dead/로 이동(조용한 소실 금지). 사장이 mail/dead에서 확인·재투입할 수 있다.
        const deadDir = join(mailRoot(wsId), 'dead');
        await mkdir(deadDir, { recursive: true }).catch(() => {});
        await writeFile(join(deadDir, `${item.slug}-${item.file}`), JSON.stringify({ ...msg, attempts, lastError: String(e.message ?? e).slice(0, 200) }, null, 2)).catch(() => {});
        await rm(claimedPath, { force: true }).catch(() => {});
        console.error(`[argo] 크루 우편 배달 소진(${wsId}/${item.slug}/${msg.id}):`, e.message);
      } else {
        // 재시도 — attempts 올려 .json으로 복귀(다음 틱)
        await writeFile(claimedPath, JSON.stringify({ ...msg, attempts }, null, 2)).catch(() => {});
        await rename(claimedPath, item.full).catch(() => {});
        console.warn(`[argo] 크루 우편 배달 실패(${attempts}/${MAIL_MAX_ATTEMPTS}) ${wsId}/${item.slug}/${msg.id}:`, e.message);
      }
    }
  }
  return done;
}
