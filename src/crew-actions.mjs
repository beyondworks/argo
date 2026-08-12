import { Buffer } from 'node:buffer';

const WS_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_CONTEXT_BYTES = 64 * 1024;

const norm = (value) => String(value ?? '').normalize('NFC').toLowerCase().trim();
const boundedText = (value, max) => String(value ?? '').trim().slice(0, max);

function validateSlug(value, field) {
  const slug = boundedText(value, 128);
  if (!SLUG_RE.test(slug)) throw new Error(`invalid Argo crew context: ${field}`);
  return slug;
}

/** Codex 턴과 stdio MCP 자식 사이에 넘기는 Argo 크루 범위를 검증·정규화한다. */
export function normalizeCrewContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid Argo crew context');
  }
  const wsId = boundedText(input.wsId, 160);
  if (!WS_ID_RE.test(wsId)) throw new Error('invalid Argo crew context: wsId');
  const fromSlug = validateSlug(input.fromSlug, 'fromSlug');
  const fromName = boundedText(input.fromName || fromSlug, 200);
  const hop = Number(input.hop ?? 0);
  if (!Number.isInteger(hop) || hop < 0 || hop > 2) {
    throw new Error('invalid Argo crew context: hop');
  }
  const chain = Array.isArray(input.chain)
    ? input.chain.slice(0, 4).map((slug, index) => validateSlug(slug, `chain[${index}]`))
    : [];
  if (!Array.isArray(input.colleagues) || input.colleagues.length > 100) {
    throw new Error('invalid Argo crew context: colleagues');
  }
  const seen = new Set();
  const colleagues = input.colleagues.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`invalid Argo crew context: colleagues[${index}]`);
    }
    const slug = validateSlug(entry.slug, `colleagues[${index}].slug`);
    if (slug === fromSlug || seen.has(slug)) {
      throw new Error(`invalid Argo crew context: duplicate colleague ${slug}`);
    }
    seen.add(slug);
    return {
      slug,
      name: boundedText(entry.name || slug, 200),
      ...(entry.role ? { role: boundedText(entry.role, 500) } : {}),
      ...(entry.team ? { team: boundedText(entry.team, 200) } : {}),
    };
  });
  return {
    wsId,
    fromSlug,
    fromName,
    colleagues,
    hop,
    chain,
    mirrorCtx: input.mirrorCtx && typeof input.mirrorCtx === 'object' && !Array.isArray(input.mirrorCtx)
      ? input.mirrorCtx
      : null,
    lang: input.lang === 'en' ? 'en' : 'ko',
  };
}

export function encodeCrewContext(input) {
  const json = JSON.stringify(normalizeCrewContext(input));
  if (Buffer.byteLength(json) > MAX_CONTEXT_BYTES) throw new Error('Argo crew context is too large');
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCrewContext(encoded) {
  const raw = String(encoded ?? '').trim();
  if (!raw || raw.length > MAX_CONTEXT_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error('invalid encoded Argo crew context');
  }
  let json;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new Error('invalid encoded Argo crew context');
  }
  if (Buffer.byteLength(json) > MAX_CONTEXT_BYTES) throw new Error('Argo crew context is too large');
  try {
    return normalizeCrewContext(JSON.parse(json));
  } catch (error) {
    if (String(error?.message || error).startsWith('invalid Argo crew context')) throw error;
    throw new Error('invalid encoded Argo crew context');
  }
}

/** SDK 러너와 Codex MCP 브리지가 같은 위임·쪽지 의미와 상한을 공유한다. */
export function makeCrewActions(context, {
  runChat,
  appendTurn: appendTurnOverride = null,
  emitNotify: emitNotifyOverride = null,
  sendCrewMail: sendCrewMailOverride = null,
} = {}) {
  const ctx = normalizeCrewContext(context);
  const resolveOne = (value) => ctx.colleagues.find(
    (agent) => norm(agent.slug) === norm(value) || norm(agent.name) === norm(value),
  );
  const targets = () => ctx.colleagues.map((agent) => agent.slug).join(', ');
  let delegated = 0;
  let mailSent = 0;

  const delegate = async ({ to, task }) => {
    if (delegated >= 2) {
      return ctx.lang === 'en'
        ? 'Delegation limit reached — finish the remaining work yourself.'
        : '위임 한도 초과 — 이번 턴은 남은 작업을 직접 마무리하라.';
    }
    const target = resolveOne(to);
    if (!target) {
      return ctx.lang === 'en'
        ? `"${to}" is not a colleague. Available slugs: ${targets()}`
        : `"${to}"는 동료 명단에 없다. 가능한 slug: ${targets()}`;
    }
    const cleanTask = boundedText(task, 50_000);
    if (!cleanTask) return ctx.lang === 'en' ? 'Delegation task is empty.' : '위임할 작업이 비어 있다.';
    if (typeof runChat !== 'function') throw new Error('Argo crew bridge has no chat runner');
    delegated += 1;
    try {
      const delegatedMessage = ctx.lang === 'en'
        ? `(Delegated by colleague ${ctx.fromName}) ${cleanTask}`
        : `(동료 ${ctx.fromName}의 위임) ${cleanTask}`;
      const result = await runChat(ctx.wsId, target.slug, delegatedMessage, null, {
        from: ctx.fromSlug,
        hop: ctx.hop + 1,
        chain: [...ctx.chain, ctx.fromSlug],
      });
      const appendTurn = appendTurnOverride
        ?? (await import('./thread.mjs')).appendTurn;
      await appendTurn(ctx.wsId, target.slug, {
        userMsg: delegatedMessage,
        reply: result.reply,
        handover: result.handover,
        sessionId: null,
      }).catch(() => {});
      const emitNotify = emitNotifyOverride
        ?? (await import('./notify.mjs')).emitNotify;
      emitNotify({
        type: 'delegate',
        wsId: ctx.wsId,
        from: ctx.fromSlug,
        fromName: ctx.fromName,
        to: target.slug,
        toName: target.name,
        task: cleanTask,
        reply: result.reply,
        ctx: ctx.mirrorCtx,
      });
      return ctx.lang === 'en'
        ? `[Result from ${target.name}]\n${result.reply}`
        : `[${target.name}의 작업 결과]\n${result.reply}`;
    } catch (error) {
      return ctx.lang === 'en'
        ? `Delegation failed (${target.name}): ${String(error?.message || error)}`
        : `위임 실패(${target.name}): ${String(error?.message || error)}`;
    }
  };

  const sendToCrew = async ({ to, cc, message }) => {
    if (mailSent >= 2) {
      return ctx.lang === 'en'
        ? 'Crew-message limit reached — finish the remaining work yourself.'
        : '쪽지 한도 초과 — 이번 턴은 이미 보낸 쪽지로 충분하다. 남은 작업을 직접 마무리하라.';
    }
    const target = resolveOne(to);
    if (!target) {
      return ctx.lang === 'en'
        ? `"${to}" is not a colleague. Available slugs: ${targets()}`
        : `"${to}"는 동료 명단에 없다. 가능한 slug: ${targets()}`;
    }
    const cleanMessage = boundedText(message, 50_000);
    if (!cleanMessage) return ctx.lang === 'en' ? 'Crew message is empty.' : '쪽지 내용이 비어 있다.';
    const ccSlugs = (Array.isArray(cc) ? cc : []).map(resolveOne).filter(Boolean).map((agent) => agent.slug);
    try {
      const sendCrewMail = sendCrewMailOverride
        ?? (await import('./crewmail.mjs')).sendCrewMail;
      const id = await sendCrewMail(ctx.wsId, {
        from: ctx.fromSlug,
        fromName: ctx.fromName,
        to: target.slug,
        cc: ccSlugs,
        message: cleanMessage,
        hop: ctx.hop + 1,
        chain: [...ctx.chain, ctx.fromSlug],
      });
      mailSent += 1;
      return ctx.lang === 'en'
        ? `Message sent (${id} → ${target.name}${ccSlugs.length ? `, cc ${ccSlugs.length}` : ''}). The colleague will process it in a later turn.`
        : `쪽지를 보냈다(${id} → ${target.name}${ccSlugs.length ? `, 참조 ${ccSlugs.length}명` : ''}). 상대는 잠시 뒤 자기 턴에서 읽는다 — 결과를 기다리지 말고 지금 할 일을 마무리하라.`;
    } catch (error) {
      return ctx.lang === 'en'
        ? `Crew message failed: ${String(error?.message || error)}`
        : `쪽지 전송 실패: ${String(error?.message || error)}`;
    }
  };

  return { delegate, sendToCrew };
}
