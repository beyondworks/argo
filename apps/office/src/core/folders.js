// 폴더 보기(유건 9/30) — 기록 화면 네 개(산출물·일지·결정·결재)가 같은 틀을 쓴다. 규칙은 test/folders.test.mjs.
// 기록 화면과 함께 지연 로드된다(첫 화면 JS 150KB 상한 — core/board.js는 첫 화면에 실린다).
import { kstDay } from './task-model.js';
import { fileKind } from './files.js';

/** 에이전트가 없는 항목(사람이 붙여 넣은 파일 등)이 모이는 폴더 */
export const HUMAN = 'people';
/** 폴더 열쇠 — 에이전트 id, id를 못 찾고 이름만 있으면(지운 에이전트의 일지) 이름, 둘 다 없으면 사람 */
export const folderKey = (crew, name) => crew || (name ? `name:${name}` : HUMAN);

/** 항목 → 폴더 목록(최근 활동순). key(x) 폴더 열쇠, at(x) 밀리초 시각. 폴더마다 건수·마지막 시각·가장 최근 항목(latest) */
export function folderize(items, key, at) {
  const m = new Map();
  for (const x of items) {
    const k = key(x), a = at(x) || 0, f = m.get(k);
    if (!f) m.set(k, { id: k, n: 1, last: a, latest: x });
    else { f.n += 1; if (a > f.last) { f.last = a; f.latest = x; } }
  }
  return [...m.values()].sort((a, b) => b.last - a.last);
}

/** ISO 시각 → 한국 날짜(YYYY-MM-DD). 비었거나 잘못된 값은 '' */
export const isoDay = (iso) => { const ms = Date.parse(iso ?? ''); return Number.isNaN(ms) ? '' : kstDay(new Date(ms)); };

const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 864e5;
const DAY = /^\d{4}-\d\d-\d\d$/;

/** 날짜 구간 — today · yesterday · week(이번 주, 월요일 시작) · month(이번 달) · m:YYYY-MM(그 이전은 월별).
 *  day·today는 한국 날짜 문자열. 날짜를 모르는 항목과 미래(시계 차이)는 오늘로 본다 */
export function dateBucket(day, today) {
  if (!DAY.test(day ?? '') || day >= today) return 'today';
  const diff = dayNum(today) - dayNum(day);
  if (diff === 1) return 'yesterday';
  const sinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  if (diff <= sinceMonday) return 'week';
  if (day.slice(0, 7) === today.slice(0, 7)) return 'month';
  return `m:${day.slice(0, 7)}`;
}

const RANK = ['today', 'yesterday', 'week', 'month'];
/** 항목을 날짜 구간으로 묶는다 — 구간 순서는 최근 먼저, 구간 안 순서는 들어온 순서 그대로 */
export function byDate(items, dayOf, today) {
  const m = new Map();
  for (const x of items) { const k = dateBucket(dayOf(x), today); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  const rank = (k) => { const i = RANK.indexOf(k); return i < 0 ? RANK.length : i; };
  return [...m].map(([key, list]) => ({ key, items: list }))
    .sort((a, b) => rank(a.key) - rank(b.key) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/** 일지 '전체' 폴더 — 하루 수십 건이 섞이지 않게 날짜마다 에이전트별 한 줄(건수 + 마지막 내용). entries: { day, time, ... } */
export function journalDigest(entries, key) {
  const m = new Map();
  for (const e of entries) {
    const k = `${e.day}|${key(e)}`, r = m.get(k);
    if (!r) m.set(k, { id: k, day: e.day, key: key(e), n: 1, latest: e });
    else { r.n += 1; if ((e.time ?? '') > (r.latest.time ?? '')) r.latest = e; }
  }
  return [...m.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || (b.latest.time ?? '').localeCompare(a.latest.time ?? ''));
}

const OFFICE_DOC = /\.(docx?|xlsx?|pptx?|hwpx?|odt|ods|odp|rtf|csv|pages|numbers|key)$/i;
/** 산출물 종류 필터 — 이미지 · 문서(미리보기 되는 글·pdf와 오피스 문서) · 기타. 미리보기 판정은 fileKind 그대로 */
export function fileGroup(name = '', mime = '') {
  const k = fileKind(name, mime);
  if (k === 'image') return 'image';
  return k === 'md' || k === 'text' || k === 'pdf' || OFFICE_DOC.test(name) ? 'doc' : 'other';
}

/** 결재 카드에서 바로 승인·거절할 수 있는지(유건 9/30 #7) — 결정 권한이 있고 위험도가 가장 높은 등급('high', DB 값은 low·high 둘)이 아닐 때만.
 *  가장 높은 등급은 카드 버튼 대신 '열어서 확인' — 상세 창에서 명령까지 보고 결정한다 */
export const canQuickDecide = (a) => a?.canDecide !== false && a?.risk !== 'high';
