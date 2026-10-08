// 능동 비서 판정 규칙(순수) — 회사 시간대의 날짜·시각, 조용한 시간, 아침·저녁 묶음 차례, 끈 목록, 사용자당 비서 1명.
// 시간대 규칙은 루틴과 같은 것을 쓴다(routine-time.mjs zonedParts·zonedInstant — tz가 없으면 기기 로컬).
import { zonedParts, zonedInstant } from '../routine-time.mjs';
import { channelSends } from '../channel-events.mjs';

export const GAP_MS = 2 * 60_000;        // 마지막 감시기 틱에서 이보다 오래 지났으면 잠자기·멈춤으로 본다(설계 4.2 2단계)
export const LEASE_FRESH_MS = 60_000;    // 리스 확인이 이보다 오래됐으면 이번 틱은 아무것도 하지 않는다(설계 4.2 1단계)

const pad = (n) => String(n).padStart(2, '0');
const ymd = (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** 그 시간대의 달력 날짜 'YYYY-MM-DD'. */
export const dateIn = (ms, tz) => ymd(zonedParts(new Date(ms), tz));
/** 그 시간대의 하루 중 분(0~1439). */
export const minuteIn = (ms, tz) => { const p = zonedParts(new Date(ms), tz); return p.hour * 60 + p.minute; };
/** 그 시간대의 'HH:MM'. */
export const hhmmIn = (ms, tz) => { const p = zonedParts(new Date(ms), tz); return `${pad(p.hour)}:${pad(p.minute)}`; };
/** 'YYYY-MM-DD' + n일(달력 계산 — 시간대와 무관). */
export function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const u = new Date(Date.UTC(y, m - 1, d + n));
  return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
}
/** 그 시간대에서 date의 hh:mm 절대 시각(ms). */
export const instantIn = (date, hhmm, tz) => zonedInstant(date, hhmm, tz);

/** 하루 중 분 m이 조용한 시간 from~to 안인가(순수) — 자정을 넘을 수 있다, 같으면 조용한 시간 없음. 설정 검증(settings.mjs)도 이 판정을 쓴다. */
export function minuteInQuiet(m, { from, to }) {
  if (from === to) return false;
  const f = toMin(from); const t = toMin(to);
  return f < t ? m >= f && m < t : m >= f || m < t;
}
/** 조용한 시간인가 — 회사 시간대의 지금 분으로 minuteInQuiet. */
export const inQuiet = (ms, cfg) => minuteInQuiet(minuteIn(ms, cfg.tz), cfg.quiet);

/** 지금 보낼 차례인 묶음 — { lane: 'am'|'pm', date, key } | null. done = 그날 처리한 묶음 날짜 { am, pm }(보냈거나, 넣을 것이 없어 건너뜀).
    조용한 시간이면 없다. 저녁 시각이 지났으면 저녁(그날 아침을 놓쳤어도 저녁이 대신한다), 아침 시각이 지났으면 아침. */
export function bundleDue(now, cfg, done = {}) {
  if (inQuiet(now, cfg)) return null;
  const date = dateIn(now, cfg.tz);
  const m = minuteIn(now, cfg.tz);
  if (m >= toMin(cfg.eveningAt)) return done.pm === date ? null : { lane: 'pm', date, key: `sum:pm:${date}` };
  if (m >= toMin(cfg.morningAt)) return done.am === date ? null : { lane: 'am', date, key: `sum:am:${date}` };
  return null;
}

/** 묶음 글의 유효 기한(ms) — 아침 묶음은 그날 저녁 묶음 시각까지, 저녁 묶음은 그날 자정까지("내일 일정"이 거짓이 되기 전).
    기한이 지나도록 못 보낸 묶음은 보내지 않고, 그 안의 지난 일정은 보류 목록으로 돌려 다음 묶음에 넣는다(tick.mjs). 꺼짐은 파일을 열지 않으므로(호출·쓰기 0)
    끈 채 날이 지나 다시 켠 경우도 이 기한이 낡은 묶음을 막는다. 아침 < 저녁은 설정 정규화가 보장한다(config.mjs). */
export const bundleUntil = (slot, cfg) => (slot.lane === 'am' ? instantIn(slot.date, cfg.eveningAt, cfg.tz) : instantIn(addDays(slot.date, 1), '00:00', cfg.tz));

/** 메신저 알림 종류에서 비서를 껐는가 — company.json msgr.mutedEvents(판정 정본 channelSends, 설계 12절 "알림 종류"). */
export const assistantMuted = (company) => !channelSends('msgr', { enabled: true, mutedEvents: company?.msgr?.mutedEvents }, 'assistant');

/** 같은 사용자의 회사들 중 비서를 맡을 회사(순수) — 켠(enabled + 에이전트 지정) 회사 가운데 켠 시각이 가장 늦은 쪽, 같으면 회사 id 사전순 앞.
    peers = [{ cid, ownerId, cfg }] (자기 포함). 일정·메일 계정은 사람 단위라 회사마다 켜면 같은 일정을 두 번 읽고 두 방에 따로 알린다(설계 3.2). */
export function assistantCompanyOf(peers, ownerId) {
  const on = peers.filter((p) => (p.ownerId ?? null) === (ownerId ?? null) && p.cfg?.enabled && p.cfg.agent);
  on.sort((a, b) => (b.cfg.enabledAt ?? -Infinity) - (a.cfg.enabledAt ?? -Infinity) || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  return on[0]?.cid ?? null;
}

/** 대기열 재시도 간격 — 1·2·4분, 그 뒤 5분 고정. 매 틱(1분) 재시도는 막힌 동안 분당 호출이 쌓이고(DB 위생), 15분까지 늘리면 시작 전 알림(10~60분 앞)이
    시작 전에 한 번도 다시 시도하지 못한다. 5분이면 막힌 사용자 1명당 시간당 최대 12회 시도(시도마다 내 크루 행 읽기 1 + 방 RPC 1). */
export const retryDelayMs = (tries) => Math.min(5, 2 ** Math.max(0, tries - 1)) * 60_000;
