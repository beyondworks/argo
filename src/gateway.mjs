// 메신저 게이트웨이 — 텔레그램/슬랙이 회사의 정문이 된다.
// 메신저에서 크루를 부르면 웹과 같은 chat 경로로 턴이 돌고(스레드·기억 공유),
// 결재는 버튼/회신으로 처리되며, 루틴 결과가 브리핑으로 밀려온다.
import { listCompanies, listAgents } from './hub.mjs';
import { loadConnections, updateConnection, updateAgentBot } from './connections.mjs';
import { chat } from './chat.mjs';
import { loadThread, appendTurn, appendSharedNote } from './thread.mjs';
import { resolveWithFollowUp } from './approval-actions.mjs';
import { onNotify } from './notify.mjs';
import { daemonLease } from './lock.mjs';
import { appendEvent } from './events.mjs';
import { mkdir, readFile, writeFile, readdir, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { mdToTelegramHtml, splitForTelegram, extractFileRefs, isImagePath } from './tg-format.mjs';

/** 폴러 하트비트 — 연결 카드의 "가동 중 · N초 전 응답" 표시의 원천. root의 dotfile이라 vault 스캔 무관. */
async function beatGateway(wsId, kind, ok, error = '') {
  try {
    await writeFile(join(paths(wsId).root, `.gateway-${kind}.json`), JSON.stringify({ ts: Date.now(), ok, error: String(error).slice(0, 200) }));
  } catch { /* 하트비트는 베스트에포트 */ }
}

// 진행 중 메신저 턴의 발화 위치 — 위임이 일어나면 상대 크루 봇이 같은 방에 발화할 수 있게 한다.
// `${wsId}:${slug}` → { chatId, chatType } (턴 시작 시 등록, 종료 시 해제. 웹발 턴은 등록 없음 → 미러 생략)
const activeAgentChat = new Map();

const MAX_MSG = 3800; // 텔레그램 4096 제한 대비 여유
const clip = (t) => (t.length > MAX_MSG ? `${t.slice(0, MAX_MSG)}\n…(전체 내용은 Argo 데크에서)` : t);

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
  if ((f.file_size ?? 0) > 19_500_000) throw new Error('20MB를 넘는 파일은 텔레그램 봇이 내려받을 수 없습니다');
  const info = await tg(token, 'getFile', { file_id: f.file_id });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`파일 다운로드 실패(${res.status})`);
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
  if (!agents.length) return { error: '아직 크루가 없습니다. Argo 데크에서 먼저 영입해 주세요.' };
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
    return { error: `"${bad}" 크루를 못 찾았습니다. 크루: ${agents.map((a) => a.name).join(', ')} — "크루"라고 보내면 현황을 보여드립니다.` };
  }
  const to = mentions[0] ?? (agents.find((a) => a.slug === cfg.defaultCrew) ?? agents[0]);
  return { slug: to.slug, name: to.name, msg: body.trim(), cc: mentions.slice(1) };
}

/** "크루"/"/crew"/"현황" — 어떤 크루가 이 채팅에 연결되어 있는지 즉답(모델 호출 없음). */
async function crewStatusReply(wsId, cfg) {
  const agents = await listAgents(wsId);
  if (!agents.length) return '아직 크루가 없습니다. Argo 데크에서 먼저 영입해 주세요.';
  const def = agents.find((a) => a.slug === cfg.defaultCrew) ?? agents[0];
  return [
    `**연결된 크루 ${agents.length}명**`,
    ...agents.map((a) => `• ${a.name} (@${a.slug})${a.role ? ` — ${a.role}` : ''}${a.runner && a.runner !== 'claude' ? ` · ${a.runner}` : ''}${a.slug === def?.slug ? ' · 기본' : ''}`),
    '',
    '"@이름 지시"로 특정 크루를 부르고, "@이름1 @이름2 지시"처럼 여러 명을 적으면 첫 번째가 실행하고 나머지에게 맥락이 공유됩니다(cc).',
  ].join('\n');
}

/** 메신저발 지시 1턴 — 웹과 동일 경로(스레드 이어쓰기 + vault 기억 + 첨부 비전). ctx = 발화 위치(위임 미러용). */
async function runTurn(wsId, cfg, text, attachments = [], ctx = null) {
  // "승인 ap-xxx" / "거절 ap-xxx" 텍스트 결재 (슬랙·텔레그램 공용)
  const ap = text.match(/^(승인|거절)\s+(ap-[a-z0-9]+)/);
  if (ap) {
    const item = await resolveWithFollowUp(wsId, ap[2], ap[1] === '승인');
    return `결재 ${ap[1]} 처리: ${item.action}\n실행 결과는 담당 크루가 이어서 보고합니다.`;
  }
  if (/^\/?(크루|현황|crew|status)$/i.test(text.trim())) return crewStatusReply(wsId, cfg);
  const r = await routeMessage(wsId, cfg, text);
  if (r.error) return r.error;
  const t = await loadThread(wsId, r.slug);
  if (ctx) activeAgentChat.set(`${wsId}:${r.slug}`, ctx);
  let turn;
  try {
    turn = await chat(wsId, r.slug, r.msg, t.sessionId, { source: 'messenger', attachments });
  } finally {
    activeAgentChat.delete(`${wsId}:${r.slug}`);
  }
  await appendTurn(wsId, r.slug, { userMsg: r.msg, reply: turn.reply, handover: turn.handover, sessionId: turn.sessionId, attachments });
  // cc 크루에게 맥락 공유 — 실행은 to 크루만(폭주 방지), 나머지는 다음 턴에 이 맥락을 알고 시작한다
  let footer = '';
  if (r.cc?.length) {
    const note = `(참조 공유) 사장이 ${r.name}에게 지시: ${r.msg}\n\n${r.name}의 답변:\n${String(turn.reply).slice(0, 2000)}`;
    const shared = [];
    for (const c of r.cc.slice(0, 3)) {
      try { await appendSharedNote(wsId, c.slug, note); shared.push(c.name); } catch { /* 공유 실패는 본답변을 막지 않는다 */ }
    }
    if (shared.length) footer = `\n\n(참조 공유: ${shared.join(', ')} — 다음 대화부터 이 맥락을 알고 시작합니다)`;
  }
  return `[${r.name}]\n${turn.reply}${footer}`;
}

/* ─── 텔레그램 — long-poll. 첫 발신자가 회사와 페어링되고 이후 그 채팅만 듣는다. ─── */
function startTelegram(wsId, getCfg) {
  let stopped = false;
  let offset = 0;
  // 앨범(media_group) 버퍼 — 여러 장이 개별 업데이트로 나뉘어 오므로 2초 모아 한 턴으로 처리
  const albums = new Map(); // groupId → { atts, caption, timer }
  const runWithAtts = (cfg, text, atts, ctx = null) => {
    (async () => {
      try {
        const note = atts.some((a) => !a.isImage) ? '\n(이미지가 아닌 첨부는 vault 경로로 저장되어 있다)' : '';
        const reply = await runTurn(wsId, cfg, text || '첨부한 파일을 확인하고 필요한 걸 처리해줘.' + note, atts, ctx);
        await sendTgReply(cfg.token, cfg.chatId, wsId, reply);
      } catch (e) {
        await tg(cfg.token, 'sendMessage', { chat_id: cfg.chatId, text: `처리 실패: ${String(e.message).slice(0, 200)}` }).catch(() => {});
      }
    })();
  };
  (async () => {
    console.log(`[argo] 텔레그램 게이트웨이 시작: ${wsId}`);
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.enabled || !cfg.token) break;
      try {
        const updates = await tg(cfg.token, 'getUpdates', { offset, timeout: 25 });
        await beatGateway(wsId, 'telegram', true);
        for (const u of updates) {
          offset = u.update_id + 1;
          if (stopped) break;

          if (u.callback_query) { // 결재 인라인 버튼
            const cq = u.callback_query;
            const m = String(cq.data ?? '').match(/^ap:(ap-[a-z0-9]+):([01])$/);
            if (m && String(cq.message?.chat?.id) === String(cfg.chatId)) {
              const approve = m[2] === '1';
              try {
                const item = await resolveWithFollowUp(wsId, m[1], approve);
                await tg(cfg.token, 'answerCallbackQuery', { callback_query_id: cq.id, text: approve ? '승인됨' : '거절됨' });
                await tg(cfg.token, 'sendMessage', { chat_id: cfg.chatId, text: `결재 ${approve ? '승인' : '거절'}: ${item.action}\n담당 크루가 이어서 보고합니다.` });
              } catch (e) {
                await tg(cfg.token, 'answerCallbackQuery', { callback_query_id: cq.id, text: String(e.message).slice(0, 60) }).catch(() => {});
              }
            }
            continue;
          }

          const msg = u.message;
          if (!msg || (!msg.text && !msg.photo && !msg.document && !msg.video && !msg.voice && !msg.audio)) continue;
          if (!cfg.chatId) { // 페어링 — 첫 발신자를 사장 채팅으로 고정
            await updateConnection(wsId, 'telegram', { chatId: String(msg.chat.id) });
            await appendEvent(wsId, { type: 'gateway', kind: 'telegram', op: 'paired' });
            await tg(cfg.token, 'sendMessage', { chat_id: msg.chat.id, text: '이 채팅이 회사와 연결되었습니다.\n"@크루이름 지시" 또는 그냥 지시를 보내면 기본 크루가 응답합니다.\n"@이름1 @이름2 지시"는 첫 크루가 실행하고 나머지에게 맥락을 공유(cc)합니다.\n"크루"라고 보내면 연결된 크루 현황을 보여드립니다.' });
            continue;
          }
          if (String(msg.chat.id) !== String(cfg.chatId)) continue; // 페어링된 채팅만
          tg(cfg.token, 'sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {});

          // 미디어 수신 — 다운로드해 vault/files/로. 앨범은 2초 버퍼로 모아 한 턴.
          if (msg.photo || msg.document || msg.video || msg.voice || msg.audio) {
            let att = null;
            try {
              att = await tgDownload(cfg.token, wsId, msg);
            } catch (e) {
              await tg(cfg.token, 'sendMessage', { chat_id: cfg.chatId, text: `첨부 수신 실패: ${String(e.message).slice(0, 150)}` }).catch(() => {});
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
              g.timer = setTimeout(() => { albums.delete(key); runWithAtts(getCfg() ?? cfg, g.caption, g.atts, g.ctx); }, 2000);
              albums.set(key, g);
            } else {
              runWithAtts(cfg, msg.caption ?? '', [att], { chatId: msg.chat.id, chatType: msg.chat.type });
            }
            continue;
          }

          // 턴을 기다리지 않는다 — 기다리면 폴이 멈춰 결재 버튼 콜백을 못 받는다(권한 게이트 데드락)
          runWithAtts(cfg, msg.text, [], { chatId: msg.chat.id, chatType: msg.chat.type });
        }
      } catch (e) {
        if (!stopped) {
          const hint = /Conflict/.test(String(e.message)) ? ' — 같은 토큰을 다른 인스턴스가 폴링 중일 수 있음' : '';
          console.error(`[argo] 텔레그램 폴 오류(${wsId}):`, e.message, hint);
          await beatGateway(wsId, 'telegram', false, e.message);
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
  const ap = text.match(/^(승인|거절)\s+(ap-[a-z0-9]+)/);
  if (ap) {
    const item = await resolveWithFollowUp(wsId, ap[2], ap[1] === '승인');
    return `결재 ${ap[1]} 처리: ${item.action}\n실행 결과는 이어서 보고합니다.`;
  }
  const t = await loadThread(wsId, slug);
  activeAgentChat.set(`${wsId}:${slug}`, ctx);
  let turn;
  try {
    turn = await chat(wsId, slug, text, t.sessionId, { source: 'messenger', attachments });
  } finally {
    activeAgentChat.delete(`${wsId}:${slug}`);
  }
  await appendTurn(wsId, slug, { userMsg: text, reply: turn.reply, handover: turn.handover, sessionId: turn.sessionId, attachments });
  return turn.reply; // 봇 자체가 그 크루 — 이름 프리픽스 불필요
}

function startAgentTelegram(wsId, slug, getCfg) {
  let stopped = false;
  let offset = 0;
  const albums = new Map();
  const run = (cfg, text, atts, ctx) => {
    (async () => {
      try {
        const note = atts.some((a) => !a.isImage) ? '\n(이미지가 아닌 첨부는 vault 경로로 저장되어 있다)' : '';
        const reply = await runAgentTurn(wsId, slug, text || '첨부한 파일을 확인하고 필요한 걸 처리해줘.' + note, atts, ctx);
        await sendTgReply(cfg.token, ctx.chatId, wsId, reply);
      } catch (e) {
        await tg(cfg.token, 'sendMessage', { chat_id: ctx.chatId, text: `처리 실패: ${String(e.message).slice(0, 200)}` }).catch(() => {});
      }
    })();
  };
  (async () => {
    console.log(`[argo] 텔레그램 크루 봇 시작: ${wsId}/${slug}`);
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.token) break;
      try {
        const updates = await tg(cfg.token, 'getUpdates', { offset, timeout: 25 });
        await beatGateway(wsId, `tg-${slug}`, true);
        for (const u of updates) {
          offset = u.update_id + 1;
          if (stopped) break;
          const msg = u.message;
          if (!msg || (!msg.text && !msg.photo && !msg.document && !msg.video && !msg.voice && !msg.audio)) continue;
          const isDm = msg.chat.type === 'private';
          if (!cfg.ownerId) {
            if (!isDm) continue; // 페어링 전 그룹 메시지는 무시 — 먼저 DM으로 페어링
            await updateAgentBot(wsId, slug, { ownerId: msg.from.id, ownerChat: String(msg.chat.id) });
            Object.assign(cfg, { ownerId: msg.from.id, ownerChat: String(msg.chat.id) }); // sync 주기(10s) 전에도 즉시 반영
            await appendEvent(wsId, { type: 'gateway', kind: 'telegram', op: 'paired', slug });
            await tg(cfg.token, 'sendMessage', { chat_id: msg.chat.id, text: '이 봇은 이 크루와의 1:1 직통입니다. 그대로 지시를 보내면 됩니다.\n그룹에 초대한 뒤 @멘션하거나 봇 메시지에 답장하면 그룹에서도 함께 일합니다.' });
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
              await tg(cfg.token, 'sendMessage', { chat_id: ctx.chatId, text: `첨부 수신 실패: ${String(e.message).slice(0, 150)}` }).catch(() => {});
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
              g.timer = setTimeout(() => { albums.delete(key); run(getCfg() ?? cfg, g.caption, g.atts, g.ctx); }, 2000);
              albums.set(key, g);
            } else {
              run(cfg, strip(msg.caption ?? ''), [att], ctx);
            }
            continue;
          }
          run(cfg, strip(msg.text), [], ctx); // 논블로킹 — 폴은 계속 돈다
        }
      } catch (e) {
        if (!stopped) {
          const hint = /Conflict/.test(String(e.message)) ? ' — 같은 토큰을 다른 인스턴스가 폴링 중일 수 있음' : '';
          console.error(`[argo] 크루 봇 폴 오류(${wsId}/${slug}):`, e.message, hint);
          await beatGateway(wsId, `tg-${slug}`, false, e.message);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
    console.log(`[argo] 텔레그램 크루 봇 종료: ${wsId}/${slug}`);
  })();
  return () => { stopped = true; };
}

/* ─── 받은 서류함(inbox) — 폴더에 파일을 넣는 것이 곧 지시. 기본 크루가 읽고 처리해 보고한다. ─── */
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
        const fp = join(dir, n);
        const st = await stat(fp).catch(() => null);
        if (!st?.isFile() || Date.now() - st.mtimeMs < 5000) continue; // 아직 복사 중일 수 있다 — 5초 안정 후 처리
        busy.add(n);
        (async () => {
          try {
            const safe = n.replace(/[^\w.\-가-힣 ()]/g, '_').slice(-80);
            const rel = `files/${Date.now().toString(36)}-${safe}`;
            await mkdir(join(paths(wsId).vault, 'files'), { recursive: true });
            await rename(fp, join(paths(wsId).vault, rel)); // inbox에서 꺼내 기억으로 — 재처리 방지
            const ext = safe.split('.').pop()?.toLowerCase() ?? '';
            const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
            const att = { rel, name: safe, mime: isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : '', isImage };
            const cfg = (await loadConnections(wsId)).telegram;
            console.log(`[argo] 받은 서류함 처리 시작: ${wsId}/${safe}`);
            const reply = await runTurn(wsId, cfg, `(받은 서류함) 사장이 inbox 폴더에 "${safe}" 파일을 넣었다. 내용을 확인하고 필요한 처리를 한 뒤 5줄 이내로 보고하라.`, [att]);
            if (cfg.enabled && cfg.token && cfg.chatId) { // 자리에 없어도 결과가 도착한다
              await sendTgReply(cfg.token, cfg.chatId, wsId, `[받은 서류함] ${safe}\n\n${reply}`).catch(() => {});
            }
          } catch (e) {
            console.error(`[argo] inbox 처리 실패(${wsId}/${n}):`, e.message);
          } finally {
            busy.delete(n);
          }
        })();
      }
    } catch { /* 감시 루프는 죽지 않는다 */ }
  }, 15_000);
  return () => { stopped = true; clearInterval(iv); };
}

/* ─── 슬랙 — 공개 URL 없이 동작하도록 conversations.history 폴링. 봇을 채널에 초대해야 한다. ─── */
function startSlack(wsId, getCfg) {
  let stopped = false;
  let lastTs = String(Date.now() / 1000);
  let lastBeat = 0;
  (async () => {
    console.log(`[argo] 슬랙 게이트웨이 시작: ${wsId}`);
    const cfg0 = getCfg();
    try {
      if (!cfg0.botUserId) {
        const auth = await slackApi(cfg0.token, 'auth.test');
        await updateConnection(wsId, 'slack', { botUserId: auth.user_id });
      }
    } catch (e) {
      console.error(`[argo] 슬랙 인증 실패(${wsId}):`, e.message);
    }
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.enabled || !cfg.token || !cfg.channel) break;
      try {
        const h = await slackApi(cfg.token, 'conversations.history', { channel: cfg.channel, oldest: lastTs, limit: 20 });
        if (Date.now() - lastBeat > 10_000) { lastBeat = Date.now(); await beatGateway(wsId, 'slack', true); }
        for (const m of (h.messages ?? []).reverse()) {
          if (Number(m.ts) > Number(lastTs)) lastTs = m.ts;
          if (!m.text || m.bot_id || m.user === cfg.botUserId || m.subtype) continue;
          // 논블로킹 — 턴이 결재 대기 중이어도 "승인 <번호>" 회신을 계속 읽을 수 있어야 한다
          (async () => {
            try {
              const reply = await runTurn(wsId, cfg, m.text.replace(/<@[A-Z0-9]+>\s*/g, '').trim());
              await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: clip(reply) });
            } catch (e) {
              await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: `처리 실패: ${String(e.message).slice(0, 200)}` }).catch(() => {});
            }
          })();
        }
      } catch (e) {
        if (!stopped) {
          console.error(`[argo] 슬랙 폴 오류(${wsId}):`, e.message);
          await beatGateway(wsId, 'slack', false, e.message);
        }
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    console.log(`[argo] 슬랙 게이트웨이 종료: ${wsId}`);
  })();
  return () => { stopped = true; };
}

/* ─── 알림 푸시 — 결재는 버튼과 함께, 루틴은 브리핑으로, 위임은 상대 크루 봇의 발화로 ─── */
async function pushEvent(event) {
  const all = await loadConnections(event.wsId);
  // 위임 미러 — 그룹 대화 중 A가 B에게 위임하면, B의 봇이 같은 방에 자기 이름으로 결과를 올린다(크루 간 대화 가시화).
  if (event.type === 'delegate') {
    const ctx = activeAgentChat.get(`${event.wsId}:${event.from}`);
    if (!ctx || !/group/.test(ctx.chatType ?? '')) return; // 그룹에서만 — DM엔 상대 봇이 없다
    const bot = all.telegram.agents?.[event.to];
    if (!bot?.token) return; // 상대가 봇이 없으면 위임 결과는 A의 답에 통합돼 있으니 생략
    await sendTgReply(bot.token, ctx.chatId, event.wsId, `(${event.fromName}의 요청: ${String(event.task).replace(/\s+/g, ' ').slice(0, 80)})\n\n${event.reply}`)
      .catch((e) => console.error('[argo] 위임 미러 실패:', e.message));
    return;
  }
  const t = all.telegram;
  if (t.enabled && t.token && t.chatId) {
    if (event.type === 'approval') {
      await tg(t.token, 'sendMessage', {
        chat_id: t.chatId,
        text: `결재 요청\n${event.item.action}\n\n사유: ${event.item.reason}`,
        reply_markup: { inline_keyboard: [[
          { text: '승인', callback_data: `ap:${event.item.id}:1` },
          { text: '거절', callback_data: `ap:${event.item.id}:0` },
        ]] },
      }).catch((e) => console.error('[argo] 텔레그램 결재 푸시 실패:', e.message));
    }
    if (event.type === 'routine') {
      await sendTgReply(t.token, t.chatId, event.wsId, `**[루틴] ${event.routine.title}${event.ok ? '' : ' (실패)'}**\n\n${event.reply}`)
        .catch((e) => console.error('[argo] 텔레그램 루틴 푸시 실패:', e.message));
    }
  }
  const s = all.slack;
  if (s.enabled && s.token && s.channel) {
    const text = event.type === 'approval'
      ? `결재 요청: ${event.item.action}\n사유: ${event.item.reason}\n→ 이 채널에 "승인 ${event.item.id}" 또는 "거절 ${event.item.id}" 로 회신`
      : `[루틴] ${event.routine.title} ${event.ok ? '' : '(실패)'}\n${event.reply}`;
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

  const running = new Map(); // `${wsId}:${kind}` → { stop, key }
  // 푸시는 이벤트가 난 워커가 직접 보낸다(1회 발생 = 1회 발송, 충돌 없음). 리더 단일화는 폴러에만.
  onNotify(pushEvent);
  let wasLeader = false;
  const sync = async () => {
    const leader = lease.isLeader();
    if (leader !== wasLeader) { // 리더십 전환은 반드시 로그 — "폴러가 왜 안 도나" 1차 단서
      console.log(`[argo] 게이트웨이 리더 ${leader ? '획득' : '양보'} (pid ${process.pid})`);
      wasLeader = leader;
    }
    if (!leader) { // 리더가 아니면 내 폴러를 모두 내린다
      for (const [id, cur] of running) { cur.stop(); running.delete(id); }
      return;
    }
    const companies = await listCompanies().catch(() => []);
    const alive = new Set();
    for (const c of companies) {
      const all = await loadConnections(c.id).catch(() => null);
      if (!all) continue;
      for (const kind of ['telegram', 'slack']) {
        const cfg = all[kind];
        const id = `${c.id}:${kind}`;
        const key = `${cfg.enabled}:${cfg.token}:${cfg.channel ?? ''}`;
        if (cfg.enabled && cfg.token && (kind === 'telegram' || cfg.channel)) {
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
