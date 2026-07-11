// 메신저 연결 — connections.json. 봇 토큰은 워크스페이스 파일에만 두고(로그·API 응답 금지),
// 화면에는 항상 마스킹해서 내보낸다. SaaS(P1)에서는 서버측 암호화 보관으로 이전한다.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';

const EMPTY = {
  // agents: { [slug]: { token, botUsername, ownerId, ownerChat } } — 크루별 직통 봇(연락처처럼 1크루 1봇)
  telegram: { token: '', chatId: null, defaultCrew: '', enabled: false, botUsername: '', agents: {} },
  slack: { token: '', channel: '', botUserId: null, defaultCrew: '', enabled: false, botUsername: '' },
};

/** 가동 전 토큰 즉시 검증 — "연동 안 됨"을 저장 시점에 잡는다. 반환: 봇 표시명. 실패 시 throw. */
export async function validateConnection(kind, token) {
  if (kind === 'telegram') {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`텔레그램 토큰 검증 실패: ${j.description ?? res.status}`);
    return `@${j.result.username}`;
  }
  if (kind === 'slack') {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`슬랙 토큰 검증 실패: ${j.error ?? res.status}`);
    return j.user ?? '';
  }
  return '';
}

/** 크루 이름 변경을 봇 표시 이름에 동기화(setMyName). @username은 BotFather 전용이라 불가.
    텔레그램이 이름 변경 빈도를 제한하므로 베스트에포트 — 실패해도 카드 수정은 막지 않는다. */
export async function syncAgentBotName(wsId, slug, name) {
  const all = await loadConnections(wsId);
  const bot = all.telegram.agents?.[slug];
  if (!bot?.token || !name?.trim()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${bot.token}/setMyName`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim().slice(0, 64) }),
      signal: AbortSignal.timeout(10_000),
    });
    return !!(await res.json().catch(() => ({}))).ok;
  } catch {
    return false;
  }
}

/** 게이트웨이 폴러 하트비트 조회 — 40초 내 성공 비트가 있어야 "가동 중". */
export async function gatewayStatus(wsId) {
  const read = async (kind) => {
    try {
      const s = JSON.parse(await readFile(join(paths(wsId).root, `.gateway-${kind}.json`), 'utf8'));
      return { alive: s.ok && Date.now() - s.ts < 40_000, lastTs: s.ts, error: s.ok ? '' : s.error };
    } catch {
      return { alive: false, lastTs: null, error: '' };
    }
  };
  const out = { telegram: await read('telegram'), slack: await read('slack'), agents: {} };
  const all = await loadConnections(wsId);
  for (const slug of Object.keys(all.telegram.agents ?? {})) out.agents[slug] = await read(`tg-${slug}`);
  return out;
}

export async function loadConnections(wsId) {
  try {
    const raw = JSON.parse(await readFile(paths(wsId).connections, 'utf8'));
    return {
      telegram: { ...EMPTY.telegram, ...raw.telegram, agents: raw.telegram?.agents ?? {} },
      slack: { ...EMPTY.slack, ...raw.slack },
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

/** 크루 직통 봇 연결/해제 — patch=null이면 해제. 토큰이 바뀌면 페어링(ownerId) 초기화. */
export async function updateAgentBot(wsId, slug, patch) {
  const all = await loadConnections(wsId);
  const agents = { ...all.telegram.agents };
  if (!patch) {
    delete agents[slug];
  } else {
    const prev = agents[slug] ?? {};
    const next = { ...prev, ...patch };
    if (patch.token && patch.token !== prev.token) { next.ownerId = null; next.ownerChat = null; }
    agents[slug] = next;
  }
  all.telegram.agents = agents;
  await writeFile(paths(wsId).connections, JSON.stringify(all, null, 2));
  return all;
}

export async function updateConnection(wsId, kind, patch) {
  if (!['telegram', 'slack'].includes(kind)) throw new Error('알 수 없는 연결 종류');
  const all = await loadConnections(wsId);
  const next = { ...all[kind], ...patch };
  if (patch.token === '') next.token = all[kind].token; // 빈 토큰 = 기존 유지(토글만 바꿀 때)
  if (patch.token && patch.token !== all[kind].token) {
    next.chatId = null; // 토큰이 바뀌면 페어링 초기화
    next.botUserId = null;
  }
  all[kind] = next;
  await writeFile(paths(wsId).connections, JSON.stringify(all, null, 2));
  return all;
}

/** 화면용 — 토큰을 절대 그대로 내보내지 않는다. */
export function maskConnections(all) {
  const mask = (t) => (t ? `${t.slice(0, 5)}***${t.slice(-3)}` : '');
  const agents = {};
  for (const [slug, a] of Object.entries(all.telegram.agents ?? {})) {
    agents[slug] = { botUsername: a.botUsername ?? '', paired: !!a.ownerId, hasToken: !!a.token };
  }
  return {
    telegram: { ...all.telegram, token: mask(all.telegram.token), hasToken: !!all.telegram.token, agents },
    slack: { ...all.slack, token: mask(all.slack.token), hasToken: !!all.slack.token },
  };
}
