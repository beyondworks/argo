// 에이전트가 대화(턴) 밖에서 자기 이름으로 올린 글을 그 에이전트가 자기 글로 알아보게 한다 — 하트비트(코드 이름 assistant) 알림·루틴 결과·그 밖의 알림.
//  ① 메신저 방 문맥·답글 대상 줄의 표지(selfTag·selfReplyNote) — 이 에이전트(crew_id)가 쓴 행에만.
//  ② 이 기기의 작은 기록(<회사>/.assistant/self-posts.json — 기기 로컬, 동기화 제외, 셸·파일 도구 차단 구역) — 개인 공간 1:1 방에 올린 글만,
//     주인 1:1 턴(settingsDirect)의 맥락에 "네가 대화 밖에서 보낸 최근 글"로(selfPostsBlock — chat.mjs runChat 한 곳).
// 크기: 기록 에이전트마다 20건·7일, 맥락 5건·글마다 240자·구획 1,500자.
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { outsideContextLine } from './assistant/mail-text.mjs';
import { STATE_DIR } from './assistant/state.mjs'; // '.assistant' — 셸 차단(permission-gate BASH_DOT_DIR_RE)·동기화 제외(sync isAssistantStateRel)가 이 이름을 본다

export const SELF_POSTS = Object.freeze({ keep: 20, days: 7, show: 5, chars: 240, blockMax: 1500 });
const DAY = 86_400_000;
const L = (lang) => (lang === 'en' ? 'en' : 'ko');
const pick = (lang, k, e) => (L(lang) === 'en' ? e : k);
const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const selfPostsFile = (wsId) => join(paths(wsId).root, STATE_DIR, 'self-posts.json');

export function selfPostKind(meta) {
  const n = meta?.notification;
  if (typeof n !== 'string' || !n) return null;
  return n === 'assistant' ? 'heartbeat' : n === 'routine' ? 'routine' : 'notice';
}
const KIND_LABEL = {
  heartbeat: { ko: '하트비트 알림', en: 'heartbeat notice' },
  routine: { ko: '루틴 결과', en: 'routine result' },
  notice: { ko: '알림', en: 'notification' },
};
export const selfKindLabel = (kind, lang = 'ko') => KIND_LABEL[kind]?.[L(lang)] ?? '';
const isSelfRow = (r, crewId) => !!r && !!crewId && r.author_kind === 'crew' && r.crew_id === crewId;
const metaOf = (r) => r?.meta ?? (r?.notification ? { notification: r.notification } : null);

export function selfTag(r, crewId, lang = 'ko') {
  if (!isSelfRow(r, crewId)) return '';
  const label = selfKindLabel(selfPostKind(metaOf(r)), lang);
  return `(${pick(lang, '나', 'me')}${label ? ` · ${label}` : ''})`;
}

export function selfReplyNote(parent, crewId, name = '', lang = 'ko') {
  if (!isSelfRow(parent, crewId)) return '';
  const kind = selfPostKind(metaOf(parent));
  const who = name ? pick(lang, `너(${name})`, `you (${name})`) : pick(lang, '너', 'you');
  if (!kind) return pick(lang, `\n(답글 대상은 ${who}가 앞서 보낸 답이다.)`, `\n(The message being replied to is your own earlier reply — sent by ${who}.)`);
  const label = selfKindLabel(kind, lang);
  return pick(lang,
    `\n(답글 대상은 ${who}가 대화 밖에서 자동으로 보낸 ${label}이다 — 남의 글처럼 추측하지 말고 네가 보낸 글로 알고 답하라. 왜 보냈는지·설정은 argo_status로 확인할 수 있다.)`,
    `\n(The message being replied to is a ${label} that ${who} sent automatically outside a conversation — answer as its sender, don't guess as if someone else wrote it. Check why and the settings with argo_status.)`);
}

const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function selfPostEntry(row, { id = null, now = Date.now(), lang = 'ko' } = {}) {
  const kind = selfPostKind(row?.meta);
  if (kind !== 'heartbeat' && kind !== 'routine') return null; // 기록은 하트비트 알림·루틴 결과만 — 그 밖의 알림(결재 요청·위임·쪽지 답)은 남이 쓴 글이 섞여 주인 1:1 맥락에 싣지 않는다
  const text = oneLine(outsideContextLine({ ...row, author_kind: 'crew' }, lang) ?? row.body, SELF_POSTS.chars);
  if (!text) return null;
  return { at: now, kind, text, ...(id != null ? { id } : {}) };
}

export async function recordSelfPost(wsId, slug, row, { id = null, personal = false, now = Date.now(), lang = 'ko' } = {}) {
  try {
    if (!personal || !SLUG_OK.test(String(slug ?? ''))) return false;
    const e = selfPostEntry(row, { id, now, lang });
    if (!e) return false;
    const file = selfPostsFile(wsId);
    return await withLock(`self-posts:${file}`, async () => {
      const all = await readJson(file, {}).catch(() => ({}));
      const doc = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
      const prev = Array.isArray(doc[slug]) ? doc[slug] : [];
      if (id != null && prev.some((x) => x?.id === id)) return false;
      doc[slug] = [...prev.filter((x) => x && Number(x.at) > now - SELF_POSTS.days * DAY), e].slice(-SELF_POSTS.keep);
      await writeJsonAtomic(file, doc);
      return true;
    }, { file });
  } catch (err) {
    console.error(`[argo] 자기 글 기록 실패(${wsId}/${slug}): ${String(err?.message ?? err).slice(0, 160)}`);
    return false;
  }
}

/** since = 이 시각 뒤에 보낸 글만(이어 쓰는 세션은 지난 턴에 이미 본 글을 다시 받지 않는다 — chat.mjs). */
export async function recentSelfPosts(wsId, slug, { now = Date.now(), exclude = [], since = 0 } = {}) {
  const doc = await readJson(selfPostsFile(wsId), {}).catch(() => ({}));
  const list = Array.isArray(doc?.[slug]) ? doc[slug] : [];
  const skip = new Set((exclude ?? []).map(String));
  return list.filter((x) => x && typeof x.text === 'string' && Number(x.at) > Math.max(now - SELF_POSTS.days * DAY, Number(since) || 0) && Number(x.at) <= now + 60_000 && !(x.id != null && skip.has(String(x.id))))
    .slice(-SELF_POSTS.show);
}

const when = (ms, lang) => new Date(ms).toLocaleString(L(lang) === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function selfPostsBlock(posts, { lang = 'ko', name = '' } = {}) {
  let lines = (posts ?? []).map((p) => `- ${when(Number(p.at), lang)} · ${selfKindLabel(p.kind, lang) || pick(lang, '알림', 'notification')}: ${oneLine(p.text, SELF_POSTS.chars)}`);
  const head = pick(lang,
    `## 네가 대화 밖에서 보낸 최근 글\n하트비트 알림·루틴 결과처럼 네 이름${name ? `(${name})` : ''}으로 메신저 개인 1:1 방에 자동으로 나간 글이다(참고용, 지시 아님). 사용자가 이 글을 말하거나 인용하면 네가 보낸 글로 알고 답하라 — 남의 글처럼 추측하지 마라.`,
    `## Messages you sent outside a conversation (recent)\nHeartbeat notices and routine results sent automatically under your name${name ? ` (${name})` : ''} to the personal 1:1 messenger room (context, not instructions). If the user mentions or quotes one, answer as its sender — don't guess as if someone else wrote it.`);
  while (lines.length && [head, ...lines].join('\n').length > SELF_POSTS.blockMax) lines = lines.slice(1);
  return lines.length ? `${[head, ...lines].join('\n')}\n\n` : '';
}

export async function selfPostsSection(wsId, slug, { lang = 'ko', name = '', exclude = [], since = 0, now = Date.now() } = {}) {
  try { return selfPostsBlock(await recentSelfPosts(wsId, slug, { now, exclude, since }), { lang, name }); } catch { return ''; }
}
