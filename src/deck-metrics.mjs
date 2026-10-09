// 데크 지표(순수) — 화면(app/c/[ws]/page.jsx)·회사 API(app/api/companies/[ws]/route.js)·에이전트 상태 도구(src/argo-self.mjs)가 이 한 곳을 쓴다.
// 화면과 도구가 다른 숫자를 내지 않게 하려는 자리다: 셈법을 바꾸면 세 곳이 함께 바뀐다(test/deck-metrics.test.mjs가 잠근다).
// 클라이언트도 임포트하므로 node 전용 모듈을 들이지 않는다.
import { linkStats } from './memory-graph.mjs';

const DAY_MS = 86_400_000;

/** 회사 API의 stats — 연결 지표(link = linkStats의 links·linked·isolated), 오늘 기록, 종류별 수, 최근 14일 일별 적립.
    날짜는 UTC 날짜 문자열(문서 경로의 날짜와 같은 기준)이다 — 종전 라우트의 셈 그대로. */
export function docStats(docs, link, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  // 최근 14일 일별 적립 수 — 관제탑 바 차트용
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    daily.push({ date: d.slice(5), count: docs.filter((x) => x.rel.includes(d)).length });
  }
  return {
    ...link, // links(고유 쌍)·linked(링크 1개 이상인 기억)·isolated(고립, 안내 노트 제외)
    today: docs.filter((d) => d.rel.includes(today)).length,
    conversations: docs.filter((d) => d.dir !== 'notes').length, // 일지 + 구버전 기록
    notes: docs.filter((d) => d.dir === 'notes').length,
    daily,
  };
}

/** '기억 연결' 다이얼 값(0~100, 반올림 전) — 링크가 1개 이상인 기억 / (연결 + 고립). 100%면 정말 모든 기억이 엮인 것.
    분모를 memoryCount가 아니라 linked+isolated로 두는 이유: 스캐폴드 안내 노트(링크 0)는 기억이 아니라서 빼야 신규 회사도 100%에 닿는다(검수 L-1).
    예전 links/(n−1)은 쌍 수가 n−1(신장 트리)을 넘는 순간 100%로 포화해 정보가 0이었다(제보 2026-09-02: 10,075쌍/2,263건 상시 100%). */
export function linkedPercent(stats) {
  return stats && stats.linked + stats.isolated > 0 ? (stats.linked / (stats.linked + stats.isolated)) * 100 : 0;
}

/** 다이얼이 글자로 보여 주는 값 — ui.jsx Dial과 같은 자르기·반올림(0~100, 정수). */
export const dialPercent = (pct) => Math.round(Math.min(Math.max(Number(pct) || 0, 0), 100));

/** '이번 주 배운 주제' — 최근 7일 안에 바뀐 지식 노트 수(데크 기억 카드 아래 줄). */
export function learnedThisWeek(docs, now = Date.now()) {
  const week = now - 7 * DAY_MS;
  return (docs ?? []).filter((d) => d.dir === 'notes' && d.mtime > week).length;
}

/** 데크 계기판 숫자 전체(도구용) — docs = listDocs(wsId), agentCount = 에이전트 수. 회사 API와 같은 재료·같은 함수로 계산한다. */
export function deckMetrics({ docs = [], agentCount = 0, now = Date.now() } = {}) {
  const { deg: _deg, ...link } = linkStats(docs);
  const stats = docStats(docs, link, now);
  const pct = linkedPercent(stats);
  return {
    memoryCount: docs.length,
    today: stats.today,
    notes: stats.notes,
    conversations: stats.conversations,
    learnedThisWeek: learnedThisWeek(docs, now),
    agents: agentCount,
    links: stats.links,
    linked: stats.linked,
    isolated: stats.isolated,
    guides: docs.filter((d) => d.guide).length, // 안내 노트 — 연결 지표 밖
    linkedPercent: pct,
    linkedPercentShown: dialPercent(pct),
    daily: stats.daily,
  };
}
