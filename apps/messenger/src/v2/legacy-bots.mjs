// 이름 없는 옛 봇(유건 사용 검수 2026-10-23 "정체모를 이상한 이름의 봇들이 너무 많은데", "에이전트가 57명이 있네").
// 옛 v1 외부 봇(msgr_bot_create — slug 'bot-' + 16진 12자)의 자리를 10/16에 지운 뒤 남은 msgr_agents 행을 백필(20261020200700 _msgr2_bf_agents)이
// "이름 = slug, active"로 옮겼다. 자리·일·글이 없는 행이라 기본 목록에서 내리고 레일의 접힌 '기타(비활성)'에만 둔다. 데이터는 바꾸지 않는다(삭제는 맥 one 별건).
// 판정은 좁게: slug 모양 + 이름이 비었거나 slug 그대로 + 어느 공간에도 살아 있는 자리가 없음. 이름을 붙인 봇·자리가 있는 봇은 그대로 보인다. 순수(시험에서 그대로 부른다).
export const LEGACY_BOT_SLUG = /^bot-[0-9a-f]{12}$/;

/** 이름·slug 모양만 본 후보(자리는 부르는 쪽이 따로 본다) */
export const looksLegacyBot = (a) => LEGACY_BOT_SLUG.test(String(a?.slug ?? '')) && (!String(a?.display_name ?? '').trim() || a.display_name === a.slug);

/** 후보 중 자리가 없는 것에 _legacy_bot 표지. seatedIds = 살아 있는 자리가 있는 에이전트 id(Set). 모르면(null) 표지를 달지 않는다(숨기지 않는 쪽으로) */
export const markLegacyBots = (rows, seatedIds) => (rows ?? []).map((a) => (seatedIds && looksLegacyBot(a) && !seatedIds.has(a.id) ? { ...a, _legacy_bot: true } : a));

/** 표지로 나누기 — { agents: 보이는 것, legacy: 접힌 '기타' } */
export function splitLegacyBots(rows) {
  const agents = []; const legacy = [];
  for (const a of rows ?? []) (a?._legacy_bot ? legacy : agents).push(a);
  return { agents, legacy };
}
