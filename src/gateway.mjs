// 메신저 게이트웨이 — 텔레그램/슬랙이 회사의 정문이 된다.
// 메신저에서 크루를 부르면 웹과 같은 chat 경로로 턴이 돌고(스레드·기억 공유),
// 결재는 버튼/회신으로 처리되며, 루틴 결과가 브리핑으로 밀려온다.
// 분해(2026-07-28): 네트워크·타이머 없이 테스트 가능한 로직은 src/gateway/ 하위 모듈로 —
//   persist(offset·커서·하트비트) · queue(디스크 큐·장시간 작업 적재) · protocol(순수 판정·파서) · routing(크루 라우팅).
// 이 파일은 폴러 오케스트레이션(타이머·fetch 루프)·핸들러·매니저만 남는다. 기존 임포터를 위한 facade 재수출 유지.
// listAgents — crewmail 브리핑이 crew slug를 사람 이름으로 바꾸는 데 쓴다(nameOf, 아래 crewmail 분기).
// 임포트가 빠져 있어 그 분기가 매번 ReferenceError로 죽었고 notify.mjs의 .catch가 삼켜 **무음 실패**였다
// — 크루 쪽지 텔레그램 브리핑이 100% 안 갔다(전수 검사 2026-07-30 발견). 테스트가 못 잡은 이유는
// crewmail.test.mjs가 핸들러를 실행하지 않고 소스 문자열만 정규식으로 대조했기 때문이다.
import { listCompanies, listAgents } from './hub.mjs';
import { loadConnections, updateConnection, updateAgentBot } from './connections.mjs';
import { chat } from './chat.mjs';
import { loadThread, appendTurn, appendSharedNote } from './thread.mjs';
import { resolveWithFollowUp } from './approval-actions.mjs';
import { setApprovalMeta } from './approvals.mjs';
import { onNotify, emitNotify } from './notify.mjs'; // emitNotify = 장시간 작업 완료 통지(잡 핸들러)
import { daemonLease } from './lock.mjs';
import { isCloudLeader } from './sync.mjs';
import { appendEvent } from './events.mjs';
import { writeJsonAtomic } from './jsonstore.mjs';
import { mkdir, readFile, writeFile, readdir, stat, rename, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { mdToTelegramHtml, splitForTelegram, extractFileRefs, isImagePath, attachFailureNote } from './tg-format.mjs';
import { beatGateway, loadOffset, saveOffset, loadSlackCursor, saveSlackCursor } from './gateway/persist.mjs';
import { queueDir, enqueueJob, startQueueWorker, JOBS_QUEUE, JOBS_MAX_INFLIGHT } from './gateway/queue.mjs';
import { clip, pollBackoffMs, pick, tidy, parseApprovalText, parseApprovalCallback, pairCodeMatches, classifySlackMessage, telegramBriefingDest } from './gateway/protocol.mjs';
import { routeMessage, crewStatusReply, approvalWho, defaultCrew } from './gateway/routing.mjs';
import { channelSends } from './channel-events.mjs'; // 판정 정본 — 테스트도 같은 함수를 본다

// facade — 기존 임포터(chat.mjs 동적 import·테스트)가 gateway.mjs에서 그대로 가져간다(무수정 계약).
export { queueDir, enqueueJob, startQueueWorker, JOBS_QUEUE, JOBS_MAX_INFLIGHT, JOBS_MAX_PENDING, enqueueLongJob } from './gateway/queue.mjs';
export { classifySlackMessage } from './gateway/protocol.mjs';
export { routeMessage } from './gateway/routing.mjs';

/* ─── 장시간 작업(jobs) 실행 핸들러 — 큐 설계·재실행 규칙(tries) 주석은 src/gateway/queue.mjs.
   chat을 턴 밖에서 끝까지 돌리고 결과를 대화·메신저로 배달한다. ─── */
function makeJobHandler(wsId) {
  return async (job) => {
    const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
    const title = String(job.title ?? '').slice(0, 80) || pick('장시간 작업', 'Long task', lang);
    const slug = job.slug;
    if (!slug || !job.prompt) return; // 형식 불량 — 조용히 폐기(워커가 파일 삭제)
    // 핸들러가 던지면 워커가 파일을 남겨 1초마다 무한 재시도한다(E2E에서 실측: import 누락 1건으로
    // 24회/25초 재처리). 잡은 재실행이 위험하므로 통지·기록 실패가 재시도를 유발하지 않게 전부 감싼다.
    const notify = (payload) => { try { emitNotify(payload); } catch (e) { console.error('[argo] 작업 통지 실패:', e.message); } };
    // 재실행 차단 — 이미 한 번 시작된 잡(크래시·강제 종료 후 잔재)은 자동으로 다시 돌리지 않는다
    if ((job.tries ?? 0) >= 1) {
      await appendEvent(wsId, { type: 'job', slug, title, status: 'interrupted' }).catch(() => {});
      notify({ type: 'job', wsId, slug, title, ok: false, reply: pick(
        `작업 "${title}"이 실행 중 중단됐습니다 — 부작용이 있을 수 있어 자동으로 다시 시작하지 않았습니다. 다시 시킬지 알려주세요.`,
        `Task "${title}" was interrupted mid-run — it was not restarted automatically because it may have side effects. Tell me if you want it rerun.`, lang) });
      return;
    }
    // 시작 마킹 — **실행 전에** 파일에 기록해야 크래시 후 재집힘에서 위 가드가 작동한다
    const fp = join(queueDir(wsId, JOBS_QUEUE), `${job.id}.json`);
    await writeJsonAtomic(fp, { ...job, tries: (job.tries ?? 0) + 1, startedAt: new Date().toISOString() }).catch(() => {});
    await appendEvent(wsId, { type: 'job', slug, title, status: 'started' }).catch(() => {});
    try {
      const t = await chat(wsId, slug, `[장시간 작업: ${title}] ${job.prompt}`, null, { source: 'job' });
      await appendTurn(wsId, slug, {
        userMsg: pick(`(장시간 작업) ${title}`, `(Long task) ${title}`, lang),
        reply: t.reply, handover: t.handover, sessionId: t.sessionId, via: 'job', artifacts: t.artifacts,
      }).catch(() => {});
      await appendEvent(wsId, { type: 'job', slug, title, status: 'done' }).catch(() => {});
      notify({ type: 'job', wsId, slug, title, ok: true, reply: t.reply });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      await appendEvent(wsId, { type: 'job', slug, title, status: 'failed', error: msg }).catch(() => {});
      notify({ type: 'job', wsId, slug, title, ok: false, reply: pick(
        `작업 "${title}" 실패: ${msg}`, `Task "${title}" failed: ${msg}`, lang) });
    }
  };
}

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
  // 파일 동봉 — 실패는 본문 전달을 막지 않되 **침묵하지 않는다**(제보 "보내줬다는데 안 온다"의
  // 절반이 여기서 조용히 죽은 것: catch{} 전량 삼킴 + res.ok 미검사). 봇 업로드 상한 50MB 사전 검사.
  const fails = [];
  const refs = extractFileRefs(text);
  const { lang: gLang = 'ko' } = refs.length ? await loadCompany(wsId).catch(() => ({})) : {};
  const rsn = (ko, en) => (gLang === 'en' ? en : ko); // 사유도 회사 언어로(다국어 상시 규칙 — 검수 LOW-1)
  for (const rel of refs) {
    const name = rel.split('/').pop();
    try {
      const abs = join(paths(wsId).vault, rel);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) { fails.push({ name, reason: rsn('파일이 없습니다(경로 확인)', 'file not found (check the path)') }); continue; }
      if (st.size > 50 * 1024 * 1024) { fails.push({ name, reason: rsn('50MB 초과(텔레그램 봇 상한)', 'over 50MB (Telegram bot limit)') }); continue; }
      const buf = await readFile(abs);
      const send = (kind) => {
        const fd = new FormData();
        fd.append('chat_id', String(chatId));
        fd.append(kind, new Blob([buf]), name);
        return fetch(`https://api.telegram.org/bot${token}/${kind === 'photo' ? 'sendPhoto' : 'sendDocument'}`, {
          method: 'POST', body: fd, signal: AbortSignal.timeout(60_000),
        });
      };
      let res = await send(isImagePath(rel) ? 'photo' : 'document');
      // 사진 거절(10MB 상한·규격 제약)은 문서로 1회 폴백 — 원본 그대로는 전달된다
      if (!res.ok && isImagePath(rel)) res = await send('document');
      if (!res.ok) {
        const detail = await res.json().then((j) => j?.description ?? '').catch(() => '');
        fails.push({ name, reason: rsn(`텔레그램 거절(${String(detail).slice(0, 80) || res.status})`, `Telegram rejected (${String(detail).slice(0, 80) || res.status})`) });
      }
    } catch (e) {
      fails.push({ name, reason: String(e?.message ?? e).slice(0, 80) });
    }
  }
  if (fails.length) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: attachFailureNote(fails, gLang) }).catch(() => {});
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

/** 메신저발 지시 1턴 — 웹과 동일 경로(스레드 이어쓰기 + vault 기억 + 첨부 비전). ctx = 발화 위치(위임 미러용). */
async function runTurn(wsId, cfg, text, attachments = [], ctx = null) {
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  // "승인 ap-xxx" / "거절 ap-xxx" 텍스트 결재 (슬랙·텔레그램 공용) — 파서는 protocol.parseApprovalText(앵커 동일)
  const ap = parseApprovalText(text);
  if (ap) {
    const approve = ap.approve;
    const item = await resolveWithFollowUp(wsId, ap.id, approve);
    return pick(
      `결재 ${ap.verb} 처리: ${tidy(item.action)}\n실행 결과는 담당 크루가 이어서 보고합니다.`,
      `Approval ${approve ? 'approved' : 'rejected'}: ${tidy(item.action)}\nThe assigned crew will follow up with the result.`,
      lang,
    );
  }
  if (/^\/?(크루|현황|crew|status)$/i.test(text.trim())) return crewStatusReply(wsId, cfg);
  const r = await routeMessage(wsId, cfg, text);
  if (r.error) return r.error;
  const t = await loadThread(wsId, r.slug);
  // 그룹에서 온 턴이면 mirrorCtx로 전달 — 위임 미러가 이 턴의 방으로만 발화(전역 맵 오배달 제거)
  const turn = await chat(wsId, r.slug, r.msg, t.sessionId, { source: 'messenger', attachments, mirrorCtx: /group/.test(ctx?.chatType ?? '') ? ctx : null });
  await appendTurn(wsId, r.slug, { userMsg: r.msg, reply: turn.reply, handover: turn.handover, sessionId: turn.sessionId, attachments, artifacts: turn.artifacts });
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
  // 크루 이름 접두([페퍼]) 제거 — 1:1 봇 대화에서 중복 표기(유건 지시 2026-07-25). 어느 크루의 답인지는
  // 봇 이름·@호출 문맥이 이미 말해준다.
  const body = `${turn.reply ?? ''}${footer}`;
  // 빈 응답 가드(사후 검수 LOW-6) — 접두 제거로 non-empty 보장이 사라졌다. 빈 텍스트는 텔레그램 400 →
  // 침묵 유실(사용자는 아무 응답도 못 받음)이 되므로 정직한 안내로 대체한다.
  if (!body.trim()) {
    return pick('크루가 빈 응답을 보냈습니다 — 같은 지시를 한 번 더 보내주세요.', 'The crew returned an empty reply — please resend the instruction.', lang);
  }
  return body;
}

/** 결재 인라인 버튼 콜백 처리 — 회사 게이트웨이·크루 직통 봇 폴러 공용(단일 원천 — 한쪽은 규칙,
    한쪽은 사본이면 사본이 반드시 낡는다). 허용 조건: 형식 일치 + 카드가 있는 페어링 채팅 +
    페어링된 사장 본인(ownerId 없는 구 페어링은 통과 — 회사 게이트웨이 기존 관용 유지).
    그룹 페어링 시 아무 멤버나 결재를 확정하는 것을 막는다. */
async function handleApprovalCallback(wsId, token, cq, { chatId, ownerId }) {
  const m = parseApprovalCallback(cq.data); // "ap:<id>:<0|1>" — 형식 밖이면 null(무시). 파서는 protocol
  const bySender = !ownerId || String(cq.from?.id) === String(ownerId);
  // chatId·cq.message.chat 존재를 명시 요구 — 양쪽이 다 없으면 String(undefined) 동등으로 게이트가
  // 열리고(fail-open), 아래 cq.message.chat 접근이 던져 폴러 offset이 영구 오염된다(분리 검수 MEDIUM-1 실측:
  // 미페어링 cfg + 메시지 없는 콜백에서 타인 승인 확정 + 같은 업데이트 무한 재수신).
  if (!m || !chatId || !cq.message?.chat || String(cq.message.chat.id) !== String(chatId) || !bySender) return;
  const approve = m.approve;
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  try {
    const item = await resolveWithFollowUp(wsId, m.id, approve);
    await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: pick(approve ? '승인됨' : '거절됨', approve ? 'Approved' : 'Rejected', lang) });
    // 원 메시지를 결과로 교체 — 버튼이 함께 사라져 이중 클릭·죽은 버튼이 없다(결재 UX)
    await tg(token, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text: pick(`${approve ? '✅ 결재 승인' : '❌ 결재 거절'} — ${tidy(item.action)}\n담당 크루가 이어서 보고합니다.`, `${approve ? '✅ Approved' : '❌ Rejected'} — ${tidy(item.action)}\nThe assigned crew will follow up.`, lang),
    }).catch(() => {});
  } catch (e) {
    await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: String(e.message).slice(0, 60) }).catch(() => {});
    // 이미 처리된 결재 등 — 죽은 버튼만 걷어낸다(재클릭 오류 반복 방지)
    await tg(token, 'editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
}
// 테스트 전용 — 폴 루프에 묻힌 처리라 행동 테스트가 태울 이음매가 없다(브리핑 폴백과 같은 사유)
export const _approvalCallbackForTest = handleApprovalCallback;

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
    let errStreak = 0; // 연속 폴 오류 — Conflict 등 지속 실패에 지수 백오프
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.enabled || !cfg.token) break;
      try {
        const updates = await tg(cfg.token, 'getUpdates', { offset, timeout: 25 });
        errStreak = 0;
        await beatGateway(wsId, KEY, true);
        for (const u of updates) {
          if (stopped) break;

          if (u.callback_query) { // 결재 인라인 버튼 — 처리는 크루 직통 봇 폴러와 공용(handleApprovalCallback)
            await handleApprovalCallback(wsId, cfg.token, u.callback_query, { chatId: cfg.chatId, ownerId: cfg.ownerId });
            continue;
          }

          const msg = u.message;
          if (!msg || (!msg.text && !msg.photo && !msg.document && !msg.video && !msg.voice && !msg.audio)) continue;
          if (!cfg.chatId) { // 페어링 — 설정에 표시된 코드를 보낸 사람만 사장으로 고정(TOFU 차단)
            const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
            if (!pairCodeMatches(cfg.pairCode, msg.text)) { // 판정은 protocol.pairCodeMatches — trim·대문자 정규화 동일
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
          errStreak += 1;
          const conflict = /Conflict/.test(String(e.message));
          const hint = conflict ? ' — 같은 토큰을 다른 인스턴스가 폴링 중일 수 있음(봇을 한 곳에만 연결하세요)' : '';
          const wait = pollBackoffMs(errStreak);
          console.error(`[argo] 텔레그램 폴 오류(${wsId}):`, e.message, hint, `(재시도 ${wait / 1000}s)`);
          await beatGateway(wsId, KEY, false, `${e.message}${hint}`);
          await new Promise((r) => setTimeout(r, wait)); // 지수 백오프 — 지속 Conflict 배틀 방지, 루프는 유지
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
  const ap = parseApprovalText(text); // 파서는 protocol.parseApprovalText — 결재 토큰(승인/거절) 앵커 동일
  if (ap) {
    const approve = ap.approve;
    const item = await resolveWithFollowUp(wsId, ap.id, approve);
    const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
    return pick(
      `결재 ${ap.verb} 처리: ${item.action}\n실행 결과는 이어서 보고합니다.`,
      `Approval ${approve ? 'approved' : 'rejected'}: ${item.action}\nThe result will follow.`,
      lang,
    );
  }
  const t = await loadThread(wsId, slug);
  const turn = await chat(wsId, slug, text, t.sessionId, { source: 'messenger', attachments, mirrorCtx: /group/.test(ctx?.chatType ?? '') ? ctx : null });
  await appendTurn(wsId, slug, { userMsg: text, reply: turn.reply, handover: turn.handover, sessionId: turn.sessionId, attachments, artifacts: turn.artifacts });
  return turn.reply; // 봇 자체가 그 크루 — 이름 프리픽스 불필요
}

/* ─── 큐 잡 핸들러(채널별) — 매니저 소유 워커가 잡을 실행할 때 쓴다. 턴 실패는 에러 회신으로
   내부 종결하고 정상 반환(잡 완료 처리 — 무한 재시도 방지). 던지는 건 인프라 예외뿐. ─── */
/* ─── 진행 표시 — 텔레그램 typing은 5초면 꺼진다 ───
   sendChatAction을 한 번만 보내면 긴 턴(수십 초~수 분)에서 "입력중…"이 즉시 사라져 사용자는 봇이
   죽은 줄 안다(실사용 요청 2026-07-26). 턴이 끝날 때까지 4초 주기로 갱신하고, 오래 걸리면 중간에
   한 번 진행 상황을 말로 알린다(무소식 구간 제거). stop()으로 반드시 정리한다. */
const TYPING_REFRESH_MS = 4_000;
const PROGRESS_NOTICE_MS = 90_000; // 이 시간을 넘기면 1회 안내(그 뒤로는 조용히 — 알림 폭주 방지)
function startTypingKeepalive(token, chatId, { lang = 'ko', notice = true, _send = null } = {}) {
  let stopped = false;
  const call = _send ?? ((method, body) => tg(token, method, body).catch(() => {})); // _send = 테스트 주입구
  const send = () => { if (!stopped) call('sendChatAction', { chat_id: chatId, action: 'typing' }); };
  send();
  const iv = setInterval(send, TYPING_REFRESH_MS);
  const noticeTimer = notice ? setTimeout(() => {
    if (stopped) return;
    call('sendMessage', {
      chat_id: chatId,
      text: pick('작업이 길어지고 있어요 — 계속 진행 중입니다. 끝나면 결과를 바로 보내드릴게요.',
        "This is taking a while — still working on it. I'll send the result as soon as it's done.", lang),
    });
  }, PROGRESS_NOTICE_MS) : null;
  return () => { stopped = true; clearInterval(iv); if (noticeTimer) clearTimeout(noticeTimer); };
}
// 테스트 전용 — 실 텔레그램 호출 없이 주기·정지 계약을 잠근다(프로덕션 경로는 위 두 워커).
export const _typingForTest = {
  start: (token, chatId, opts, sender) => startTypingKeepalive(token, chatId, { ...opts, _send: sender }),
  refreshMs: TYPING_REFRESH_MS,
  noticeMs: PROGRESS_NOTICE_MS,
};

function makeTgGatewayHandler(wsId, getCfg) {
  return async (job) => {
    const cfg = getCfg();
    if (!cfg?.token || !cfg.chatId) return; // 연결이 사라짐 — 잡 폐기(재시도 불가)
    const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
    const stopTyping = startTypingKeepalive(cfg.token, cfg.chatId, { lang });
    try {
      const atts = job.atts ?? [];
      const note = atts.some((a) => !a.isImage) ? pick('\n(이미지가 아닌 첨부는 vault 경로로 저장되어 있다)', '\n(Non-image attachments are saved under the vault path)', lang) : '';
      const reply = await runTurn(wsId, cfg, job.text || (pick('첨부한 파일을 확인하고 필요한 걸 처리해줘.', "Check the attached files and handle what's needed.", lang) + note), atts, job.ctx ?? null);
      stopTyping(); // 답변 전송 전에 멈춘다 — 보낸 뒤에도 "입력중"이 남으면 또 오해를 만든다
      await sendTgReply(cfg.token, cfg.chatId, wsId, reply);
    } catch (e) {
      await tg(cfg.token, 'sendMessage', { chat_id: cfg.chatId, text: pick(`처리 실패: ${String(e.message).slice(0, 200)}`, `Failed: ${String(e.message).slice(0, 200)}`, lang) }).catch(() => {});
    } finally {
      stopTyping(); // 중복 호출 무해(멱등) — 예외·조기 반환 경로에서도 타이머가 남지 않게
    }
  };
}
function makeTgAgentHandler(wsId, slug, getCfg) {
  return async (job) => {
    const cfg = getCfg();
    if (!cfg?.token || !job.ctx?.chatId) return; // 연결/발화 위치 소실 — 잡 폐기
    const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
    const stopTyping = startTypingKeepalive(cfg.token, job.ctx.chatId, { lang }); // 회사 봇과 동일 계약
    try {
      const atts = job.atts ?? [];
      const note = atts.some((a) => !a.isImage) ? pick('\n(이미지가 아닌 첨부는 vault 경로로 저장되어 있다)', '\n(Non-image attachments are saved under the vault path)', lang) : '';
      const reply = await runAgentTurn(wsId, slug, job.text || (pick('첨부한 파일을 확인하고 필요한 걸 처리해줘.', "Check the attached files and handle what's needed.", lang) + note), atts, job.ctx);
      stopTyping();
      await sendTgReply(cfg.token, job.ctx.chatId, wsId, reply);
    } catch (e) {
      await tg(cfg.token, 'sendMessage', { chat_id: job.ctx.chatId, text: pick(`처리 실패: ${String(e.message).slice(0, 200)}`, `Failed: ${String(e.message).slice(0, 200)}`, lang) }).catch(() => {});
    } finally {
      stopTyping();
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
    let errStreak = 0; // 연속 폴 오류 — Conflict 등 지속 실패에 지수 백오프
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.token) break;
      try {
        const updates = await tg(cfg.token, 'getUpdates', { offset, timeout: 25 });
        errStreak = 0;
        await beatGateway(wsId, KEY, true);
        for (const u of updates) {
          if (stopped) break;
          if (u.callback_query) { // 결재 인라인 버튼 — 게이트웨이 부재 시 폴백 카드(pushEvent approval)가 이 봇으로 온다.
            // 처리는 회사 게이트웨이와 공용(handleApprovalCallback). 카드는 페어링 DM(ownerChat)에만 실리므로 그 채팅으로 한정.
            await handleApprovalCallback(wsId, cfg.token, u.callback_query, { chatId: cfg.ownerChat, ownerId: cfg.ownerId });
            continue;
          }
          const msg = u.message;
          if (!msg || (!msg.text && !msg.photo && !msg.document && !msg.video && !msg.voice && !msg.audio)) continue;
          const isDm = msg.chat.type === 'private';
          if (!cfg.ownerId) {
            if (!isDm) continue; // 페어링 전 그룹 메시지는 무시 — 먼저 DM으로 페어링
            const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
            if (!pairCodeMatches(cfg.pairCode, msg.text)) { // 설정에 표시된 코드를 보낸 사람만 소유자(TOFU 차단) — 판정은 protocol
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
          const text = strip(msg.text);
          // 텍스트 결재("승인 ap-xxx")는 큐를 거치지 않고 즉시 — 결재 대기(권한 게이트) 턴들이 워커
          // 슬롯(동시 2)을 다 점유하면 큐에 실린 승인이 영영 안 돌아 교착이 된다(슬랙 approval 분기·
          // 인라인 버튼과 같은 위상). 재수신(at-least-once)은 '이미 처리된 결재' 오류 회신으로 끝난다 —
          // 이중 실행은 resolveApproval의 락이 막는다.
          const ap = parseApprovalText(text); // 파서는 protocol — 형식 밖이면 일반 지시(큐 적재)
          if (ap) {
            const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
            try {
              const item = await resolveWithFollowUp(wsId, ap.id, ap.approve);
              await tg(cfg.token, 'sendMessage', { chat_id: ctx.chatId, text: pick(`결재 ${ap.verb} 처리: ${tidy(item.action)}\n실행 결과는 이어서 보고합니다.`, `Approval ${ap.approve ? 'approved' : 'rejected'}: ${tidy(item.action)}\nThe result will follow.`, lang) })
                .catch((e) => console.error(`[argo] 결재 회신 발송 실패(${wsId}/${slug}):`, e.message)); // 확정은 됐다 — 회신 실패는 로그로(무음 금지, 분리 검수 LOW-2)
            } catch (e) {
              await tg(cfg.token, 'sendMessage', { chat_id: ctx.chatId, text: pick(`결재 처리 실패: ${String(e.message).slice(0, 150)}`, `Approval failed: ${String(e.message).slice(0, 150)}`, lang) })
                .catch((e2) => console.error(`[argo] 결재 회신 발송 실패(${wsId}/${slug}):`, e2.message));
            }
            continue;
          }
          await enqueueJob(wsId, KEY, u.update_id, { text, atts: [], ctx }); // 큐 적재만 — 폴은 계속 돈다
        }
        // 배치를 다 적재한 뒤에만 offset 전진(at-least-once). 중단 중이면 전진하지 않는다.
        if (!stopped && updates.length) { offset = updates[updates.length - 1].update_id + 1; await saveOffset(wsId, KEY, offset); }
      } catch (e) {
        if (!stopped) {
          errStreak += 1;
          const conflict = /Conflict/.test(String(e.message));
          const hint = conflict ? ' — 같은 토큰을 다른 인스턴스가 폴링 중일 수 있음(봇을 한 곳에만 연결하세요)' : '';
          const wait = pollBackoffMs(errStreak);
          console.error(`[argo] 크루 봇 폴 오류(${wsId}/${slug}):`, e.message, hint, `(재시도 ${wait / 1000}s)`);
          await beatGateway(wsId, KEY, false, `${e.message}${hint}`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    console.log(`[argo] 텔레그램 크루 봇 종료: ${wsId}/${slug}`);
  })();
  return () => { stopped = true; };
}

// 테스트 전용 — 폴러 루프의 콜백 배선(위 handleApprovalCallback 호출)은 실행해야만 보인다:
// 소스 문자열 단언은 분기가 도는지를 못 본다(listAgents 무음실패 실측 계열). fetch를 가로채 구동한다.
export const _startAgentTelegramForTest = startAgentTelegram;

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
            // 자리에 없어도 결과가 도착한다 — 단 끌 수 있어야 한다(설정의 'inbox' 종류). 게이트웨이가
            // 못 보내면(꺼짐·미페어링) **처리 크루의 직통 봇**으로 폴백 — 처리 크루 판정은 runTurn의
            // routeMessage와 같은 defaultCrew 정본(사본 금지). 브리핑 3종과 같은 telegramBriefingDest
            // 계약이라 음소거('inbox')도 폴백에서 그대로 존중된다(분리 검수 LOW-1 비대칭 해소).
            const agents = await listAgents(wsId).catch(() => []);
            const d = telegramBriefingDest(cfg, 'inbox', defaultCrew(agents, cfg)?.slug);
            if (d) {
              await sendTgReply(d.token, d.chatId, wsId, pick(`[받은 서류함] ${safe}\n\n${reply}`, `[Inbox] ${safe}\n\n${reply}`, lang)).catch(() => {});
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

// 수신 메시지 분류는 protocol.classifySlackMessage(순수) — 폴 루프가 그 결과대로 행동한다.
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

/* ─── 알림 푸시 — 결재는 버튼과 함께, 루틴은 브리핑으로, 위임은 상대 크루 봇의 발화로 ───
   결재 문구 정돈(tidy)은 protocol, 결재 주체 표기(approvalWho)는 routing에서 온다. */
async function pushEvent(event) {
  const all = await loadConnections(event.wsId);
  const { lang = 'ko' } = await loadCompany(event.wsId).catch(() => ({}));
  const who = event.type === 'approval' ? await approvalWho(event.wsId, event.item, lang) : '';
  // 결재 처리 완료 — 어느 창구(웹·대화창·텔레그램·슬랙)에서 확정됐든 텔레그램 카드의 버튼을 걷어낸다.
  // 푸시 때 저장해 둔 tg:{chatId,messageId}가 있어야 어느 메시지를 편집할지 안다(웹 승인 시 버튼 잔존 갭 해소).
  // 카드가 실린 봇의 토큰 — 직통 봇 폴백 카드(tg.botSlug, 푸시 때 setApprovalMeta로 귀속)면 그 봇
  // ("토큰 = 연결" — enabled 개념 없음), 아니면 회사 게이트웨이. 게이트웨이 카드의 후속(followup)만
  // enabled를 본다(끈 채널로 재발송 금지 — 검수 LOW-4).
  const approvalCardToken = (it, { needEnabled = false } = {}) => (it?.tg?.botSlug
    ? all.telegram.agents?.[it.tg.botSlug]?.token ?? null
    : (!needEnabled || all.telegram.enabled) ? all.telegram.token || null : null);
  if (event.type === 'approval_followup') {
    // 결재 승인/거절 후속 턴의 크루 보고를 결재 카드가 있던 방으로 — sendTgReply라서 본문 속
    // 파일 경로(files/·projects/)가 자동 첨부된다(S2). 발송류 결재의 "승인=발송"이 이걸로 실효.
    const it = event.item;
    const tok = approvalCardToken(it, { needEnabled: true });
    if (it?.tg?.chatId && tok) {
      await sendTgReply(tok, it.tg.chatId, event.wsId, event.reply).catch((e) => console.error('[argo] 결재 후속 배달 실패:', e.message));
    } else if (it?.tg?.chatId) {
      // 카드는 "이어서 보고합니다"를 약속했다 — 봇 토큰 소실(크루 삭제 등)·채널 꺼짐으로 못 보내면
      // 최소한 로그는 남긴다(무로그 증발 금지 — 분리 검수 LOW-1)
      console.error(`[argo] 결재 후속 미배달(${event.wsId}/${it.id ?? '?'}): 카드가 실린 채널의 토큰 없음(봇 제거 또는 게이트웨이 꺼짐)`);
    }
    return;
  }
  if (event.type === 'approval_resolved') {
    const it = event.item;
    const tok = approvalCardToken(it);
    if (it?.tg?.messageId && tok) {
      const label = it.status === 'expired'
        ? pick('⏳ 만료됨', '⏳ Expired', lang)
        : pick(it.status === 'approved' ? '✅ 결재 승인' : '❌ 결재 거절', it.status === 'approved' ? '✅ Approved' : '❌ Rejected', lang);
      await tg(tok, 'editMessageText', {
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
  // 채널별 알림 선택 — 판정 정본은 channel-events.mjs. 텔레그램은 목적지 판정이
  // telegramBriefingDest(내부에서 channelSends 호출)로 단일화됐고, 슬랙은 블록 머리에서 한 번 본다.
  const sends = (kind, ch) => channelSends(kind, ch, event.type);
  const t = all.telegram;
  // 결재 — 브리핑과 같은 목적지 판정: 게이트웨이 우선, 못 보내면 담당 크루(item.slug)의 직통 봇 폴백.
  // 폴백 버튼은 직통 봇 폴러의 handleApprovalCallback이 받는다(PR #305의 죽은 버튼 사유 해소).
  if (event.type === 'approval') {
    let dest = telegramBriefingDest(t, 'approval', event.item.slug);
    if (!dest) {
      // 최종 폴백 — 담당 크루의 봇이 없으면(선재 유령 slug 'crew' 포함 — 분리 검수 LOW-3, 봇 미페어링
      // 크루도 동일) 기본 크루 봇으로. inbox 폴백과 같은 계열(defaultCrew 정본 — 사본 금지)이고,
      // 음소거('approval')는 telegramBriefingDest 안의 channelSends가 여기서도 그대로 존중한다.
      const agents = await listAgents(event.wsId).catch(() => []);
      const def = defaultCrew(agents, t)?.slug;
      if (def && def !== event.item.slug) dest = telegramBriefingDest(t, 'approval', def);
    }
    if (dest) {
      try {
        const res = await tg(dest.token, 'sendMessage', {
          chat_id: dest.chatId,
          text: pick(`결재 요청 · ${who}\n${tidy(event.item.action)}\n\n사유: ${tidy(event.item.reason)}`, `Approval request · ${who}\n${tidy(event.item.action)}\n\nReason: ${tidy(event.item.reason)}`, lang),
          reply_markup: { inline_keyboard: [[
            { text: pick('✅ 승인', '✅ Approve', lang), callback_data: `ap:${event.item.id}:1` },
            { text: pick('❌ 거절', '❌ Reject', lang), callback_data: `ap:${event.item.id}:0` },
          ]] },
        });
        // 메시지 참조를 결재에 저장 — 나중에 어느 창구에서 승인해도 이 카드의 버튼을 정리할 수 있다.
        // botSlug = 카드가 실린 직통 봇 귀속 — resolved·followup이 같은 봇 토큰으로 이 카드를 다룬다.
        if (res?.message_id) await setApprovalMeta(event.wsId, event.item.id, { tg: { chatId: String(dest.chatId), messageId: res.message_id, ...(dest.botSlug ? { botSlug: dest.botSlug } : {}) } }).catch(() => {});
      } catch (e) { console.error('[argo] 텔레그램 결재 푸시 실패:', e.message); }
    }
  }
  // 브리핑 3종(routine·job·crewmail)의 목적지는 telegramBriefingDest(정본·순수)가 정한다 —
  // 회사 게이트웨이 우선, 못 보내면 담당 크루의 직통 봇 폴백. 실사용 2026-08-27: 게이트웨이
  // enabled=false + 크루 직통 봇만 페어링된 회사에서 루틴 51회 ok인데 텔레그램 0회 도착
  // ("텔레그램으로 보내줘" 루틴 3개가 전부 헛돎) — 직통 봇으로 가는 경로 자체가 없었다.
  const dest = telegramBriefingDest(t, event.type, event.type === 'routine' ? event.routine?.agentSlug : event.slug);
  if (dest) {
    if (event.type === 'routine') {
      await sendTgReply(dest.token, dest.chatId, event.wsId, pick(`**[루틴] ${event.routine.title}${event.ok ? '' : ' (실패)'}**\n\n${event.reply}`, `**[Routine] ${event.routine.title}${event.ok ? '' : ' (failed)'}**\n\n${event.reply}`, lang))
        .catch((e) => console.error('[argo] 텔레그램 루틴 푸시 실패:', e.message));
    }
    // 장시간 작업 완료 — 사장이 앱을 안 보고 있어도 결과가 도착한다(이 큐의 존재 이유)
    if (event.type === 'job') {
      await sendTgReply(dest.token, dest.chatId, event.wsId, pick(`**[작업 완료] ${event.title}${event.ok ? '' : ' (실패)'}**\n\n${event.reply}`, `**[Task done] ${event.title}${event.ok ? '' : ' (failed)'}**\n\n${event.reply}`, lang))
        .catch((e) => console.error('[argo] 텔레그램 작업 푸시 실패:', e.message));
    }
    // 크루 쪽지 배달 — 다른 세션·다른 시각의 크루 간 소통이라 사장이 화면을 보고 있지 않은 게 기본값.
    // 수신 크루의 답을 브리핑으로 민다(재검 N1에서 보류했던 분기 — 문안과 함께 복원).
    if (event.type === 'crewmail') {
      const agents = await listAgents(event.wsId).catch(() => []);
      const nameOf = (s) => agents.find((a) => a.slug === s)?.name ?? s;
      const cc = event.kind === 'cc';
      await sendTgReply(dest.token, dest.chatId, event.wsId, pick(
        `**[크루 쪽지] ${event.fromName ?? nameOf(event.from)} → ${nameOf(event.slug)}${cc ? ' (참조)' : ''}**\n\n${event.reply}`,
        `**[Crew mail] ${event.fromName ?? nameOf(event.from)} → ${nameOf(event.slug)}${cc ? ' (CC)' : ''}**\n\n${event.reply}`,
        lang,
      )).catch((e) => console.error('[argo] 텔레그램 쪽지 푸시 실패:', e.message));
    }
  }
  const s = all.slack;
  // 슬랙은 문안이 준비된 타입만 — 아래 삼항이 approval 외 전부를 루틴 문안으로 다뤄, job·crewmail 등
  // 다른 타입이 오면 event.routine.title에서 매번 TypeError였다(재검 N1). 타입 게이트로 좁힌다.
  if (s.token && s.channel && sends('slack', s)) { // 보낼 수 있는 종류는 CHANNEL_EVENTS.slack이 정본
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

// 테스트 전용 — pushEvent는 onNotify로만 배선되는 내부 함수라 행동 테스트가 태울 이음매가 없었다.
// 소스 문자열 단언은 배선의 존재만 보고 분기 실행을 못 본다(변이 실측: 호출을 `null &&`로 죽여도 초록)
// — 실행 게이트는 이 훅으로 fetch를 가로채 실제 발송을 검증한다(gateway.test.mjs).
export const _pushEventForTest = pushEvent;

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
    // cfg 키 단일화(전수리뷰 2026-07-30 #4) — `${cid}:telegram`류 문자열 조립이 9지점에 흩어져 있고
    // 크루 직통 봇은 큐 키(tg-<slug>)와 cfg 키(tg-agent:<slug>)의 표기까지 달라, 한 지점만 어긋나면
    // 핸들러가 cfg를 못 찾아 잡이 **무로그 폐기**된다. 조립·파싱을 이 두 함수로만 한다.
    const TG_AGENT_Q = 'tg-';
    const tgAgentQkey = (slug) => `${TG_AGENT_Q}${slug}`;
    const gwCfgKey = (cid, qkey) => qkey.startsWith(TG_AGENT_Q) ? `${cid}:tg-agent:${qkey.slice(TG_AGENT_Q.length)}` : `${cid}:${qkey}`;
    for (const [c, all] of loaded) {
      // cfg 맵은 폴러뿐 아니라 드레인 핸들러도 본다 — 리더 여부와 무관하게 항상 최신화
      cfgMap[gwCfgKey(c.id, 'telegram')] = all.telegram;
      cfgMap[gwCfgKey(c.id, 'slack')] = all.slack;
      for (const [slug, bot] of Object.entries(all.telegram.agents ?? {})) cfgMap[gwCfgKey(c.id, tgAgentQkey(slug))] = bot;
      const qkeys = new Set(['telegram', 'slack', ...Object.keys(all.telegram.agents ?? {}).map(tgAgentQkey)]);
      // 설정이 사라진 잔여 큐 디렉터리도 대상 — 핸들러가 cfg 부재 잡을 폐기해 스스로 청소된다
      try {
        for (const n of await readdir(paths(c.id).root)) if (n.startsWith('.gw-queue-')) qkeys.add(n.slice('.gw-queue-'.length));
      } catch { /* 루트 없음 — 새 회사 */ }
      for (const qkey of qkeys) {
        const id = `${c.id}:${qkey}`;
        aliveDrain.add(id);
        if (drainers.has(id)) continue;
        const getCfg = () => globalThis.__argoGwCfg?.[gwCfgKey(c.id, qkey)]; // 등록(cfgMap)과 같은 함수로 조회 — 키 드리프트 원천 차단
        const handler = qkey === 'telegram' ? makeTgGatewayHandler(c.id, getCfg)
          : qkey === 'slack' ? makeSlackHandler(c.id, getCfg)
            : qkey === JOBS_QUEUE ? makeJobHandler(c.id) // 장시간 작업 — 메신저 연결과 무관하게 항상 드레인
              : qkey.startsWith(TG_AGENT_Q) ? makeTgAgentHandler(c.id, qkey.slice(TG_AGENT_Q.length), getCfg)
                : null;
        // 장시간 작업은 동시 1 — 한 회사의 긴 작업이 메신저 응답 슬롯을 다 먹지 않게 큐를 분리한다
        if (handler) drainers.set(id, startQueueWorker(c.id, qkey, handler, qkey === JOBS_QUEUE ? { maxInflight: JOBS_MAX_INFLIGHT } : {}));
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
        // id는 아래 기동 패스가 gwCfgKey(c.id, kind)와 !== 비교한다 — 리터럴로 두면 표기 변경 시
        // 항상 불일치 → 전 회사 "토큰 중복" 무음 미기동(분리 검수 LOW). 같은 함수로 표기를 결합.
        claimedTg.set(t.token, { id: gwCfgKey(c.id, 'telegram'), label: `회사(${c.id})의 텔레그램 연결(설정)` });
      }
    }
    for (const [c, all] of loaded) {
      for (const kind of ['telegram', 'slack']) {
        const cfg = all[kind];
        const id = gwCfgKey(c.id, kind); // 폴러 id = cfg 키(같은 값 — 조립도 같은 함수로)
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
        const id = gwCfgKey(c.id, tgAgentQkey(slug)); // 드레인 cfg 키와 같은 조립 함수 — 표기 드리프트 차단
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
