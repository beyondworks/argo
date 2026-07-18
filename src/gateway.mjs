// 메신저 게이트웨이 — 텔레그램/슬랙이 회사의 정문이 된다.
// 메신저에서 크루를 부르면 웹과 같은 chat 경로로 턴이 돌고(스레드·기억 공유),
// 결재는 버튼/회신으로 처리되며, 루틴 결과가 브리핑으로 밀려온다.
import { listCompanies, listAgents } from './hub.mjs';
import { loadConnections, updateConnection, updateAgentBot } from './connections.mjs';
import { chat } from './chat.mjs';
import { loadThread, appendTurn, appendSharedNote } from './thread.mjs';
import { resolveWithFollowUp } from './approval-actions.mjs';
import { setApprovalMeta } from './approvals.mjs';
import { onNotify } from './notify.mjs';
import { daemonLease } from './lock.mjs';
import { isCloudLeader } from './sync.mjs';
import { appendEvent } from './events.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { mkdir, readFile, writeFile, readdir, stat, rename, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany, getDeviceId } from './workspace.mjs';
import { mdToTelegramHtml, splitForTelegram, extractFileRefs, isImagePath } from './tg-format.mjs';

/** 폴러 하트비트 — 연결 카드의 "가동 중 · N초 전 응답" 표시의 원천. root의 dotfile이라 vault 스캔 무관. */
async function beatGateway(wsId, kind, ok, error = '') {
  try {
    await writeFile(join(paths(wsId).root, `.gateway-${kind}.json`), JSON.stringify({ ts: Date.now(), ok, error: String(error).slice(0, 200) }));
  } catch { /* 하트비트는 베스트에포트 */ }
}

// 폴러 offset 영속화 — 재시작·리더 교체 시 offset=0으로 되돌아가 마지막 배치를 재수신·재실행하는 것을 막는다.
// offset은 lenient 로드(손상 시 0부터 재개 — 재수신은 아래 디스크 큐가 멱등 재적재로 방어).
async function loadOffset(wsId, key) {
  const o = await readJsonLenient(join(paths(wsId).root, `.gw-offset-${key}.json`), { offset: 0 });
  return o?.offset ?? 0;
}
async function saveOffset(wsId, key, offset) {
  try { await writeJsonAtomic(join(paths(wsId).root, `.gw-offset-${key}.json`), { offset }); }
  catch { /* 베스트에포트 */ }
}

// 슬랙 커서 영속 — 텔레그램과 달리 서버측 수신 확정(offset)이 없어 이 파일이 유일한 재개 지점이다.
// 재시작 시 다운타임에 온 지시·결재 회신을 이어받는다(이전엔 인메모리 '지금'부터라 통째 유실).
// 비점(non-dot) 파일이라 동기화를 타고 기기 간 LWW로 수렴 — 리더가 바뀐 기기도 마지막 지점부터 잇는다
// (전환 직전 ~8s 미동기 창은 재수신·중복 쪽으로 흡수 — at-least-once, 유실 없음).
const slackCursorFile = (wsId) => join(paths(wsId).root, 'gw-cursor-slack.json');
async function loadSlackCursor(wsId) { return (await readJsonLenient(slackCursorFile(wsId), null))?.ts ?? null; }
async function saveSlackCursor(wsId, ts) {
  try { await writeJsonAtomic(slackCursorFile(wsId), { ts }); }
  catch { /* 베스트에포트 — 다음 배치가 다시 저장한다 */ }
}

/* ─── 지시 처리 큐 (at-least-once) ───
   문제(감사 D5): 텔레그램 폴러가 offset을 처리 for-루프 '앞'에서 커밋하고, 실제 턴(runWithAtts/run)은
   await 없는 fire-and-forget이라 offset 저장 후 크래시 시 그 지시가 재수신·재처리 안 되고 영구 유실(at-most-once).

   처방(디스크 큐): 폴 루프는 update를 디스크 큐에 '적재한 직후'에만 offset을 전진시킨다(=Telegram에 수신 확정).
   별도 워커가 큐를 드레인해 턴을 실행하고 '성공적으로 끝난 뒤에만' 파일을 삭제한다. 처리 도중 크래시면
   파일이 남아 재기동 시 재처리된다. 파일명 = update_id라 재수신 시 재적재가 멱등(중복 큐 항목 없음).
   트레이드오프: 응답 전송 후 unlink 전에 크래시하면 재기동 때 같은 지시를 한 번 더 처리(중복 응답 가능).
   at-most-once(유실)보다 at-least-once(중복)를 택한다 — 지시 유실이 훨씬 치명적이다.
   블로킹 회피: 폴 루프는 '빠른 디스크 적재'만 await하고 긴 턴은 워커가 뒤에서 돌리므로, 결재 버튼 콜백을
   막지 않는다(권한 게이트 데드락 방지 — 기존 논블로킹 성질 보존).

   소유권(백로그: 리더 전환 시 큐잉 지시 멈춤): 워커는 폴러가 아니라 매니저(ensureGateway)가 소유하고
   클라우드 리더 여부와 무관하게 상시 돈다 — 리더를 양보한(또는 죽었다 살아난) 기기에 남은 잡도 그 기기가
   끝까지 처리한다. 잡은 적재한 기기에만 있고(큐는 동기화 제외) dev 태그로 그 사실을 강제해,
   과거 동기화로 흘러든 다른 기기의 잡 사본이 이중 실행되는 것을 막는다. */
const GW_MAX_INFLIGHT = 2; // 동시 크루 턴 상한 — 큐가 쌓여도 비용 폭주를 막는다
const LEGACY_JOB_MAX_AGE_MS = 24 * 3_600_000; // dev 태그 없는 구형식 잡의 실행 허용 연령 — 넘으면 좀비 실행 방지 위해 폐기
export function queueDir(wsId, key) { return join(paths(wsId).root, `.gw-queue-${key}`); } // (export: 회귀 테스트용)
export async function enqueueJob(wsId, key, id, job) { // (export: 회귀 테스트용)
  const dev = await getDeviceId().catch(() => null); // 적재 기기 태그 — 이 기기의 워커만 이 잡을 실행한다
  await writeJsonAtomic(join(queueDir(wsId, key), `${id}.json`), dev ? { ...job, dev } : job); // 원자적 — 부분 쓰기가 워커에 보이지 않는다
}
/** 큐 드레인 워커 — 1초 폴. handler(job)이 정상 반환하면 파일 삭제(처리 완료), 던지면 유지(다음 틱 재시도·재기동 복구). (export: 회귀 테스트용) */
export function startQueueWorker(wsId, key, handler) {
  let stopped = false;
  let me = null; // 이 기기 id — 해석 전(null)에는 잡을 집지 않는다(남의 사본 오실행 방지). 실패 시 ''(판정 생략, 전부 실행)
  getDeviceId().then((d) => { me = d; }).catch(() => { me = ''; });
  const busy = new Set();
  const iv = setInterval(async () => {
    if (stopped || me === null) return;
    let names = [];
    try { names = await readdir(queueDir(wsId, key)); } catch { return; } // 큐 디렉터리 없음 — 할 일 없음
    names = names.filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .sort((a, b) => ((parseInt(a, 10) || 0) - (parseInt(b, 10) || 0)) || a.localeCompare(b)); // 도착 순서 근사(동값은 사전순 고정)
    for (const n of names) {
      if (busy.has(n)) continue;
      if (busy.size >= GW_MAX_INFLIGHT) break; // 상한 도달 — 남은 잡은 다음 틱
      busy.add(n);
      (async () => {
        const fp = join(queueDir(wsId, key), n);
        try {
          const job = await readJsonLenient(fp, null); // 손상 잡은 null → 처리 스킵 후 삭제(무한 재시도 방지)
          if (job?.dev && me && job.dev !== me) {
            // 다른 기기가 적재한 잡의 사본(과거 큐가 동기화되던 시절의 잔재) — 원 기기가 실행하므로 정리만
            console.log(`[argo] 큐 정리(${wsId}/${key}/${n}): 다른 기기(${String(job.dev).slice(0, 8)})의 잡 사본 — 실행 없이 제거`);
          } else if (job && !job.dev && Date.now() - (((await stat(fp).catch(() => null))?.mtimeMs) ?? 0) > LEGACY_JOB_MAX_AGE_MS) {
            // dev 태그 없는 구형식 잡이 너무 오래됨 — 어느 기기 것인지 알 수 없어 좀비 실행 대신 폐기(로그로 관측)
            console.log(`[argo] 큐 정리(${wsId}/${key}/${n}): ${Math.round(LEGACY_JOB_MAX_AGE_MS / 3_600_000)}시간 넘은 구형식 잡 — 실행 없이 제거`);
          } else if (job) {
            await handler(job); // handler는 턴 실패를 내부 처리(에러 회신)하고 정상 반환 → 아래서 삭제
          }
          await unlink(fp).catch(() => {}); // 처리 완료분만 제거. 처리 중 크래시면 파일이 남아 재기동 시 재처리
        } catch (e) {
          console.error(`[argo] 큐 처리 실패(${wsId}/${key}/${n}):`, e.message); // 인프라 예외 — 파일 유지, 다음 틱 재시도
        } finally {
          busy.delete(n);
        }
      })();
    }
  }, 1000);
  iv.unref?.();
  return () => { stopped = true; clearInterval(iv); };
}

const MAX_MSG = 3800; // 텔레그램 4096 제한 대비 여유
const clip = (t) => (t.length > MAX_MSG ? `${t.slice(0, MAX_MSG)}\n…(전체 내용은 Argo 데크에서)` : t);

// 회사 시스템 언어(ko|en) 기반 코드 방출 문자열 선택. 기존 회사(lang 없음/'ko')는 항상 ko 반환 → 기존 동작 그대로.
const pick = (ko, en, lang) => (lang === 'en' ? en : ko);

/** 크루 응답 발신 — 마크다운을 텔레그램 HTML로, 길면 분할, 본문 속 vault 파일은 사진/문서로 동봉. */
async function sendTgReply(token, chatId, wsId, text) {
  const html = mdToTelegramHtml(text);
  for (const chunk of splitForTelegram(html)) {
    try {
      await tg(token, 'sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch {
      // HTML 파싱 실패 폴백 — 태그 제거한 플레인 텍스트로라도 반드시 전달한다
      await tg(token, 'sendMessage', { chat_id: chatId, text: chunk.replace(/<[^>]+>/g, '') }).catch(() => {});
    }
  }
  for (const rel of extractFileRefs(text)) {
    try {
      const buf = await readFile(join(paths(wsId).vault, rel));
      const name = rel.split('/').pop();
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      fd.append(isImagePath(rel) ? 'photo' : 'document', new Blob([buf]), name);
      await fetch(`https://api.telegram.org/bot${token}/${isImagePath(rel) ? 'sendPhoto' : 'sendDocument'}`, {
        method: 'POST', body: fd, signal: AbortSignal.timeout(60_000),
      });
    } catch { /* 파일 동봉 실패는 본문 전달을 막지 않는다 */ }
  }
}

/** 수신 미디어(사진·문서·영상·음성) 다운로드 → vault/files/ 저장. 봇 API 다운로드 한계 20MB. */
async function tgDownload(token, wsId, msg) {
  let f = null; let name = 'file'; let mime = '';
  if (msg.photo?.length) { f = msg.photo[msg.photo.length - 1]; name = `photo-${f.file_unique_id}.jpg`; mime = 'image/jpeg'; }
  else if (msg.document) { f = msg.document; name = msg.document.file_name || `doc-${msg.document.file_unique_id}`; mime = msg.document.mime_type || ''; }
  else if (msg.video) { f = msg.video; name = `video-${f.file_unique_id}.mp4`; mime = 'video/mp4'; }
  else if (msg.voice) { f = msg.voice; name = `voice-${f.file_unique_id}.ogg`; mime = 'audio/ogg'; }
  else if (msg.audio) { f = msg.audio; name = msg.audio.file_name || `audio-${msg.audio.file_unique_id}`; mime = msg.audio.mime_type || ''; }
  if (!f) return null;
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  if ((f.file_size ?? 0) > 19_500_000) throw new Error(pick('20MB를 넘는 파일은 텔레그램 봇이 내려받을 수 없습니다', 'Files larger than 20MB cannot be downloaded by the Telegram bot', lang));
  const info = await tg(token, 'getFile', { file_id: f.file_id });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(pick(`파일 다운로드 실패(${res.status})`, `File download failed (${res.status})`, lang));
  const buf = Buffer.from(await res.arrayBuffer());
  const safe = name.replace(/[^\w.\-가-힣]/g, '_').slice(-80);
  const rel = `files/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-${safe}`;
  await mkdir(join(paths(wsId).vault, 'files'), { recursive: true });
  await writeFile(join(paths(wsId).vault, rel), buf);
  return { rel, name: safe, mime, isImage: /^image\/(png|jpeg|webp|gif)$/.test(mime) };
}

async function tg(token, method, body, timeoutMs = 35_000) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
  return j.result;
}

async function slackApi(token, method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(12_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`slack ${method}: ${j.error ?? res.status}`);
  return j;
}

/** "@이름 지시" → to 크루, "@이름1 @이름2 지시" → 첫 번째가 to, 나머지는 cc(맥락 공유). 이름 미지정이면 기본 크루. (export는 테스트용) */
export async function routeMessage(wsId, cfg, text) {
  const agents = await listAgents(wsId);
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  if (!agents.length) return { error: pick('아직 크루가 없습니다. Argo 데크에서 먼저 영입해 주세요.', 'No crew yet. Hire your first crew from the Argo deck.', lang) };
  let body = text.trim();
  // 그룹방에서 봇 멘션(@봇이름)으로 시작하면 벗겨낸다 — 그 뒤의 @크루 멘션이 라우팅 대상
  if (cfg.botUsername) body = body.replace(new RegExp(`^@?${cfg.botUsername.replace(/^@/, '')}\\s+`, 'i'), '');
  const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase(); // 한글 NFC/NFD 불일치 방어 — 파일 유래 이름과 입력 이름의 유니코드가 다를 수 있다
  const find = (key) => agents.find((a) => norm(a.slug) === norm(key) || norm(a.name) === norm(key));
  const mentions = [];
  let m;
  while ((m = body.match(/^@(\S+)\s+/))) {
    const target = find(m[1]);
    if (!target) break; // 크루가 아닌 @단어는 본문의 일부로 남긴다
    if (!mentions.some((a) => a.slug === target.slug)) mentions.push(target);
    body = body.slice(m[0].length);
  }
  if (!mentions.length && /^@\S+\s+\S/.test(body)) {
    const bad = body.match(/^@(\S+)/)[1];
    return { error: pick(
      `"${bad}" 크루를 못 찾았습니다. 크루: ${agents.map((a) => a.name).join(', ')} — "크루"라고 보내면 현황을 보여드립니다.`,
      `Couldn't find crew "${bad}". Crew: ${agents.map((a) => a.name).join(', ')} — send "crew" to see the roster.`,
      lang,
    ) };
  }
  const to = mentions[0] ?? (agents.find((a) => a.slug === cfg.defaultCrew) ?? agents[0]);
  return { slug: to.slug, name: to.name, msg: body.trim(), cc: mentions.slice(1) };
}

/** "크루"/"/crew"/"현황" — 어떤 크루가 이 채팅에 연결되어 있는지 즉답(모델 호출 없음). */
async function crewStatusReply(wsId, cfg) {
  const agents = await listAgents(wsId);
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  if (!agents.length) return pick('아직 크루가 없습니다. Argo 데크에서 먼저 영입해 주세요.', 'No crew yet. Hire your first crew from the Argo deck.', lang);
  const def = agents.find((a) => a.slug === cfg.defaultCrew) ?? agents[0];
  return [
    pick(`**연결된 크루 ${agents.length}명**`, `**${agents.length} crew connected**`, lang),
    ...agents.map((a) => `• ${a.name} (@${a.slug})${a.role ? ` — ${a.role}` : ''}${a.runner && a.runner !== 'claude' ? ` · ${a.runner}` : ''}${a.slug === def?.slug ? pick(' · 기본', ' · default', lang) : ''}`),
    '',
    pick(
      '"@이름 지시"로 특정 크루를 부르고, "@이름1 @이름2 지시"처럼 여러 명을 적으면 첫 번째가 실행하고 나머지에게 맥락이 공유됩니다(cc).',
      'Address a specific crew with "@name instruction". List several like "@name1 @name2 instruction" and the first one acts while the rest receive the shared context (cc).',
      lang,
    ),
  ].join('\n');
}

/** 메신저발 지시 1턴 — 웹과 동일 경로(스레드 이어쓰기 + vault 기억 + 첨부 비전). ctx = 발화 위치(위임 미러용). */
async function runTurn(wsId, cfg, text, attachments = [], ctx = null) {
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  // "승인 ap-xxx" / "거절 ap-xxx" 텍스트 결재 (슬랙·텔레그램 공용) — 결재 토큰(승인/거절)은 파서 앵커라 고정
  const ap = text.match(/^(승인|거절)\s+(ap-[a-z0-9]+)/);
  if (ap) {
    const approve = ap[1] === '승인';
    const item = await resolveWithFollowUp(wsId, ap[2], approve);
    return pick(
      `결재 ${ap[1]} 처리: ${item.action}\n실행 결과는 담당 크루가 이어서 보고합니다.`,
      `Approval ${approve ? 'approved' : 'rejected'}: ${item.action}\nThe assigned crew will follow up with the result.`,
      lang,
    );
  }
  if (/^\/?(크루|현황|crew|status)$/i.test(text.trim())) return crewStatusReply(wsId, cfg);
  const r = await routeMessage(wsId, cfg, text);
  if (r.error) return r.error;
  const t = await loadThread(wsId, r.slug);
  // 그룹에서 온 턴이면 mirrorCtx로 전달 — 위임 미러가 이 턴의 방으로만 발화(전역 맵 오배달 제거)
  const turn = await chat(wsId, r.slug, r.msg, t.sessionId, { source: 'messenger', attachments, mirrorCtx: /group/.test(ctx?.chatType ?? '') ? ctx : null });
  await appendTurn(wsId, r.slug, { userMsg: r.msg, reply: turn.reply, handover: turn.handover, sessionId: turn.sessionId, attachments });
  // cc 크루에게 맥락 공유 — 실행은 to 크루만(폭주 방지), 나머지는 다음 턴에 이 맥락을 알고 시작한다
  let footer = '';
  if (r.cc?.length) {
    const note = pick(
      `(참조 공유) 사장이 ${r.name}에게 지시: ${r.msg}\n\n${r.name}의 답변:\n${String(turn.reply).slice(0, 2000)}`,
      `(Shared context) The owner instructed ${r.name}: ${r.msg}\n\n${r.name}'s reply:\n${String(turn.reply).slice(0, 2000)}`,
      lang,
    );
    const shared = [];
    for (const c of r.cc.slice(0, 3)) {
      try { await appendSharedNote(wsId, c.slug, note); shared.push(c.name); } catch { /* 공유 실패는 본답변을 막지 않는다 */ }
    }
    if (shared.length) footer = pick(
      `\n\n(참조 공유: ${shared.join(', ')} — 다음 대화부터 이 맥락을 알고 시작합니다)`,
      `\n\n(Shared with: ${shared.join(', ')} — they'll start the next conversation aware of this context)`,
      lang,
    );
  }
  return `[${r.name}]\n${turn.reply}${footer}`;
}

/* ─── 텔레그램 — long-poll. 첫 발신자가 회사와 페어링되고 이후 그 채팅만 듣는다. ─── */
function startTelegram(wsId, getCfg) {
  let stopped = false;
  let offset = 0;
  const KEY = 'telegram';
  // 앨범(media_group) 버퍼 — 여러 장이 개별 업데이트로 나뉘어 오므로 2초 모아 한 턴으로 처리
  const albums = new Map(); // groupId → { atts, caption, timer }
  // 잡 실행은 매니저 소유의 큐 워커(makeTgGatewayHandler)가 맡는다 — 폴러는 적재만.
  // 워커를 폴러에서 분리해, 리더를 양보한 뒤에도 이 기기에 남은 잡이 계속 드레인된다.
  (async () => {
    console.log(`[argo] 텔레그램 게이트웨이 시작: ${wsId}`);
    offset = await loadOffset(wsId, KEY); // 재시작 이어받기
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.enabled || !cfg.token) break;
      try {
        const updates = await tg(cfg.token, 'getUpdates', { offset, timeout: 25 });
        await beatGateway(wsId, KEY, true);
        for (const u of updates) {
          if (stopped) break;

          if (u.callback_query) { // 결재 인라인 버튼
            const cq = u.callback_query;
            const m = String(cq.data ?? '').match(/^ap:(ap-[a-z0-9]+):([01])$/);
            // 채팅 일치 + (페어링된 사장 본인일 때만). 그룹 페어링 시 아무 멤버나 결재를 확정하는 것을 막는다.
            const bySender = !cfg.ownerId || String(cq.from?.id) === String(cfg.ownerId);
            if (m && String(cq.message?.chat?.id) === String(cfg.chatId) && bySender) {
              const approve = m[2] === '1';
              const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
              try {
                const item = await resolveWithFollowUp(wsId, m[1], approve);
                await tg(cfg.token, 'answerCallbackQuery', { callback_query_id: cq.id, text: pick(approve ? '승인됨' : '거절됨', approve ? 'Approved' : 'Rejected', lang) });
                // 원 메시지를 결과로 교체 — 버튼이 함께 사라져 이중 클릭·죽은 버튼이 없다(결재 UX)
                await tg(cfg.token, 'editMessageText', {
                  chat_id: cfg.chatId, message_id: cq.message.message_id,
                  text: pick(`${approve ? '✅ 결재 승인' : '❌ 결재 거절'} — ${item.action}\n담당 크루가 이어서 보고합니다.`, `${approve ? '✅ Approved' : '❌ Rejected'} — ${item.action}\nThe assigned crew will follow up.`, lang),
                }).catch(() => {});
              } catch (e) {
                await tg(cfg.token, 'answerCallbackQuery', { callback_query_id: cq.id, text: String(e.message).slice(0, 60) }).catch(() => {});
                // 이미 처리된 결재 등 — 죽은 버튼만 걷어낸다(재클릭 오류 반복 방지)
                await tg(cfg.token, 'editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
              }
            }
            continue;
          }

          const msg = u.message;
          if (!msg || (!msg.text && !msg.photo && !msg.document && !msg.video && !msg.voice && !msg.audio)) continue;
          if (!cfg.chatId) { // 페어링 — 설정에 표시된 코드를 보낸 사람만 사장으로 고정(TOFU 차단)
            const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
            const sent = String(msg.text ?? '').trim().toUpperCase();
            if (!cfg.pairCode || sent !== cfg.pairCode) {
              // 코드 불일치 — 아무나 먼저 말 걸어도 소유권을 못 가져간다. 안내만 보낸다.
              await tg(cfg.token, 'sendMessage', { chat_id: msg.chat.id, text: pick('이 봇을 회사와 연결하려면, 설정 → 연결에 표시된 6자리 연결 코드를 여기에 보내주세요.', 'To connect this bot to your company, send the 6-digit connection code shown in Settings → Connections here.', lang) }).catch(() => {});
              continue;
            }
            // 코드 일치 — 소유자 고정 + 코드 소비(재사용 방지)
            await updateConnection(wsId, 'telegram', { chatId: String(msg.chat.id), ownerId: msg.from?.id ?? null, pairCode: '' });
            Object.assign(cfg, { chatId: String(msg.chat.id), ownerId: msg.from?.id ?? null, pairCode: '' });
            await appendEvent(wsId, { type: 'gateway', kind: 'telegram', op: 'paired' });
            await tg(cfg.token, 'sendMessage', { chat_id: msg.chat.id, text: pick('연결 코드 확인 — 이 채팅이 회사와 연결되었습니다.\n"@크루이름 지시" 또는 그냥 지시를 보내면 기본 크루가 응답합니다.\n"@이름1 @이름2 지시"는 첫 크루가 실행하고 나머지에게 맥락을 공유(cc)합니다.\n"크루"라고 보내면 연결된 크루 현황을 보여드립니다.', 'Code confirmed — this chat is now connected to your company.\nSend "@crewname instruction" or just an instruction and the default crew responds.\n"@name1 @name2 instruction" — the first crew acts and shares context (cc) with the rest.\nSend "crew" to see the connected crew roster.', lang) });
            continue;
          }
          if (String(msg.chat.id) !== String(cfg.chatId)) continue; // 페어링된 채팅만
          // 발신자도 사장이어야 함 — 그룹에 봇을 초대해도 아무 멤버가 크루 구동·텍스트 결재를
          // 하지 못하게(콜백 버튼·크루 직통 봇과 동일 인가). ownerId 없으면(구 페어링) 통과.
          if (cfg.ownerId && String(msg.from?.id) !== String(cfg.ownerId)) continue;
          tg(cfg.token, 'sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {});

          // 미디어 수신 — 다운로드해 vault/files/로. 앨범은 2초 버퍼로 모아 한 턴.
          if (msg.photo || msg.document || msg.video || msg.voice || msg.audio) {
            let att = null;
            try {
              att = await tgDownload(cfg.token, wsId, msg);
            } catch (e) {
              const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
              await tg(cfg.token, 'sendMessage', { chat_id: cfg.chatId, text: pick(`첨부 수신 실패: ${String(e.message).slice(0, 150)}`, `Attachment failed: ${String(e.message).slice(0, 150)}`, lang) }).catch(() => {});
              continue;
            }
            if (!att) continue;
            if (msg.media_group_id) {
              const key = `${msg.chat.id}:${msg.media_group_id}`;
              const g = albums.get(key) ?? { atts: [], caption: '' };
              g.atts.push(att);
              if (msg.caption) g.caption = msg.caption;
              g.ctx = { chatId: msg.chat.id, chatType: msg.chat.type };
              clearTimeout(g.timer);
              // 앨범은 2초 버퍼 후 한 잡으로 적재(파일명=앨범id, 멱등). 버퍼 중 크래시하면 앨범은 유실(첨부 한정, 기존과 동일 베스트에포트).
              g.timer = setTimeout(() => { albums.delete(key); enqueueJob(wsId, KEY, `alb-${msg.media_group_id}`, { text: g.caption, atts: g.atts, ctx: g.ctx }).catch(() => {}); }, 2000);
              albums.set(key, g);
            } else {
              await enqueueJob(wsId, KEY, u.update_id, { text: msg.caption ?? '', atts: [att], ctx: { chatId: msg.chat.id, chatType: msg.chat.type } });
            }
            continue;
          }

          // 큐에 적재만 하고 턴은 기다리지 않는다 — 기다리면 폴이 멈춰 결재 버튼 콜백을 못 받는다(권한 게이트 데드락)
          await enqueueJob(wsId, KEY, u.update_id, { text: msg.text, atts: [], ctx: { chatId: msg.chat.id, chatType: msg.chat.type } });
        }
        // 이번 배치를 디스크 큐에 다 적재한 뒤에만 offset 전진 — 적재 전 크래시면 재수신·재처리(at-least-once).
        // 중단 중이면 전진하지 않는다(미적재분을 다음 리더가 다시 받도록).
        if (!stopped && updates.length) { offset = updates[updates.length - 1].update_id + 1; await saveOffset(wsId, KEY, offset); }
      } catch (e) {
        if (!stopped) {
          const hint = /Conflict/.test(String(e.message)) ? ' — 같은 토큰을 다른 인스턴스가 폴링 중일 수 있음' : '';
          console.error(`[argo] 텔레그램 폴 오류(${wsId}):`, e.message, hint);
          await beatGateway(wsId, KEY, false, e.message);
          await new Promise((r) => setTimeout(r, 5000)); // 잘못된 토큰·네트워크 단절에도 루프는 살아있는다
        }
      }
    }
    console.log(`[argo] 텔레그램 게이트웨이 종료: ${wsId}`);
  })();
  return () => { stopped = true; };
}

/* ─── 크루 직통 봇 — 크루 1명 = 봇 1개(연락처처럼). DM은 1:1(웹과 같은 스레드),
   그룹에 초대하면 @멘션·답장이 그 크루에게 전달된다(텔레그램 기본 프라이버시 모드가 멘션만 전달 → 폭주 없음). ─── */
async function runAgentTurn(wsId, slug, text, attachments, ctx) {
  const ap = text.match(/^(승인|거절)\s+(ap-[a-z0-9]+)/); // 결재 토큰(승인/거절)은 파서 앵커라 고정
  if (ap) {
    const approve = ap[1] === '승인';
    const item = await resolveWithFollowUp(wsId, ap[2], approve);
    const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
    return pick(
      `결재 ${ap[1]} 처리: ${item.action}\n실행 결과는 이어서 보고합니다.`,
      `Approval ${approve ? 'approved' : 'rejected'}: ${item.action}\nThe result will follow.`,
      lang,
    );
  }
  const t = await loadThread(wsId, slug);
  const turn = await chat(wsId, slug, text, t.sessionId, { source: 'messenger', attachments, mirrorCtx: /group/.test(ctx?.chatType ?? '') ? ctx : null });
  await appendTurn(wsId, slug, { userMsg: text, reply: turn.reply, handover: turn.handover, sessionId: turn.sessionId, attachments });
  return turn.reply; // 봇 자체가 그 크루 — 이름 프리픽스 불필요
}

/* ─── 큐 잡 핸들러(채널별) — 매니저 소유 워커가 잡을 실행할 때 쓴다. 턴 실패는 에러 회신으로
   내부 종결하고 정상 반환(잡 완료 처리 — 무한 재시도 방지). 던지는 건 인프라 예외뿐. ─── */
function makeTgGatewayHandler(wsId, getCfg) {
  return async (job) => {
    const cfg = getCfg();
    if (!cfg?.token || !cfg.chatId) return; // 연결이 사라짐 — 잡 폐기(재시도 불가)
    const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
    try {
      const atts = job.atts ?? [];
      const note = atts.some((a) => !a.isImage) ? pick('\n(이미지가 아닌 첨부는 vault 경로로 저장되어 있다)', '\n(Non-image attachments are saved under the vault path)', lang) : '';
      const reply = await runTurn(wsId, cfg, job.text || (pick('첨부한 파일을 확인하고 필요한 걸 처리해줘.', "Check the attached files and handle what's needed.", lang) + note), atts, job.ctx ?? null);
      await sendTgReply(cfg.token, cfg.chatId, wsId, reply);
    } catch (e) {
      await tg(cfg.token, 'sendMessage', { chat_id: cfg.chatId, text: pick(`처리 실패: ${String(e.message).slice(0, 200)}`, `Failed: ${String(e.message).slice(0, 200)}`, lang) }).catch(() => {});
    }
  };
}
function makeTgAgentHandler(wsId, slug, getCfg) {
  return async (job) => {
    const cfg = getCfg();
    if (!cfg?.token || !job.ctx?.chatId) return; // 연결/발화 위치 소실 — 잡 폐기
    const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
    try {
      const atts = job.atts ?? [];
      const note = atts.some((a) => !a.isImage) ? pick('\n(이미지가 아닌 첨부는 vault 경로로 저장되어 있다)', '\n(Non-image attachments are saved under the vault path)', lang) : '';
      const reply = await runAgentTurn(wsId, slug, job.text || (pick('첨부한 파일을 확인하고 필요한 걸 처리해줘.', "Check the attached files and handle what's needed.", lang) + note), atts, job.ctx);
      await sendTgReply(cfg.token, job.ctx.chatId, wsId, reply);
    } catch (e) {
      await tg(cfg.token, 'sendMessage', { chat_id: job.ctx.chatId, text: pick(`처리 실패: ${String(e.message).slice(0, 200)}`, `Failed: ${String(e.message).slice(0, 200)}`, lang) }).catch(() => {});
    }
  };
}
function makeSlackHandler(wsId, getCfg) {
  return async (job) => {
    const cfg = getCfg();
    if (!cfg?.token || !cfg.channel) return; // 연결이 사라짐 — 잡 폐기
    const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
    try {
      const reply = await runTurn(wsId, cfg, job.text);
      await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: clip(reply) });
    } catch (e) {
      await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: pick(`처리 실패: ${String(e.message).slice(0, 200)}`, `Failed: ${String(e.message).slice(0, 200)}`, lang) }).catch(() => {});
    }
  };
}

function startAgentTelegram(wsId, slug, getCfg) {
  let stopped = false;
  let offset = 0;
  const KEY = `tg-${slug}`;
  const albums = new Map();
  // 잡 실행은 매니저 소유의 큐 워커(makeTgAgentHandler)가 맡는다 — 폴러는 적재만(리더 전환에도 드레인 지속)
  (async () => {
    console.log(`[argo] 텔레그램 크루 봇 시작: ${wsId}/${slug}`);
    offset = await loadOffset(wsId, KEY); // 재시작 이어받기
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.token) break;
      try {
        const updates = await tg(cfg.token, 'getUpdates', { offset, timeout: 25 });
        await beatGateway(wsId, KEY, true);
        for (const u of updates) {
          if (stopped) break;
          const msg = u.message;
          if (!msg || (!msg.text && !msg.photo && !msg.document && !msg.video && !msg.voice && !msg.audio)) continue;
          const isDm = msg.chat.type === 'private';
          if (!cfg.ownerId) {
            if (!isDm) continue; // 페어링 전 그룹 메시지는 무시 — 먼저 DM으로 페어링
            const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
            const sent = String(msg.text ?? '').trim().toUpperCase();
            if (!cfg.pairCode || sent !== cfg.pairCode) { // 설정에 표시된 코드를 보낸 사람만 소유자(TOFU 차단)
              await tg(cfg.token, 'sendMessage', { chat_id: msg.chat.id, text: pick('이 크루 봇을 연결하려면, 설정 → 연결의 크루 봇 항목에 표시된 6자리 연결 코드를 여기에 보내주세요.', 'To connect this crew bot, send the 6-digit connection code shown under the crew-bot entry in Settings → Connections here.', lang) }).catch(() => {});
              continue;
            }
            await updateAgentBot(wsId, slug, { ownerId: msg.from.id, ownerChat: String(msg.chat.id), pairCode: '' });
            Object.assign(cfg, { ownerId: msg.from.id, ownerChat: String(msg.chat.id), pairCode: '' }); // sync 주기(10s) 전에도 즉시 반영
            await appendEvent(wsId, { type: 'gateway', kind: 'telegram', op: 'paired', slug });
            await tg(cfg.token, 'sendMessage', { chat_id: msg.chat.id, text: pick('연결 코드 확인 — 이 봇은 이 크루와의 1:1 직통입니다. 그대로 지시를 보내면 됩니다.\n그룹에 초대한 뒤 @멘션하거나 봇 메시지에 답장하면 그룹에서도 함께 일합니다.', 'Code confirmed — this bot is your 1:1 direct line to this crew. Just send instructions.\nInvite it to a group and @mention it (or reply to its messages) to work together there too.', lang) });
            continue;
          }
          if (msg.from?.id !== cfg.ownerId) continue; // 페어링한 사장만 (소규모 팀 허용은 후속)
          const ctx = { chatId: msg.chat.id, chatType: msg.chat.type };
          tg(cfg.token, 'sendChatAction', { chat_id: ctx.chatId, action: 'typing' }).catch(() => {});
          const strip = (s) => (cfg.botUsername ? s.replace(new RegExp(`@${cfg.botUsername.replace(/^@/, '')}`, 'gi'), '').trim() : s.trim());
          if (msg.photo || msg.document || msg.video || msg.voice || msg.audio) {
            let att = null;
            try {
              att = await tgDownload(cfg.token, wsId, msg);
            } catch (e) {
              const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
              await tg(cfg.token, 'sendMessage', { chat_id: ctx.chatId, text: pick(`첨부 수신 실패: ${String(e.message).slice(0, 150)}`, `Attachment failed: ${String(e.message).slice(0, 150)}`, lang) }).catch(() => {});
              continue;
            }
            if (!att) continue;
            if (msg.media_group_id) {
              const key = `${msg.chat.id}:${msg.media_group_id}`;
              const g = albums.get(key) ?? { atts: [], caption: '' };
              g.atts.push(att);
              if (msg.caption) g.caption = strip(msg.caption);
              g.ctx = ctx;
              clearTimeout(g.timer);
              g.timer = setTimeout(() => { albums.delete(key); enqueueJob(wsId, KEY, `alb-${msg.media_group_id}`, { text: g.caption, atts: g.atts, ctx: g.ctx }).catch(() => {}); }, 2000);
              albums.set(key, g);
            } else {
              await enqueueJob(wsId, KEY, u.update_id, { text: strip(msg.caption ?? ''), atts: [att], ctx });
            }
            continue;
          }
          await enqueueJob(wsId, KEY, u.update_id, { text: strip(msg.text), atts: [], ctx }); // 큐 적재만 — 폴은 계속 돈다
        }
        // 배치를 다 적재한 뒤에만 offset 전진(at-least-once). 중단 중이면 전진하지 않는다.
        if (!stopped && updates.length) { offset = updates[updates.length - 1].update_id + 1; await saveOffset(wsId, KEY, offset); }
      } catch (e) {
        if (!stopped) {
          const hint = /Conflict/.test(String(e.message)) ? ' — 같은 토큰을 다른 인스턴스가 폴링 중일 수 있음' : '';
          console.error(`[argo] 크루 봇 폴 오류(${wsId}/${slug}):`, e.message, hint);
          await beatGateway(wsId, KEY, false, e.message);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
    console.log(`[argo] 텔레그램 크루 봇 종료: ${wsId}/${slug}`);
  })();
  return () => { stopped = true; };
}

/* ─── 받은 서류함(inbox) — 폴더에 파일을 넣는 것이 곧 지시. 기본 크루가 읽고 처리해 보고한다. ─── */
const INBOX_MAX_INFLIGHT = 2; // 파일 여러 개를 한꺼번에 떨궈도 동시 크루 턴을 제한(비용 폭주 방지)
function startInboxWatcher(wsId) {
  let stopped = false;
  const busy = new Set();
  const iv = setInterval(async () => {
    if (stopped) return;
    try {
      const dir = join(paths(wsId).root, 'inbox');
      let names = [];
      try { names = await readdir(dir); } catch { return; }
      for (const n of names) {
        if (n.startsWith('.') || busy.has(n)) continue;
        if (busy.size >= INBOX_MAX_INFLIGHT) break; // 상한 도달 — 남은 파일은 다음 틱에 처리
        const fp = join(dir, n);
        const st = await stat(fp).catch(() => null);
        if (!st?.isFile() || Date.now() - st.mtimeMs < 5000) continue; // 아직 복사 중일 수 있다 — 5초 안정 후 처리
        busy.add(n);
        (async () => {
          try {
            const safe = n.replace(/[^\w.\-가-힣 ()]/g, '_').slice(-80);
            // 처리용 사본을 vault에 둔다(원본은 inbox에 유지). 파일명을 inbox명 기준으로 고정 — 실패 재시도 시 같은 경로에 덮어써 사본이 쌓이지 않는다.
            const rel = `files/inbox-${safe}`;
            await mkdir(join(paths(wsId).vault, 'files'), { recursive: true });
            await copyFile(fp, join(paths(wsId).vault, rel)); // 원본은 아직 옮기지 않는다 — 핸드오버 영속 성공 뒤에만 제거
            const ext = safe.split('.').pop()?.toLowerCase() ?? '';
            const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
            const att = { rel, name: safe, mime: isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : '', isImage };
            const cfg = (await loadConnections(wsId)).telegram;
            const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
            console.log(`[argo] 받은 서류함 처리 시작: ${wsId}/${safe}`);
            // runTurn 반환 = chat 핸드오버 + appendTurn(스레드) 영속 완료. 여기까지 와야 처리를 종결(원본 제거)한다.
            const reply = await runTurn(wsId, cfg, pick(`(받은 서류함) 사장이 inbox 폴더에 "${safe}" 파일을 넣었다. 내용을 확인하고 필요한 처리를 한 뒤 5줄 이내로 보고하라.`, `(Inbox) The owner dropped the file "${safe}" into the inbox folder. Review it, handle what's needed, then report back in 5 lines or fewer.`, lang), [att]);
            // 영속 성공 후에만 원본을 .done/으로 이동(재처리 종결). 실패 시 원본이 inbox에 남아 다음 틱에 재시도(at-least-once).
            const done = join(dir, '.done');
            await mkdir(done, { recursive: true });
            try {
              await rename(fp, join(done, `${Date.now().toString(36)}-${n}`));
            } catch {
              await unlink(fp).catch(() => {}); // 다른 마운트 등 rename 실패 시 — 최소한 원본은 제거해 무한 재처리 차단
            }
            if (cfg.enabled && cfg.token && cfg.chatId) { // 자리에 없어도 결과가 도착한다
              await sendTgReply(cfg.token, cfg.chatId, wsId, pick(`[받은 서류함] ${safe}\n\n${reply}`, `[Inbox] ${safe}\n\n${reply}`, lang)).catch(() => {});
            }
          } catch (e) {
            console.error(`[argo] inbox 처리 실패(${wsId}/${n}):`, e.message); // 원본을 inbox에 유지 → 다음 틱 재시도
          } finally {
            busy.delete(n);
          }
        })();
      }
    } catch { /* 감시 루프는 죽지 않는다 */ }
  }, 15_000);
  return () => { stopped = true; clearInterval(iv); };
}

/* ─── 슬랙 — 공개 URL 없이 동작하도록 conversations.history 폴링. 봇을 채널에 초대해야 한다.
   신뢰성: 커서(lastTs)를 영속·동기화해 재시작/크래시/리더 전환 후에도 다운타임 메시지를 이어받고,
   지시는 텔레그램과 같은 디스크 큐로 적재해 처리 중 크래시에도 유실되지 않는다(at-least-once).
   인가: 페어링 코드를 보낸 사람이 사장(ownerId)으로 고정되고 이후 사장만 크루 구동·결재한다
   (텔레그램과 동일 모델 — 페어링 전에는 어떤 지시도 실행하지 않고 안내만 한다). ─── */

/** 슬랙 수신 메시지 분류(순수) — 폴 루프가 이 결과대로 행동한다. (export: 회귀 테스트용)
    반환 kind: skip(봇/비텍스트/비사장) · pair(페어링 코드 일치 — 발신자가 사장으로 고정)
    · hint(미페어링 안내) · approval(결재 회신 — 큐를 거치지 않고 즉시) · turn(크루 턴 — 큐 적재) */
export function classifySlackMessage(cfg, m) {
  if (!m?.text || m.bot_id || m.user === cfg.botUserId || m.subtype) return { kind: 'skip' };
  const text = String(m.text).replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  if (!cfg.ownerId) { // 미페어링 — 코드를 보낸 사람만 사장으로 고정(TOFU 차단). 그 전엔 어떤 지시도 실행하지 않는다
    if (cfg.pairCode && text.toUpperCase() === cfg.pairCode) return { kind: 'pair', user: String(m.user) };
    return { kind: 'hint' };
  }
  if (String(m.user) !== String(cfg.ownerId)) return { kind: 'skip' }; // 사장만 — 채널 멤버 전원이 구동·결재하던 구멍 차단
  const ap = text.match(/^(승인|거절)\s+(ap-[a-z0-9]+)/); // 결재 토큰(승인/거절)은 파서 앵커라 고정
  if (ap) return { kind: 'approval', approve: ap[1] === '승인', id: ap[2] };
  return { kind: 'turn', text };
}

function startSlack(wsId, getCfg) {
  let stopped = false;
  let lastBeat = 0;
  let lastHint = 0; // 미페어링 안내 스로틀 — 채널을 시끄럽게 하지 않는다
  const KEY = 'slack';
  (async () => {
    console.log(`[argo] 슬랙 게이트웨이 시작: ${wsId}`);
    const cfg0 = getCfg();
    try {
      if (cfg0 && !cfg0.botUserId) {
        const auth = await slackApi(cfg0.token, 'auth.test');
        await updateConnection(wsId, 'slack', { botUserId: auth.user_id });
        Object.assign(cfg0, { botUserId: auth.user_id }); // 매니저 갱신(10s) 전에도 자기 메시지를 거른다
      }
    } catch (e) {
      console.error(`[argo] 슬랙 인증 실패(${wsId}):`, e.message);
    }
    // 레거시 보정 — 토큰은 있는데 미페어링·코드 없음(이 픽스 이전 설정) → 코드 발급해 설정 화면에 표시
    if (cfg0?.token && !cfg0.ownerId && !cfg0.pairCode) {
      try { const all = await updateConnection(wsId, 'slack', {}); Object.assign(cfg0, { pairCode: all.slack.pairCode }); }
      catch { /* 다음 기동에 재시도 */ }
    }
    // 커서 복원 — 최초(파일 없음)는 지금부터(과거 채널 이력 전체를 턴으로 돌리지 않는다), 이후는 이어받기
    let lastTs = (await loadSlackCursor(wsId)) ?? String(Date.now() / 1000);
    await saveSlackCursor(wsId, lastTs);
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.enabled || !cfg.token || !cfg.channel) break;
      try {
        // 다운타임 백로그까지 수집 — 슬랙은 신규→과거 순으로 페이지되므로 전부 모은 뒤 과거→신규로 처리.
        // 평시(4s 주기)엔 1페이지로 끝난다. 10페이지(1000개) 초과분은 로그를 남기고 생략(무한 재수신 방지).
        const msgs = [];
        let cursor = null;
        for (let p = 0; p < 10; p++) {
          const h = await slackApi(cfg.token, 'conversations.history', { channel: cfg.channel, oldest: lastTs, limit: 100, ...(cursor ? { cursor } : {}) });
          msgs.push(...(h.messages ?? []));
          cursor = h.has_more ? (h.response_metadata?.next_cursor || null) : null;
          if (!cursor) break;
          if (p === 9) console.warn(`[argo] 슬랙(${wsId}): 밀린 메시지 1000개 초과 — 초과분은 생략하고 최신부터 잇는다`);
        }
        if (Date.now() - lastBeat > 10_000) { lastBeat = Date.now(); await beatGateway(wsId, KEY, true); }
        msgs.reverse(); // 과거 → 신규
        let maxTs = lastTs;
        for (const m of msgs) {
          if (stopped) break;
          if (Number(m.ts) > Number(maxTs)) maxTs = m.ts;
          const c = classifySlackMessage(cfg, m);
          if (c.kind === 'skip') continue;
          if (c.kind === 'pair') { // 코드 일치 — 발신자를 사장으로 고정 + 코드 소비(재사용 방지)
            const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
            await updateConnection(wsId, 'slack', { ownerId: c.user, pairCode: '' });
            Object.assign(cfg, { ownerId: c.user, pairCode: '' });
            await appendEvent(wsId, { type: 'gateway', kind: 'slack', op: 'paired' });
            await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: pick('연결 코드 확인 — 이 코드를 보낸 분이 사장으로 고정되었습니다. 이제 사장만 크루 구동·결재를 할 수 있습니다.', 'Code confirmed — the sender is now locked in as the owner. Only the owner can run crew and approve requests.', lang) }).catch(() => {});
            lastTs = m.ts; await saveSlackCursor(wsId, m.ts); // 코드는 소비 완료 — 재기동 시 크루 턴으로 재적재되지 않게 즉시 전진
            continue;
          }
          if (c.kind === 'hint') { // 미페어링 — 실행하지 않고 페어링 안내만(10분 스로틀)
            if (Date.now() - lastHint > 600_000) {
              lastHint = Date.now();
              const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
              await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: pick('사장 인증이 필요합니다 — Argo 설정 → 연결(슬랙)에 표시된 6자리 연결 코드를 이 채널에 보내면, 보낸 분만 크루 구동·결재를 할 수 있게 됩니다.', 'Owner verification needed — post the 6-character pairing code from Argo Settings → Connections (Slack) in this channel. The sender becomes the owner who can run crew and approve requests.', lang) }).catch(() => {});
            }
            continue;
          }
          if (c.kind === 'approval') {
            // 결재 회신은 큐를 거치지 않고 즉시 — 결재 대기 턴들이 워커 슬롯을 다 점유해도 승인이 뚫린다
            // (텔레그램 인라인 버튼과 같은 위상). 커서 전진 전 크래시 시 재처리될 수 있으나 이미 처리된
            // 결재는 오류 회신으로 끝난다 — at-least-once, 유실 없음.
            const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
            try {
              const item = await resolveWithFollowUp(wsId, c.id, c.approve);
              await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: pick(`결재 ${c.approve ? '승인' : '거절'} 처리: ${item.action}\n담당 크루가 이어서 보고합니다.`, `Approval ${c.approve ? 'approved' : 'rejected'}: ${item.action}\nThe assigned crew will follow up.`, lang) }).catch(() => {});
            } catch (e) {
              await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: pick(`결재 처리 실패: ${String(e.message).slice(0, 150)}`, `Approval failed: ${String(e.message).slice(0, 150)}`, lang) }).catch(() => {});
            }
            continue;
          }
          // 크루 턴 — 디스크 큐 적재만(논블로킹). 실행·회신은 매니저 소유 워커가 뒤에서(크래시 시 재기동 재처리)
          await enqueueJob(wsId, KEY, String(m.ts).replace('.', '-'), { text: c.text });
        }
        // 배치를 큐에 다 적재한 뒤에만 커서 전진(at-least-once) — 적재 전 크래시면 재수신·재적재(파일명=ts라 멱등)
        if (!stopped && Number(maxTs) > Number(lastTs)) { lastTs = maxTs; await saveSlackCursor(wsId, lastTs); }
      } catch (e) {
        if (!stopped) {
          console.error(`[argo] 슬랙 폴 오류(${wsId}):`, e.message);
          await beatGateway(wsId, KEY, false, e.message);
        }
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    console.log(`[argo] 슬랙 게이트웨이 종료: ${wsId}`);
  })();
  return () => { stopped = true; };
}

/* ─── 알림 푸시 — 결재는 버튼과 함께, 루틴은 브리핑으로, 위임은 상대 크루 봇의 발화로 ─── */
/** 결재 주체 표기 — "크루명" 또는 "크루명 (위임자명 위임)". 누가 올린 결재인지 흐름을 보이게 한다. */
async function approvalWho(wsId, item, lang) {
  const agents = await listAgents(wsId).catch(() => []);
  const nameOf = (s) => agents.find((a) => a.slug === s)?.name ?? s;
  const base = nameOf(item.slug);
  return item.from ? (lang === 'en' ? `${base} (delegated by ${nameOf(item.from)})` : `${base} (${nameOf(item.from)} 위임)`) : base;
}

async function pushEvent(event) {
  const all = await loadConnections(event.wsId);
  const { lang = 'ko' } = await loadCompany(event.wsId).catch(() => ({}));
  const who = event.type === 'approval' ? await approvalWho(event.wsId, event.item, lang) : '';
  // 결재 처리 완료 — 어느 창구(웹·대화창·텔레그램·슬랙)에서 확정됐든 텔레그램 카드의 버튼을 걷어낸다.
  // 푸시 때 저장해 둔 tg:{chatId,messageId}가 있어야 어느 메시지를 편집할지 안다(웹 승인 시 버튼 잔존 갭 해소).
  if (event.type === 'approval_resolved') {
    const it = event.item;
    if (it?.tg?.messageId && all.telegram.token) {
      const label = it.status === 'expired'
        ? pick('⏳ 만료됨', '⏳ Expired', lang)
        : pick(it.status === 'approved' ? '✅ 결재 승인' : '❌ 결재 거절', it.status === 'approved' ? '✅ Approved' : '❌ Rejected', lang);
      await tg(all.telegram.token, 'editMessageText', {
        chat_id: it.tg.chatId, message_id: it.tg.messageId,
        text: pick(`${label} — ${it.action}\n담당 크루가 이어서 보고합니다.`, `${label} — ${it.action}\nThe assigned crew will follow up.`, lang),
      }).catch(() => { /* 이미 편집됐거나(텔레그램 버튼 직접 클릭 경로와 중복) 메시지 없음 — 무해 */ });
    }
    return;
  }
  // 위임 미러 — 그룹 대화 중 A가 B에게 위임하면, B의 봇이 같은 방에 자기 이름으로 결과를 올린다(크루 간 대화 가시화).
  if (event.type === 'delegate') {
    const ctx = event.ctx; // 위임 이벤트에 실려온 발화 위치 — 전역 맵 조회 없이 이 턴의 방으로만
    if (!ctx || !/group/.test(ctx.chatType ?? '')) return; // 그룹에서만 — DM엔 상대 봇이 없다
    const bot = all.telegram.agents?.[event.to];
    if (!bot?.token) return; // 상대가 봇이 없으면 위임 결과는 A의 답에 통합돼 있으니 생략
    await sendTgReply(bot.token, ctx.chatId, event.wsId, pick(`(${event.fromName}의 요청: ${String(event.task).replace(/\s+/g, ' ').slice(0, 80)})\n\n${event.reply}`, `(${event.fromName}'s request: ${String(event.task).replace(/\s+/g, ' ').slice(0, 80)})\n\n${event.reply}`, lang))
      .catch((e) => console.error('[argo] 위임 미러 실패:', e.message));
    return;
  }
  const t = all.telegram;
  if (t.enabled && t.token && t.chatId) {
    if (event.type === 'approval') {
      try {
        const res = await tg(t.token, 'sendMessage', {
          chat_id: t.chatId,
          text: pick(`결재 요청 · ${who}\n${event.item.action}\n\n사유: ${event.item.reason}`, `Approval request · ${who}\n${event.item.action}\n\nReason: ${event.item.reason}`, lang),
          reply_markup: { inline_keyboard: [[
            { text: pick('✅ 승인', '✅ Approve', lang), callback_data: `ap:${event.item.id}:1` },
            { text: pick('❌ 거절', '❌ Reject', lang), callback_data: `ap:${event.item.id}:0` },
          ]] },
        });
        // 메시지 참조를 결재에 저장 — 나중에 어느 창구에서 승인해도 이 카드의 버튼을 정리할 수 있다
        if (res?.message_id) await setApprovalMeta(event.wsId, event.item.id, { tg: { chatId: String(t.chatId), messageId: res.message_id } }).catch(() => {});
      } catch (e) { console.error('[argo] 텔레그램 결재 푸시 실패:', e.message); }
    }
    if (event.type === 'routine') {
      await sendTgReply(t.token, t.chatId, event.wsId, pick(`**[루틴] ${event.routine.title}${event.ok ? '' : ' (실패)'}**\n\n${event.reply}`, `**[Routine] ${event.routine.title}${event.ok ? '' : ' (failed)'}**\n\n${event.reply}`, lang))
        .catch((e) => console.error('[argo] 텔레그램 루틴 푸시 실패:', e.message));
    }
  }
  const s = all.slack;
  if (s.enabled && s.token && s.channel) {
    const text = event.type === 'approval'
      ? pick(
          `결재 요청 · ${who}: ${event.item.action}\n사유: ${event.item.reason}\n→ 이 채널에 "승인 ${event.item.id}" 또는 "거절 ${event.item.id}" 로 회신`,
          `Approval request · ${who}: ${event.item.action}\nReason: ${event.item.reason}\n→ Reply in this channel with "승인 ${event.item.id}" (approve) or "거절 ${event.item.id}" (reject)`,
          lang,
        )
      : pick(
          `[루틴] ${event.routine.title} ${event.ok ? '' : '(실패)'}\n${event.reply}`,
          `[Routine] ${event.routine.title} ${event.ok ? '' : '(failed)'}\n${event.reply}`,
          lang,
        );
    await slackApi(s.token, 'chat.postMessage', { channel: s.channel, text: clip(text) })
      .catch((e) => console.error('[argo] 슬랙 푸시 실패:', e.message));
  }
}

/* ─── 매니저 — 회사별 연결 설정을 지켜보며 폴러를 켜고 끈다 ─── */
export function ensureGateway() {
  if (globalThis.__argoGateway) return;
  globalThis.__argoGateway = true;
  const lease = daemonLease('gateway'); // Next 멀티 워커에서도 폴러 주체는 하나만(중복 폴 = 텔레그램 409)
  console.log('[argo] 메신저 게이트웨이 매니저 시작');
  // 기동 시 전 회사 스캐폴드 백필 — 웹/데스크톱 어느 채널로 켜도 표준 트리·기본 설정이 전역 보장된다
  import('./provision.mjs').then((m) => m.ensureAllScaffolds()).catch(() => {});

  const running = new Map();  // 폴러(클라우드 리더 전용) — `${wsId}:${kind}` → { stop, key }
  const drainers = new Map(); // 큐 드레인 워커(리더 무관·프로세스 리스만) — `${wsId}:${queueKey}` → stop
  // 푸시는 이벤트가 난 워커가 직접 보낸다(1회 발생 = 1회 발송, 충돌 없음). 리더 단일화는 폴러에만.
  onNotify(pushEvent);
  let wasLeader = false;
  const sync = async () => {
    const procLeader = lease.isLeader(); // 이 프로세스가 이 기기의 게이트웨이 주체인가(Next 멀티 워커 단일화)
    const leader = procLeader && isCloudLeader(); // 기기 간에도 폴러 주체는 하나(클라우드 리스)
    if (leader !== wasLeader) { // 리더십 전환은 반드시 로그 — "폴러가 왜 안 도나" 1차 단서
      console.log(`[argo] 게이트웨이 리더 ${leader ? '획득' : '양보'} (pid ${process.pid})`);
      wasLeader = leader;
    }
    if (!procLeader) { // 데몬 주체가 아님 — 폴러·워커 모두 내린다(이 기기의 리스 소유 프로세스가 맡는다)
      for (const [id, cur] of running) { cur.stop(); running.delete(id); }
      for (const [id, stop] of drainers) { stop(); drainers.delete(id); }
      return;
    }
    const companies = await listCompanies().catch(() => []);
    const loaded = [];
    for (const c of companies) {
      const all = await loadConnections(c.id).catch(() => null);
      if (all) loaded.push([c, all]);
    }
    // ── 큐 드레인 워커 — 클라우드 리더가 아니어도 돈다(백로그: 리더 전환 시 큐잉 지시 멈춤).
    //    잡은 적재한 기기에만 있으므로(큐 동기화 제외 + dev 태그) 기기 간 이중 실행이 없고, 턴 실행·회신은
    //    getUpdates와 달리 겹쳐도 충돌하지 않는다. 리더를 양보한 기기의 잔여 잡, 죽었다 살아난 기기의
    //    잡이 여기서 끝까지 처리된다.
    const aliveDrain = new Set();
    const cfgMap = (globalThis.__argoGwCfg ??= {});
    for (const [c, all] of loaded) {
      // cfg 맵은 폴러뿐 아니라 드레인 핸들러도 본다 — 리더 여부와 무관하게 항상 최신화
      cfgMap[`${c.id}:telegram`] = all.telegram;
      cfgMap[`${c.id}:slack`] = all.slack;
      for (const [slug, bot] of Object.entries(all.telegram.agents ?? {})) cfgMap[`${c.id}:tg-agent:${slug}`] = bot;
      const qkeys = new Set(['telegram', 'slack', ...Object.keys(all.telegram.agents ?? {}).map((s) => `tg-${s}`)]);
      // 설정이 사라진 잔여 큐 디렉터리도 대상 — 핸들러가 cfg 부재 잡을 폐기해 스스로 청소된다
      try {
        for (const n of await readdir(paths(c.id).root)) if (n.startsWith('.gw-queue-')) qkeys.add(n.slice('.gw-queue-'.length));
      } catch { /* 루트 없음 — 새 회사 */ }
      for (const qkey of qkeys) {
        const id = `${c.id}:${qkey}`;
        aliveDrain.add(id);
        if (drainers.has(id)) continue;
        const handler = qkey === 'telegram' ? makeTgGatewayHandler(c.id, () => globalThis.__argoGwCfg?.[`${c.id}:telegram`])
          : qkey === 'slack' ? makeSlackHandler(c.id, () => globalThis.__argoGwCfg?.[`${c.id}:slack`])
            : qkey.startsWith('tg-') ? makeTgAgentHandler(c.id, qkey.slice(3), () => globalThis.__argoGwCfg?.[`${c.id}:tg-agent:${qkey.slice(3)}`])
              : null;
        if (handler) drainers.set(id, startQueueWorker(c.id, qkey, handler));
      }
    }
    for (const [id, stop] of drainers) if (!aliveDrain.has(id)) { stop(); drainers.delete(id); }
    if (!leader) { // 클라우드 리더가 아니면 폴러만 내린다 — 드레인 워커는 위에서 유지(잔여 잡 처리)
      for (const [id, cur] of running) { cur.stop(); running.delete(id); }
      return;
    }
    const alive = new Set();
    // 텔레그램 토큰 클레임 — 토큰당 폴러 1개(getUpdates Conflict). 저장 가드(connections.mjs
    // findTelegramTokenUse)가 신규 중복을 막지만, 기존 데이터·동기화 유입 중복은 여기서 한쪽만
    // 기동한다. 1패스: 회사 게이트웨이가 전 회사에 걸쳐 선클레임(모든 크루를 @멘션으로 부르는
    // 상위 기능이라 우선). 2패스: 기동 — 밀린 쪽은 하트비트에 이유를 남겨 카드에서 보이게 한다.
    const claimedTg = new Map(); // token → { id, label }
    for (const [c, all] of loaded) {
      const t = all.telegram;
      if (t.enabled && t.token && !claimedTg.has(t.token)) {
        claimedTg.set(t.token, { id: `${c.id}:telegram`, label: `회사(${c.id})의 텔레그램 연결(설정)` });
      }
    }
    for (const [c, all] of loaded) {
      for (const kind of ['telegram', 'slack']) {
        const cfg = all[kind];
        const id = `${c.id}:${kind}`;
        const key = `${cfg.enabled}:${cfg.token}:${cfg.channel ?? ''}`;
        const tgDupe = kind === 'telegram' && cfg.enabled && cfg.token && claimedTg.get(cfg.token)?.id !== id;
        if (tgDupe) { // 같은 토큰을 다른 회사 게이트웨이가 선점 — alive 미등록 → 아래 정리 루프가 폴러도 내린다
          beatGateway(c.id, 'telegram', false, `토큰 중복 — ${claimedTg.get(cfg.token).label}에서 사용 중. 텔레그램 봇은 한 곳에만 연결할 수 있습니다`).catch(() => {});
        } else if (cfg.enabled && cfg.token && (kind === 'telegram' || cfg.channel)) {
          alive.add(id);
          const cur = running.get(id);
          if (cur && cur.key === key) continue;
          cur?.stop();
          const getCfg = () => globalThis.__argoGwCfg?.[id];
          (globalThis.__argoGwCfg ??= {})[id] = cfg;
          running.set(id, { key, stop: kind === 'telegram' ? startTelegram(c.id, getCfg) : startSlack(c.id, getCfg) });
        }
        if (globalThis.__argoGwCfg) globalThis.__argoGwCfg[id] = cfg;
      }
      // 받은 서류함 감시 — 회사마다 1개(리더만). 파일 드롭 = 지시
      {
        const id = `${c.id}:inbox`;
        alive.add(id);
        if (!running.has(id)) running.set(id, { key: 'v1', stop: startInboxWatcher(c.id) });
      }
      // 크루 직통 봇 — 토큰이 있으면 곧 연결(별도 토글 없음: 연결 해제 = 토큰 제거)
      for (const [slug, bot] of Object.entries(all.telegram.agents ?? {})) {
        if (!bot?.token) continue;
        const id = `${c.id}:tg-agent:${slug}`;
        const holder = claimedTg.get(bot.token);
        if (holder && holder.id !== id) { // 게이트웨이 또는 다른 크루가 선점 — 이 직통 봇은 쉰다
          beatGateway(c.id, `tg-${slug}`, false, `토큰 중복 — ${holder.label}에서 사용 중. 이 크루 전용 봇을 @BotFather로 새로 만들어 연결하세요`).catch(() => {});
          continue;
        }
        if (!holder) claimedTg.set(bot.token, { id, label: `크루 직통 봇(${slug})` });
        alive.add(id);
        (globalThis.__argoGwCfg ??= {})[id] = bot;
        const cur = running.get(id);
        if (cur && cur.key === bot.token) continue;
        cur?.stop();
        const getCfg = () => globalThis.__argoGwCfg?.[id];
        running.set(id, { key: bot.token, stop: startAgentTelegram(c.id, slug, getCfg) });
      }
    }
    for (const [id, cur] of running) {
      if (!alive.has(id)) { cur.stop(); running.delete(id); }
    }
  };
  sync().catch(() => {});
  setInterval(() => sync().catch((e) => console.error('[argo] 게이트웨이 sync 오류:', e.message)), 10_000);
}
