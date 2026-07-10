// 메신저 게이트웨이 — 텔레그램/슬랙이 회사의 정문이 된다.
// 메신저에서 크루를 부르면 웹과 같은 chat 경로로 턴이 돌고(스레드·기억 공유),
// 결재는 버튼/회신으로 처리되며, 루틴 결과가 브리핑으로 밀려온다.
import { listCompanies, listAgents } from './hub.mjs';
import { loadConnections, updateConnection } from './connections.mjs';
import { chat } from './chat.mjs';
import { loadThread, appendTurn } from './thread.mjs';
import { resolveWithFollowUp } from './approval-actions.mjs';
import { onNotify } from './notify.mjs';
import { daemonLease } from './lock.mjs';

const MAX_MSG = 3800; // 텔레그램 4096 제한 대비 여유
const clip = (t) => (t.length > MAX_MSG ? `${t.slice(0, MAX_MSG)}\n…(전체 내용은 Argo 데크에서)` : t);

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

/** "@이름 지시" → 크루 슬러그 + 본문. 이름 미지정이면 기본 크루. */
async function routeMessage(wsId, cfg, text) {
  const agents = await listAgents(wsId);
  if (!agents.length) return { error: '아직 크루가 없습니다. Argo 데크에서 먼저 영입해 주세요.' };
  const m = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (m) {
    const key = m[1].toLowerCase();
    const target = agents.find((a) => a.slug === key || a.name.toLowerCase() === key);
    if (!target) return { error: `"${m[1]}" 크루를 못 찾았습니다. 크루: ${agents.map((a) => a.name).join(', ')}` };
    return { slug: target.slug, name: target.name, msg: m[2].trim() };
  }
  const def = agents.find((a) => a.slug === cfg.defaultCrew) ?? agents[0];
  return { slug: def.slug, name: def.name, msg: text.trim() };
}

/** 메신저발 지시 1턴 — 웹과 동일 경로(스레드 이어쓰기 + vault 기억). */
async function runTurn(wsId, cfg, text) {
  // "승인 ap-xxx" / "거절 ap-xxx" 텍스트 결재 (슬랙·텔레그램 공용)
  const ap = text.match(/^(승인|거절)\s+(ap-[a-z0-9]+)/);
  if (ap) {
    const item = await resolveWithFollowUp(wsId, ap[2], ap[1] === '승인');
    return `결재 ${ap[1]} 처리: ${item.action}\n실행 결과는 담당 크루가 이어서 보고합니다.`;
  }
  const r = await routeMessage(wsId, cfg, text);
  if (r.error) return r.error;
  const t = await loadThread(wsId, r.slug);
  const turn = await chat(wsId, r.slug, r.msg, t.sessionId, { source: 'messenger' });
  await appendTurn(wsId, r.slug, { userMsg: r.msg, reply: turn.reply, handover: turn.handover, sessionId: turn.sessionId });
  return `[${r.name}]\n${turn.reply}`;
}

/* ─── 텔레그램 — long-poll. 첫 발신자가 회사와 페어링되고 이후 그 채팅만 듣는다. ─── */
function startTelegram(wsId, getCfg) {
  let stopped = false;
  let offset = 0;
  (async () => {
    console.log(`[argo] 텔레그램 게이트웨이 시작: ${wsId}`);
    while (!stopped) {
      const cfg = getCfg();
      if (!cfg?.enabled || !cfg.token) break;
      try {
        const updates = await tg(cfg.token, 'getUpdates', { offset, timeout: 25 });
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
          if (!msg?.text) continue;
          if (!cfg.chatId) { // 페어링 — 첫 발신자를 사장 채팅으로 고정
            await updateConnection(wsId, 'telegram', { chatId: String(msg.chat.id) });
            await tg(cfg.token, 'sendMessage', { chat_id: msg.chat.id, text: '이 채팅이 회사와 연결되었습니다.\n"@크루이름 지시" 또는 그냥 지시를 보내면 기본 크루가 응답합니다.' });
            continue;
          }
          if (String(msg.chat.id) !== String(cfg.chatId)) continue; // 페어링된 채팅만
          tg(cfg.token, 'sendChatAction', { chat_id: cfg.chatId, action: 'typing' }).catch(() => {});
          try {
            const reply = await runTurn(wsId, cfg, msg.text);
            await tg(cfg.token, 'sendMessage', { chat_id: cfg.chatId, text: clip(reply) });
          } catch (e) {
            await tg(cfg.token, 'sendMessage', { chat_id: cfg.chatId, text: `처리 실패: ${String(e.message).slice(0, 200)}` }).catch(() => {});
          }
        }
      } catch (e) {
        if (!stopped) {
          console.error(`[argo] 텔레그램 폴 오류(${wsId}):`, e.message);
          await new Promise((r) => setTimeout(r, 5000)); // 잘못된 토큰·네트워크 단절에도 루프는 살아있는다
        }
      }
    }
    console.log(`[argo] 텔레그램 게이트웨이 종료: ${wsId}`);
  })();
  return () => { stopped = true; };
}

/* ─── 슬랙 — 공개 URL 없이 동작하도록 conversations.history 폴링. 봇을 채널에 초대해야 한다. ─── */
function startSlack(wsId, getCfg) {
  let stopped = false;
  let lastTs = String(Date.now() / 1000);
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
        for (const m of (h.messages ?? []).reverse()) {
          if (Number(m.ts) > Number(lastTs)) lastTs = m.ts;
          if (!m.text || m.bot_id || m.user === cfg.botUserId || m.subtype) continue;
          try {
            const reply = await runTurn(wsId, cfg, m.text.replace(/<@[A-Z0-9]+>\s*/g, '').trim());
            await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: clip(reply) });
          } catch (e) {
            await slackApi(cfg.token, 'chat.postMessage', { channel: cfg.channel, text: `처리 실패: ${String(e.message).slice(0, 200)}` }).catch(() => {});
          }
        }
      } catch (e) {
        if (!stopped) console.error(`[argo] 슬랙 폴 오류(${wsId}):`, e.message);
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    console.log(`[argo] 슬랙 게이트웨이 종료: ${wsId}`);
  })();
  return () => { stopped = true; };
}

/* ─── 알림 푸시 — 결재는 버튼과 함께, 루틴은 브리핑으로 ─── */
async function pushEvent(event) {
  const all = await loadConnections(event.wsId);
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
      await tg(t.token, 'sendMessage', {
        chat_id: t.chatId,
        text: clip(`[루틴] ${event.routine.title} ${event.ok ? '' : '(실패)'}\n\n${event.reply}`),
      }).catch((e) => console.error('[argo] 텔레그램 루틴 푸시 실패:', e.message));
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

  const running = new Map(); // `${wsId}:${kind}` → { stop, key }
  // 푸시는 이벤트가 난 워커가 직접 보낸다(1회 발생 = 1회 발송, 충돌 없음). 리더 단일화는 폴러에만.
  onNotify(pushEvent);
  const sync = async () => {
    if (!lease.isLeader()) { // 리더가 아니면 내 폴러를 모두 내린다
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
    }
    for (const [id, cur] of running) {
      if (!alive.has(id)) { cur.stop(); running.delete(id); }
    }
  };
  sync().catch(() => {});
  setInterval(() => sync().catch((e) => console.error('[argo] 게이트웨이 sync 오류:', e.message)), 10_000);
}
