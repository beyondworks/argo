// 인바운드 지시 → 크루 라우팅 판정 — @멘션 파싱·기본 크루 선택·크루 현황 즉답·결재 주체 표기.
// 크루 명단(listAgents)·회사 설정(loadCompany) 파일 읽기뿐이라 임시 ARGO_ROOT로 단위 테스트 가능한
// 이음매(gateway.mjs 분해). 옮긴 코드는 원문 그대로(행동 불변) — 주석 동반 이동.
import { listAgents } from '../hub.mjs';
import { loadCompany } from '../workspace.mjs';
import { pick } from './protocol.mjs';

/** "@이름 지시" → to 크루, "@이름1 @이름2 지시" → 첫 번째가 to, 나머지는 cc(맥락 공유). 이름 미지정이면 기본 크루. (export는 테스트용) */
export async function routeMessage(wsId, cfg, text) {
  const agents = await listAgents(wsId);
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  if (!agents.length) return { error: pick('아직 크루가 없습니다. Argo 데크에서 먼저 영입해 주세요.', 'No crew yet. Hire your first crew from the Argo deck.', lang) };
  let body = text.trim();
  // 그룹방에서 봇 멘션(@봇이름)으로 시작하면 벗겨낸다 — 그 뒤의 @크루 멘션이 라우팅 대상
  if (cfg.botUsername) body = body.replace(new RegExp(`^@?${cfg.botUsername.replace(/^@/, '')}\\s+`, 'i'), '');
  const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase(); // 한글 NFC/NFD 불일치 방어 — 파일 유래 이름과 입력 이름의 유니코드가 다를 수 있다
  const find = (key) => agents.find((a) => norm(a.slug) === norm(key) || norm(a.name) === norm(key));
  const mentions = [];
  let m;
  while ((m = body.match(/^@(\S+)\s+/))) {
    const target = find(m[1]);
    if (!target) break; // 크루가 아닌 @단어는 본문의 일부로 남긴다
    if (!mentions.some((a) => a.slug === target.slug)) mentions.push(target);
    body = body.slice(m[0].length);
  }
  if (!mentions.length && /^@\S+\s+\S/.test(body)) {
    const bad = body.match(/^@(\S+)/)[1];
    return { error: pick(
      `"${bad}" 크루를 못 찾았습니다. 크루: ${agents.map((a) => a.name).join(', ')} — "크루"라고 보내면 현황을 보여드립니다.`,
      `Couldn't find crew "${bad}". Crew: ${agents.map((a) => a.name).join(', ')} — send "crew" to see the roster.`,
      lang,
    ) };
  }
  const to = mentions[0] ?? (agents.find((a) => a.slug === cfg.defaultCrew) ?? agents[0]);
  return { slug: to.slug, name: to.name, msg: body.trim(), cc: mentions.slice(1) };
}

/** "크루"/"/crew"/"현황" — 어떤 크루가 이 채팅에 연결되어 있는지 즉답(모델 호출 없음). */
export async function crewStatusReply(wsId, cfg) {
  const agents = await listAgents(wsId);
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({}));
  if (!agents.length) return pick('아직 크루가 없습니다. Argo 데크에서 먼저 영입해 주세요.', 'No crew yet. Hire your first crew from the Argo deck.', lang);
  const def = agents.find((a) => a.slug === cfg.defaultCrew) ?? agents[0];
  return [
    pick(`**연결된 크루 ${agents.length}명**`, `**${agents.length} crew connected**`, lang),
    ...agents.map((a) => `• ${a.name} (@${a.slug})${a.role ? ` — ${a.role}` : ''}${a.runner ? ` · ${a.runner}` : ''}${a.slug === def?.slug ? pick(' · 기본', ' · default', lang) : ''}`),
    '',
    pick(
      '"@이름 지시"로 특정 크루를 부르고, "@이름1 @이름2 지시"처럼 여러 명을 적으면 첫 번째가 실행하고 나머지에게 맥락이 공유됩니다(cc).',
      'Address a specific crew with "@name instruction". List several like "@name1 @name2 instruction" and the first one acts while the rest receive the shared context (cc).',
      lang,
    ),
  ].join('\n');
}

/** 결재 주체 표기 — "크루명" 또는 "크루명 (위임자명 위임)". 누가 올린 결재인지 흐름을 보이게 한다. */
export async function approvalWho(wsId, item, lang) {
  const agents = await listAgents(wsId).catch(() => []);
  const nameOf = (s) => agents.find((a) => a.slug === s)?.name ?? s;
  const base = nameOf(item.slug);
  return item.from ? (lang === 'en' ? `${base} (delegated by ${nameOf(item.from)})` : `${base} (${nameOf(item.from)} 위임)`) : base;
}
