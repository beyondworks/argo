// 메신저 연결 — connections.json. 봇 토큰은 워크스페이스 파일에만 두고(로그·API 응답 금지),
// 화면에는 항상 마스킹해서 내보낸다. SaaS(P1)에서는 서버측 암호화 보관으로 이전한다.
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { paths, WS_ROOT } from './workspace.mjs';
import { writeJsonAtomic, readJson, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';

const lockKey = (wsId) => `connections:${wsId}`;

// 페어링 코드 — 봇에 먼저 말건 사람이 주인이 되는 TOFU를 막는다. 사장이 설정에 표시된 이 코드를
// 봇에 보내야만 소유자로 고정된다. 헷갈리는 글자(0/O/1/I) 제외한 6자.
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makePairCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
  return c;
}

const EMPTY = {
  // agents: { [slug]: { token, botUsername, ownerId, ownerChat } } — 크루별 직통 봇(연락처처럼 1크루 1봇)
  telegram: { token: '', chatId: null, ownerId: null, pairCode: '', defaultCrew: '', enabled: false, botUsername: '', agents: {} },
  // slack ownerId = 페어링된 사장의 슬랙 user id — 채널 멤버 전원이 크루 구동·결재하던 구멍을 막는다(텔레그램과 동일 모델)
  slack: { token: '', channel: '', botUserId: null, ownerId: null, pairCode: '', defaultCrew: '', enabled: false, botUsername: '' },
};

/** 붙여넣은 토큰 정제 — 봇 토큰엔 공백이 없다. 앞뒤 trim만으론 BotFather 복사 시 섞인 중간 개행·공백·
    보이지 않는 문자(zero-width·BOM·nbsp)가 남아 URL(`.../bot<token>/getMe`)을 깨뜨리고, fetch가 통째로
    throw해 화면에 무의미한 "fetch failed"가 뜬 뒤 저장이 롤백된다(실측 2026-07-24: 새 토큰 저장 실패·옛
    토큰 잔존). 전 공백류 + zero-width(200B-200D)·BOM(FEFF)·nbsp(00A0)를 제거해 저장·검증 양쪽을 깨끗이
    한다. (export: 회귀 테스트용) */
export const sanitizeToken = (t) => String(t ?? '').replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, '');

/** fetch 자체가 throw(잘못된 토큰으로 URL 깨짐·네트워크·타임아웃)하면 원문 대신 사람이 읽을 안내로. */
async function safeFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    throw new Error(`서버에 연결하지 못했습니다 (토큰 형식이나 네트워크를 확인해 주세요): ${String(e.message || e).slice(0, 80)}`);
  }
}

/** 가동 전 토큰 즉시 검증 — "연동 안 됨"을 저장 시점에 잡는다. 반환: 봇 표시명. 실패 시 throw. */
export async function validateConnection(kind, token) {
  const tok = sanitizeToken(token);
  if (kind === 'telegram') {
    if (!/^\d+:[\w-]+$/.test(tok)) throw new Error('봇 토큰 형식이 올바르지 않습니다 (BotFather의 "숫자:문자" 토큰을 공백 없이 붙여넣어 주세요)');
    const res = await safeFetch(`https://api.telegram.org/bot${tok}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`텔레그램 토큰 검증 실패: ${j.description ?? res.status}`);
    return `@${j.result.username}`;
  }
  if (kind === 'slack') {
    const res = await safeFetch('https://slack.com/api/auth.test', {
      method: 'POST', headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(10_000),
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
    // 게이트웨이 하트비트는 캐시성(재생성 가능) — 손상은 관용하고 "가동 안 함"으로 본다(readJsonLenient).
    const s = await readJsonLenient(join(paths(wsId).root, `.gateway-${kind}.json`), null);
    if (!s) return { alive: false, lastTs: null, error: '' };
    return { alive: s.ok && Date.now() - s.ts < 40_000, lastTs: s.ts, error: s.ok ? '' : s.error };
  };
  const out = { telegram: await read('telegram'), slack: await read('slack'), agents: {} };
  const all = await loadConnections(wsId);
  for (const slug of Object.keys(all.telegram.agents ?? {})) out.agents[slug] = await read(`tg-${slug}`);
  return out;
}

export async function loadConnections(wsId) {
  // 봇 토큰은 유실이 치명적 — 손상을 조용히 빈 연결로 리셋하지 않고 throw로 드러낸다(readJson).
  // 부재(ENOENT)만 EMPTY로 시드된다.
  const raw = await readJson(paths(wsId).connections, EMPTY);
  return {
    telegram: { ...EMPTY.telegram, ...raw.telegram, agents: raw.telegram?.agents ?? {} },
    slack: { ...EMPTY.slack, ...raw.slack },
  };
}

/** 크루 직통 봇 연결/해제 — patch=null이면 해제. 토큰이 바뀌면 페어링(ownerId) 초기화. */
export async function updateAgentBot(wsId, slug, patch) {
  // 저장 단일 관문 정제 — updateConnection과 대칭. 크루 직통 봇도 붙여넣기 오염 토큰이 그대로 저장돼
  // 폴러 getUpdates/getMe가 깨지던 것을 막는다(검수 HIGH 2026-07-24). validateConnection이 검증 시
  // 이미 정제하므로 저장값도 같은 정제를 거쳐야 검증-저장 값이 일치한다.
  if (patch && typeof patch.token === 'string' && patch.token !== '') patch = { ...patch, token: sanitizeToken(patch.token) };
  // 락 안에서 read-modify-write — 폴러 자동 페어링과 UI 설정 변경이 같은 파일을 경쟁해도 유실 없음
  return withLock(lockKey(wsId), async () => {
    const all = await loadConnections(wsId);
    const agents = { ...all.telegram.agents };
    if (!patch) {
      delete agents[slug];
    } else {
      const prev = agents[slug] ?? {};
      if (patch.token && patch.token !== prev.token) {
        const used = await findTelegramTokenUse(patch.token, { exceptWs: wsId, exceptSlug: slug });
        if (used) throw new Error(tokenInUseMsg(used));
      }
      const next = { ...prev, ...patch };
      if (patch.token && patch.token !== prev.token) { next.ownerId = null; next.ownerChat = null; next.pairCode = makePairCode(); }
      if (next.token && !next.ownerId && !next.pairCode) next.pairCode = makePairCode(); // 미페어링인데 코드 없으면 발급
      agents[slug] = next;
    }
    all.telegram.agents = agents;
    await writeJsonAtomic(paths(wsId).connections, all);
    return all;
  });
}

/** 텔레그램 봇 토큰의 기존 사용처 탐색 — 텔레그램은 토큰당 폴러 1개(getUpdates Conflict)라
    회사 게이트웨이·크루 직통 봇·다른 회사까지 전 표면의 중복을 저장 시점에 막는다(실측:
    같은 봇을 설정과 크루 카드에 각각 연결 → 폴러 2개 → 한쪽이 Conflict로 죽음).
    반환: null | { wsId, where: 'gateway' | 'agent', slug? } */
export async function findTelegramTokenUse(token, { exceptWs = null, exceptSlug = null, exceptGateway = false } = {}) {
  if (!token) return null;
  let entries = [];
  try { entries = await readdir(WS_ROOT, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const ws = e.name;
    // 검사용 순수 읽기 — readJson류는 손상 시 .corrupt- rename(쓰기)을 하므로 여기선 안 쓴다.
    // 무관한 회사의 파일을 검사가 건드리면 안 되고, 손상은 관용(불확실하면 통과가 안전)한다.
    let raw = null;
    try { raw = JSON.parse(await readFile(join(WS_ROOT, ws, 'connections.json'), 'utf8')); } catch { continue; }
    if (!raw?.telegram) continue;
    if (raw.telegram.token === token && !(exceptGateway && ws === exceptWs)) return { wsId: ws, where: 'gateway' };
    for (const [slug, a] of Object.entries(raw.telegram.agents ?? {})) {
      if (a?.token === token && !(ws === exceptWs && slug === exceptSlug)) return { wsId: ws, where: 'agent', slug };
    }
  }
  return null;
}

const tokenInUseMsg = (used) => used.where === 'gateway'
  ? `이 봇 토큰은 이미 회사 텔레그램 연결(설정 화면)에서 사용 중입니다 (회사: ${used.wsId}). 텔레그램 봇 하나는 한 곳에만 연결할 수 있어요 — @BotFather로 전용 봇을 새로 만들거나, 기존 연결을 해제한 뒤 저장하세요.`
  : `이 봇 토큰은 이미 크루 직통 봇(${used.slug})에서 사용 중입니다 (회사: ${used.wsId}). 텔레그램 봇 하나는 한 곳에만 연결할 수 있어요 — @BotFather로 전용 봇을 새로 만들거나, 그 크루 카드에서 연결을 해제하세요.`;

export async function updateConnection(wsId, kind, patch) {
  if (!['telegram', 'slack'].includes(kind)) throw new Error('알 수 없는 연결 종류');
  // 저장 단일 관문에서 토큰 정제 — 검증(validateConnection)과 저장이 항상 같은 깨끗한 값을 쓰게 한다.
  // (빈 문자열은 "기존 유지" 신호라 그대로 두고, 아래에서 처리한다)
  if (patch && typeof patch.token === 'string' && patch.token !== '') patch = { ...patch, token: sanitizeToken(patch.token) };
  return withLock(lockKey(wsId), async () => {
    const all = await loadConnections(wsId);
    const next = { ...all[kind], ...patch };
    if (patch.token === '') next.token = all[kind].token; // 빈 토큰 = 기존 유지(토글만 바꿀 때)
    if (kind === 'telegram' && patch.token && patch.token !== all[kind].token) {
      const used = await findTelegramTokenUse(patch.token, { exceptWs: wsId, exceptGateway: true });
      if (used) throw new Error(tokenInUseMsg(used));
    }
    // 켜기 토글도 검사 — 레거시/동기화 유입 중복이 있으면 "왜 안 도는지"를 저장 시점에 알려준다
    // (매니저의 토큰 클레임이 실제 409는 막지만, 조용한 하트비트 에러보다 명시적 거절이 낫다)
    if (kind === 'telegram' && patch.enabled === true && next.token) {
      const used = await findTelegramTokenUse(next.token, { exceptWs: wsId, exceptGateway: true });
      if (used) throw new Error(tokenInUseMsg(used));
    }
    if (patch.token && patch.token !== all[kind].token) {
      next.chatId = null; // 토큰이 바뀌면 페어링 초기화
      next.botUserId = null;
      next.ownerId = null; next.pairCode = makePairCode(); // 새 토큰 = 새 페어링 코드(텔레그램·슬랙 공통)
    }
    // 토큰이 있는데 아직 미페어링이고 코드가 없으면 발급(레거시/초기 상태 보정)
    if (kind === 'telegram' && next.token && !next.chatId && !next.pairCode) next.pairCode = makePairCode();
    if (kind === 'slack' && next.token && !next.ownerId && !next.pairCode) next.pairCode = makePairCode();
    all[kind] = next;
    await writeJsonAtomic(paths(wsId).connections, all);
    return all;
  });
}

/** 화면용 — 토큰을 절대 그대로 내보내지 않는다. */
export function maskConnections(all) {
  const mask = (t) => (t ? `${t.slice(0, 3)}***` : ''); // 접두사 최소 노출(보안 규칙) — 뒤 3자도 감춤
  const agents = {};
  for (const [slug, a] of Object.entries(all.telegram.agents ?? {})) {
    agents[slug] = { botUsername: a.botUsername ?? '', paired: !!a.ownerId, hasToken: !!a.token, pairCode: a.ownerId ? '' : (a.pairCode || '') };
  }
  return {
    // pairCode는 미페어링일 때만 노출 — 페어링 후엔 화면에서 감춘다(더 이상 필요없고 재사용 방지)
    telegram: { ...all.telegram, token: mask(all.telegram.token), hasToken: !!all.telegram.token, pairCode: all.telegram.chatId ? '' : (all.telegram.pairCode || ''), agents },
    slack: { ...all.slack, token: mask(all.slack.token), hasToken: !!all.slack.token, paired: !!all.slack.ownerId, pairCode: all.slack.ownerId ? '' : (all.slack.pairCode || '') },
  };
}
