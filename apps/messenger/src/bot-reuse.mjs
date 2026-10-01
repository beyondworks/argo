// "다시 연결"이 토큰만 새로 받을 기존 봇을 고른다 — 없으면 null(새로 만든다). 회전하면 그 봇의 이전 토큰은 즉시 무효이므로
// 찾는 범위를 좁게 둔다.
// - external_id가 있으면(앱이 이 컴퓨터의 에이전트를 찾은 경우): 같은 종류·같은 에이전트의 내 봇.
// - external_id가 없으면(브라우저·다른 컴퓨터용 수동 연결): 호출하는 쪽이 "다시 연결" 버튼일 때만 names(기본 이름 목록)를 준다.
//   names가 없으면 절대 재사용하지 않는다 — "다른 에이전트"(custom)·"하나 더 추가"가 이름이 같다는 이유로 이미 연결된 봇의 토큰을 끊으면 안 된다.
//   names는 화면 언어별 기본 이름을 모두 담아(언어를 바꿔도 같은 봇을 찾는다), 이름이 다른 수동 봇은 건드리지 않는다.
// 같은 조건이 여럿이면 가장 최근에 만든 봇 하나.
const newest = (list) => list.reduce((a, b) => (!a || Date.parse(b.created_at ?? 0) >= Date.parse(a.created_at ?? 0) ? b : a), null);

export function findReusableBot(bots, { kind, uid, extId, names }) {
  const mine = (bots ?? []).filter((b) => !b.revoked_at && b.kind === kind && b.created_by === uid);
  if (extId) return mine.find((b) => b.external_id === extId) ?? null;
  if (!names?.length) return null;
  return newest(mine.filter((b) => !b.external_id && names.includes(b.name)));
}

// 버튼 라벨("다시 연결")이 실제 재사용 판정과 같게 — 브라우저는 수동 재사용 대상이 있을 때만,
// 데스크톱 앱은 이 컴퓨터의 에이전트를 찾아 external_id로 다시 연결하므로 내 봇이 하나라도 있으면.
export function canReconnect(bots, { kind, uid, names, desktop = false }) {
  if (desktop) return (bots ?? []).some((b) => !b.revoked_at && b.kind === kind && b.created_by === uid);
  return !!findReusableBot(bots, { kind, uid, extId: null, names });
}

// "다시 연결"이 찾는 기본 이름 — 화면 언어를 바꿔도 같은 봇을 찾도록 한국어·영어 이름을 모두 돌려준다(tm = 사전 t(키, 언어, 변수)).
export function botDefaultNames(tm, { who, kind }) {
  return ['ko', 'en'].map((l) => tm('org.agents.name.mine', l, { who, kind: tm(`org.agents.kind.${kind}`, l) }));
}
