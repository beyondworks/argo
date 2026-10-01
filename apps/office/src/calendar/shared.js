// 달력 화면과 홈 '다가오는 일정' 모듈이 같이 쓰는 것 — 공간별 거르기·캘린더 구분·색·날짜 글자.
import { CALENDAR_COLORS, calendarColorIndex } from '@msgr/crew-face';
import { ME, SPACES } from '../core/session.js';
import { getState } from '../core/store.js';
import { getLang } from '../core/i18n.js';
import { colorKey, hashIndex } from './model.js';

/** 조직 공간 — 서버 id(예시 모드는 키) */
export const orgSpaces = () => SPACES.filter((s) => s.kind === 'org');
export const idOf = (s) => s.id ?? s.key;
export const spaceOfOrg = (id) => orgSpaces().find((s) => idOf(s) === id);
/** 일정을 만들 수 있는 조직(손님 제외) */
export const writableOrgs = () => orgSpaces().filter((s) => s.role !== 'guest');

/** 이 공간에 보일 일정 — 개인 공간은 전부(개인 + 속한 조직), 조직 공간은 그 조직 것만 */
export function inSpace(events, space) {
  if (space === 'me') return events;
  const org = SPACES.find((s) => s.key === space);
  return org ? events.filter((e) => e.org_id === idOf(org)) : [];
}
/** 왼쪽 목록의 캘린더 구분 — 개인 공간: 'me' | 조직 id, 조직 공간: 'mine'(내가 주인·참석) | 'others' */
export const calOf = (e, space) => (space === 'me' ? e.org_id ?? 'me' : e.owner === ME.id || e.attendees?.includes(ME.id) ? 'mine' : 'others');

/** 색 — 분류·사람은 이름에서 고정 색, 에이전트는 그 에이전트 얼굴 색. 정하지 않으면 undefined(중립 회색) */
export function colorOf(o, by) {
  const key = colorKey(o, by);
  if (!key) return undefined;
  if (key.agent) return CALENDAR_COLORS[calendarColorIndex(key.agent, getState().crews?.find((c) => c.id === key.agent)?.face ?? null)]; // 얼굴 v2와 별개로 예전 달력 색 그대로(검수 #789)
  return CALENDAR_COLORS[hashIndex(key.hash, CALENDAR_COLORS.length)];
}

export const locale = () => (getLang() === 'en' ? 'en-US' : 'ko-KR');
/** 날짜 문자열 글자(시간대 영향 없음) */
export const fmtDay = (day, opts) => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale(), { timeZone: 'UTC', ...opts });
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });

/** 읽기 전용 편의 설정(보기·색 기준·끈 캘린더) — 보는 사람 브라우저에만 */
export const pref = (key, fallback) => { try { const v = localStorage.getItem(`argo-office-cal-${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
export const setPref = (key, value) => { try { localStorage.setItem(`argo-office-cal-${key}`, JSON.stringify(value)); } catch { /* 사생활 보호 모드 — 이번만 */ } };
