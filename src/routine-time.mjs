// 루틴 시각 판정 — 순수 모듈(노드 의존 0). routines.mjs에서 분리한 이유: 목록 화면
// (app/c/[ws]/routines/page.jsx — 클라이언트)이 '만료' 표시에 같은 판정을 써야 하는데,
// routines.mjs는 fs·워크스페이스에 묶여 클라이언트로 못 들어간다(device-paths.mjs 선례).
// 기존 소비자는 routines.mjs의 재수출로 그대로 동작한다 — 임포트 경로 이원화 없이 원천은 여기 하나.

/** 시간대 검증 — IANA 이름(Asia/Seoul 등)만. 못 알아보면 null(기기 로컬로 폴백).
    Intl이 유일한 판별기다 — 목록을 손으로 들고 있으면 낡는다. */
export function normalizeTz(tz) {
  const name = String(tz ?? '').trim();
  if (!name) return null;
  try { zonedFormat(name); return name; } catch { return null; }
}

// 시간대별 포맷터 캐시 — Intl.DateTimeFormat 생성이 판정 비용의 대부분이다(놓친 회차 판정은 루틴마다 최대 7일×8회차를 매 틱 계산한다 —
// 검수 측정: 캐시 없이 호출당 5~54ms). 시간대 이름 수만큼만 쌓인다(잘못된 이름은 생성자가 던져 캐시에 들어가지 않는다).
const FORMATS = new Map();
function zonedFormat(tz) {
  let f = FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    FORMATS.set(tz, f);
  }
  return f;
}

// 예약 시각을 놓쳐도(슬립·재시작으로 폴러가 그 분을 건너뜀) 당일 안에서 1회 catch-up 한다.
// 예전엔 정확히 그 분에만 due라, 그 분을 놓치면 그날은 조용히 스킵돼(아침 브리핑 유실) 스케줄러
// 신뢰가 무너졌다. 지연 상한(4h)으로 23:59에 09:00을 늦게 쏘는 것은 막는다. (isDue와 onceExpired가 공유)
export const CATCHUP_MS = 4 * 60 * 60 * 1000;

/** 주어진 시간대에서 본 now의 달력 조각. tz가 없으면 기기 로컬(구 동작 그대로).
    Intl로 뽑는 이유: Date는 기기 로컬과 UTC만 알고, 임의 IANA 시간대는 못 만든다.
    (export: 단위 테스트용 — 순수 함수) */
export function zonedParts(now, tz) {
  if (!tz) {
    return {
      year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
      hour: now.getHours(), minute: now.getMinutes(), dow: now.getDay(),
    };
  }
  const p = Object.fromEntries(zonedFormat(tz).formatToParts(now).map((x) => [x.type, x.value]));
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    // hourCycle에 따라 자정이 24로 오는 구현이 있다 — 0으로 정규화하지 않으면 00:00 루틴이 영원히 안 뜬다
    hour: Number(p.hour) % 24, minute: Number(p.minute), dow: DOW[p.weekday] ?? 0,
  };
}

/** once 슬롯이 이미 지났나 — 실패 시 끄기의 게이트(순수). 예약 시각 **전**의 실패(목록 '실행'으로
    미리 시험해 본 경우)에 꺼 버리면 살아 있는 미래 예약이 취소된다(검수 MEDIUM-1 실측). isDue와
    같은 시간대 규칙(zonedParts + schedule.tz). once가 아니면 false. (export: 단위 테스트용) */
export function onceSpent(schedule, now = new Date()) {
  if (schedule?.type !== 'once') return false;
  const zp = zonedParts(now, normalizeTz(schedule.tz));
  const today = `${zp.year}-${String(zp.month).padStart(2, '0')}-${String(zp.day).padStart(2, '0')}`;
  if (schedule.date !== today) return String(schedule.date ?? '') < today; // YYYY-MM-DD는 문자열 비교 = 날짜 비교
  // 시각 원천은 isDue와 동일하게 times 우선 — 오염 저장값(time≠times[0])에서 두 판정이 갈려
  // 발화 전 예약이 "경과"로 꺼지는 일이 없게 한다(2R LOW-B).
  const [h, m] = String((Array.isArray(schedule.times) && schedule.times[0]) || schedule.time || '').split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return true; // 오염된 시각 — 미래라고 단정할 수 없으니 기존(끄기) 쪽으로
  return zp.hour * 60 + zp.minute >= h * 60 + m;
}

/** 그 시간대의 벽시계(YYYY-MM-DD, HH:MM) → 절대 시각(ms). tz가 없으면 기기 로컬(isDue와 같은 규칙).
    JS는 임의 시간대의 Date를 못 만든다 — 벽시계를 UTC로 읽은 값에서 그 순간의 시간대 차이를 빼 맞춘다(두 번 — DST 경계 근사). */
export function zonedInstant(date, time, tz) { // export: 능동 비서의 아침·저녁 묶음 시각(src/assistant/rules.mjs) — 같은 규칙을 두 벌 두지 않는다
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  if (!tz) return new Date(y, mo - 1, d, h, mi).getTime();
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), tz);
    t += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return t;
}
const ymd = (p) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

/** 놓친 회차를 거슬러 찾는 기간 — 오래 꺼져 있던 기기가 켜져도 최근 일주일만 알린다(판정 계산량·알림 상한). */
export const MISSED_LOOKBACK_DAYS = 7;

/** 놓친 회차(순수) — catch-up 창(CATCHUP_MS)을 넘겨 isDue가 **다시는 발화하지 않을** 슬롯. 반환 [{ at(ISO), date, time }] 오래된 순.
    isDue는 창을 넘긴 슬롯을 조용히 건너뛴다(기기가 꺼져 있었으면 그날 회차가 기록 없이 사라졌다 — 2026-10-07 조사). 여기서 같은 규칙으로 그 슬롯을 찾는다:
    기준 시각(since) 이후 ~ now−CATCHUP_MS 이전. since = 마지막 실행(lastRun)·만든 시각(created)·사람이 고친 시각(editedAt) 중 가장 늦은 것 —
    고친 시각 이전 슬롯은 "꺼져 있었다"가 아니라 그때 꺼져 있었거나(enabled) 시각이 달랐던 것이라 놓침으로 치지 않는다(isDue보다 보수적: 덜 알린다).
    interval은 대상이 아니다(다음 틱에 자연 캐치업). 알려진 한계 — isDue의 DST 되돌림 결함(같은 슬롯 두 번 발화)과 같은 날의 벽시계 해석 차이. */
export function missedSlots(routine, now = new Date(), { lookbackDays = MISSED_LOOKBACK_DAYS } = {}) {
  if (!routine?.enabled) return [];
  const s = routine.schedule ?? {};
  if (s.type === 'interval') return [];
  const until = now.getTime() - CATCHUP_MS; // 이보다 늦은 슬롯은 아직 catch-up으로 발화할 수 있다
  const marks = [routine.lastRun, routine.created, routine.editedAt].map((v) => Date.parse(v ?? '')).filter(Number.isFinite);
  const since = Math.max(now.getTime() - lookbackDays * 86_400_000, ...marks);
  if (since >= until) return [];
  const tz = normalizeTz(s.tz);
  const times = (Array.isArray(s.times) && s.times.length ? s.times : [s.time]).filter((t) => /^\d{2}:\d{2}$/.test(String(t ?? '')));
  const dows = Array.isArray(s.dows) && s.dows.length ? s.dows.map(Number) : [Number(s.dow ?? 1)];
  let dates;
  if (s.type === 'once') dates = /^\d{4}-\d{2}-\d{2}$/.test(String(s.date ?? '')) ? [s.date] : [];
  else {
    // 그 시간대의 달력 날짜를 since가 속한 날부터 until이 속한 날까지 하루씩(최대 lookbackDays+1일)
    dates = [];
    const first = zonedParts(new Date(since), tz); const last = ymd(zonedParts(new Date(until), tz));
    for (let d = Date.UTC(first.year, first.month - 1, first.day), i = 0; i <= lookbackDays + 1; d += 86_400_000, i++) {
      const u = new Date(d);
      const date = `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, '0')}-${String(u.getUTCDate()).padStart(2, '0')}`;
      if (date > last) break;
      if (s.type !== 'weekly' || dows.includes(u.getUTCDay())) dates.push(date);
    }
  }
  const out = [];
  for (const date of dates) {
    for (const time of times) {
      const at = zonedInstant(date, time, tz);
      if (at > since && at < until) out.push({ at: new Date(at).toISOString(), date, time });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 놓친 회차 목록 → 사람이 읽는 한 줄(순수 — 엔진의 대화·알림 문구와 활동 화면이 같이 쓴다). 같은 날은 한 묶음,
    날짜가 많으면 앞 3일 + "외 N건". 예: ko '10월 8일 09:00·13:00, 10월 9일 09:00' / en 'Oct 8 09:00 · 13:00, Oct 9 09:00'. */
export function formatMissedSlots(slots, lang = 'ko') {
  const en = lang === 'en';
  const days = [];
  for (const { date, time } of slots ?? []) {
    const last = days.at(-1);
    if (last?.date === date) last.times.push(time); else days.push({ date, times: [time] });
  }
  const shown = days.slice(0, 3);
  const label = ({ date, times }) => {
    const [, m, d] = String(date).split('-').map(Number);
    return `${en ? `${MONTHS_EN[m - 1] ?? m} ${d}` : `${m}월 ${d}일`} ${times.join(en ? ' · ' : '·')}`;
  };
  const rest = days.slice(3).reduce((n, x) => n + x.times.length, 0);
  return shown.map(label).join(', ') + (rest ? (en ? ` and ${rest} more` : ` 외 ${rest}건`) : '');
}

/** 만료 판정(순수) — "한 번도 발화하지 못한 once": 예약 시각이 앱이 꺼진 사이 지나가 catch-up
    창(4h)까지 놓치면 enabled:true인 채 영영 발화하지 않고 목록에 '가동'으로 남는다(PR #354 검수
    3R 잔존 집합). 화면은 이런 루틴을 '만료'로 표시한다 — 표시만이고 자동 비활성은 하지 않는다:
    만료는 시간 경과로 스스로 참이 되는 **파생 사실**이라 표시가 틀려도 다음 렌더에 자가 수정되지만,
    쓰기(끄기)는 판정 오염(시계·시간대) 시 되돌릴 수 없고, 쓰는 주체(스케줄러 스위프)와 다기기
    동기화 경합 표면을 새로 만든다 — "소비 안 된 슬롯을 끄면 안 된다"(MEDIUM-1 계보)의 보수 원칙.

    창 판정은 onceSpent를 now−CATCHUP_MS에 적용한다 — 슬롯 경과 직후(창 안)는 만료가 아니다:
    앱이 이제 막 켜졌다면 다음 틱이 catch-up으로 발화한다(그때 '만료'라 하면 거짓 표시고, 삭제를
    유도하면 산 예약을 잃는다). lastRun이 슬롯 이후면(발화·선점 기록) 만료가 아니라 '실행됨'이다 —
    슬롯 이전 lastRun(미리 시험 실행)만으로는 슬롯이 소비되지 않았다(#354 MEDIUM-1과 같은 판정).

    알려진 한계(#364 검수 실측 — routine-once-expired 테스트의 DST 실행 문서 핀): DST **되돌림
    날**의 반복 시각대에 걸린 once는, isDue의 문서화된 되돌림 결함(routines.mjs isDue 주석 —
    벽시계 역산으로 창이 실질 연장)과 벽시계 기준인 이 판정이 어긋나, 되돌림 뒤 ~30분대 구간
    (실측 NY 2026-11-01, 총 ~30분 두 갈래)에서 **아직 발화 가능한 루틴이 '만료'로 표시**되고
    툴팁이 삭제를 권한다. 표시 전용이라 산 예약이 실제로 취소되진 않는다(자동 비활성을 기각한
    선택의 사후 정당화). 발생 조건 = 연 1일 × DST 시간대 × 반복 시각대 슬롯 × once(한국 무관).
    뿌리(isDue의 DST 역산)가 고쳐지면 함께 사라진다 — 그때 핀과 이 서술을 같이 갱신할 것. */
export function onceExpired(routine, now = new Date()) {
  if (!routine?.enabled || routine.schedule?.type !== 'once') return false;
  if (!onceSpent(routine.schedule, new Date(now.getTime() - CATCHUP_MS))) return false; // catch-up 창 안 — 아직 발화할 수 있다
  return !routine.lastRun || !onceSpent(routine.schedule, new Date(routine.lastRun));
}
