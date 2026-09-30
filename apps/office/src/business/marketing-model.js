// 마케팅 화면 계산(유건 9/29 "비전문가도 쓰게") — 캠페인마다 카드 한 장, 효과는 "광고비의 N배" 문장으로.
const STATUS_ORDER = { active: 0, paused: 1, archived: 2 };
const STAT_KEYS = ['spend', 'orders', 'sales', 'paid'];
const pick = (row) => Object.fromEntries(STAT_KEYS.map((key) => [key, Number(row?.[key] ?? 0)]));

/** 모든 캠페인을 카드로 — 기간 숫자가 없는 캠페인은 0, 진행 중 → 멈춤 → 보관, 같은 상태는 최근 시작 먼저 */
export function campaignCards(campaigns, reportRows) {
  const byId = new Map((reportRows ?? []).filter((row) => row.id).map((row) => [row.id, row]));
  return (campaigns ?? []).map((campaign) => ({ ...campaign, stats: pick(byId.get(campaign.id)) }))
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || String(b.starts_on).localeCompare(String(a.starts_on)));
}

/** 효과 문장의 종류 — 매출이 광고비 이상일 때만 배수를 말한다(그 아래는 '광고비보다 적다') */
export function effectOf({ spend, sales }) {
  if (spend > 0 && sales >= spend) return { kind: 'times', times: Math.round(sales / spend * 10) / 10 };
  if (spend > 0 && sales > 0) return { kind: 'less' };
  if (spend > 0) return { kind: 'noSales' };
  return { kind: sales > 0 ? 'noSpend' : 'empty' };
}

/** 광고로 들어온 합계 — 캠페인에 연결된 거래만(경로 모름 줄은 뺀다) */
export function linkedTotals(reportRows) {
  const rows = (reportRows ?? []).filter((row) => row.id).map(pick);
  return Object.fromEntries(STAT_KEYS.map((key) => [key, rows.reduce((sum, row) => sum + row[key], 0)]));
}
