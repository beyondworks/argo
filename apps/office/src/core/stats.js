// 현황 카드 — 카드 한 장 = 지표 하나. 사용자가 카드마다 지표를 고른다(유건 2026-09-27: "4~5개, 카드 역할을 각각 선택").
// spaces: 이 지표를 쓸 수 있는 공간 종류. 값 계산은 화면(modules.jsx)이 하고, 여기는 고르기 규칙만.
export const STATS = {
  approvals: ['me', 'org'], work: ['me', 'org'], mail: ['me'], crews: ['me', 'org'],
  todos: ['me'], decisions: ['org'], outputs: ['org'], pages: ['me', 'org'],
};
export const MAX_CARDS = 5;
export const STAT_DEFAULTS = { me: ['approvals', 'work', 'mail', 'crews', 'todos'], org: ['approvals', 'work', 'decisions', 'outputs', 'crews'] };
export const statsFor = (kind) => Object.keys(STATS).filter((k) => STATS[k].includes(kind));

/** 저장된 카드 목록 → 보여 줄 카드. 공간에 없는 지표·모르는 지표·중복은 빼고 5장까지, 남는 게 없으면 기본 세트 */
export function pickCards(saved, kind) {
  const ok = statsFor(kind);
  const list = Array.isArray(saved) ? [...new Set(saved)].filter((k) => ok.includes(k)).slice(0, MAX_CARDS) : [];
  return list.length ? list : STAT_DEFAULTS[kind];
}
