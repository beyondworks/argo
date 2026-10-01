// "다시 연결"이 토큰만 새로 받을 기존 봇을 고른다 — 없으면 null(새로 만든다).
// - external_id가 있으면(앱이 이 컴퓨터의 에이전트를 찾은 경우): 같은 종류·같은 에이전트의 내 봇.
// - external_id가 없으면(브라우저·다른 컴퓨터용 수동 연결): 같은 종류이면서 external_id가 없고 이름이 같은 내 봇.
//   이름이 다른 수동 봇("다른 에이전트 추가"로 만든 것)이나 앱이 연결해 둔 봇의 토큰을 바꾸면 그쪽 연결이 끊기므로 건드리지 않는다.
export function findReusableBot(bots, { kind, uid, name, extId }) {
  return (bots ?? []).find((b) => !b.revoked_at && b.kind === kind && b.created_by === uid
    && (extId ? b.external_id === extId : !b.external_id && b.name === name)) ?? null;
}
