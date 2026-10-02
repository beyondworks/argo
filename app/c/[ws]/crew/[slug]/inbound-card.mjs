// 1:1 화면의 바깥 글 카드 — 판정·출처 줄·앞부분 요약(순수 함수, AI 호출 없음).
// 바깥 글 = 크루 1:1 기록의 who:'user' 중 사장이 이 방에서 직접 치지 않은 것(메신저·루틴·쪽지·위임·장시간 작업·회의실·결재 결과).
// 마크다운 프롬프트 원문이 길게 올라와 읽기 어렵다는 제보(2026-10-02)로, 출처 줄 + 앞 2줄 플레인 텍스트로 접는다.
// 판정은 기록의 구조화 필드(via·contextScope·actor)가 먼저다. 필드가 없는 결재 결과와 필드에 없는 이름(채널·루틴 제목·보낸 크루)만
// 머리말에서 읽고, 머리말은 기록을 만드는 쪽과 같은 함수(src/inbound-marks.mjs)로 맞춰 본다.
import { parseMsgr, parseRoutine, parseMail, parseDelegate, parseJob, parseApproval } from '../../../../../src/inbound-marks.mjs';
import { viaSummary } from './via-summary.mjs';
import { stripLoopVerdict } from '../../../../../src/loop-verdict.mjs';

const VIA_KINDS = new Set(['crewmail', 'delegate', 'routine', 'job', 'room']);
const MSGR_SCOPES = new Set(['msgr', 'msgr-dm']);

/** 바깥 글이면 종류, 사장이 직접 친 글·크루 답이면 null */
export function inboundKind(m) {
  if (!m || m.who !== 'user') return null;
  const scope = m.contextScope?.kind;
  if (m.via === 'msgr') return scope === 'msgr-dm' ? 'msgr-dm' : 'msgr';
  if (m.via) return VIA_KINDS.has(m.via) ? m.via : 'generic'; // 모르는 via = 새 버전 기기에서 동기화된 기록
  const text = String(m.text ?? '');
  if (parseApproval(text)) return 'approval'; // 결재 후속 턴만 via가 없다(메신저발 결재는 메신저 범위가 함께 붙는다)
  if (MSGR_SCOPES.has(scope)) return scope; // 데스크톱 채팅은 범위를 남기지 않는다 — 메신저 범위 = 메신저에서 온 글
  return null;
}

/** 카드 재료: { kind, channel?, name?, title?, cc?, captain?, body, context?, replyTo? }
    body = 머리말·참고 대화·프로토콜·회신 안내를 뺀 본문(접힌 요약 재료이자 펼친 화면의 본문 — 크루용 지시문은 화면에 안 보인다).
    context·replyTo = 메신저 참고 대화·답글 원글(펼친 화면에서 작게 접어 둔다). 머리말을 못 알아보면 body = 원문 그대로. */
export function inboundCard(m) {
  const kind = inboundKind(m);
  if (!kind) return null;
  const text = String(m.text ?? '');
  const actor = typeof m.actor?.name === 'string' ? m.actor.name : '';
  switch (kind) {
    case 'msgr':
    case 'msgr-dm': {
      const p = parseMsgr(text, actor.split(' ← ')[0]); // 넘긴 턴의 actor = '넘긴 크루 ← 사람', 본문 줄 앞 이름은 넘긴 크루
      return { kind, channel: p?.channel ?? '', name: actor, body: p ? p.body : text, context: p?.context ?? [], replyTo: p?.replyTo ?? '' };
    }
    case 'routine': {
      const p = parseRoutine(text);
      return { kind: p?.loop ? 'loop' : 'routine', title: p?.title ?? '', body: p ? p.body : text };
    }
    case 'crewmail': {
      const p = parseMail(text);
      return p ? { kind, name: p.fromName, cc: p.cc, captain: p.captain, body: p.body } : { kind, body: text };
    }
    case 'delegate': {
      const p = parseDelegate(text);
      return { kind, name: p?.fromName ?? '', body: p ? p.body : text };
    }
    case 'job': return { kind, body: parseJob(text)?.body ?? text };
    case 'room': return { kind, body: viaSummary('room', text) };
    case 'approval': return { kind, body: parseApproval(text).body };
    default: return { kind, body: text };
  }
}

const LABEL = {
  msgr: 'chat.inbound.msgr', 'msgr-dm': 'chat.inbound.msgrDm', routine: 'chat.inbound.routine', loop: 'chat.inbound.loop',
  crewmail: 'chat.inbound.crewmail', delegate: 'chat.inbound.delegate', job: 'chat.inbound.job', room: 'chat.inbound.room',
  approval: 'chat.inbound.approval', generic: 'chat.inbound.generic',
};

/** 출처 줄 — 예: '메신저 · #마케팅 · 김OO', '루틴 · 아침 보고', '쪽지 · 페퍼에게서'. t = i18n 사전 함수 */
export function sourceLine(card, t) {
  const parts = [t(LABEL[card.kind] ?? LABEL.generic)];
  if (card.kind === 'msgr' && card.channel) parts.push(`#${card.channel}`);
  if (card.title) parts.push(card.title);
  if (card.captain) parts.push(t('chat.inbound.captainShared'));
  else if (card.name) parts.push(card.kind === 'msgr' || card.kind === 'msgr-dm' ? card.name : t('chat.inbound.from', { name: card.name }));
  if (card.cc) parts.push(t('chat.inbound.cc'));
  return parts.join(' · ');
}

export const PREVIEW_CHARS = 120;
export const PREVIEW_LINES = 2;

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** 한 줄의 마크다운 기호를 걷어 낸다 — 글자는 남기고 서식 기호만 */
function plainLine(line) {
  let s = line;
  if (/^\s*\|.*\|\s*$/.test(s)) s = s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
  s = s.replace(/^\s*(>\s?)+/, '') // 인용
    .replace(/^\s*#{1,6}\s+/, '') // 제목
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') // 목록
    .replace(/^\s*\[[ xX]\]\s+/, '') // 할 일 상자
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 그림 — 링크보다 먼저(같은 [..](..) 꼴을 품는다)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/(^|[^\p{L}\p{N}*])\*(?=[^\s*])([^*]*?[^\s*])\*(?=[^\p{L}\p{N}*]|$)/gu, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?=[^\p{L}\p{N}_]|$)/gu, '$1$2'); // a_b_c 같은 이름은 그대로
  return s.replace(/\s+/g, ' ').trim();
}

/** 글자(자소 묶음) 단위로 나눈다 — 조합형 한글(NFD)·이모지가 반쪽으로 잘리지 않게 */
function graphemes(s) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
  return Array.from(s);
}

/** 앞 2줄(약 120자) 플레인 텍스트 요약. 넘치면 글자 경계(가까운 띄어쓰기가 있으면 거기)에서 자르고 '…' */
export function plainPreview(text, { max = PREVIEW_CHARS, lines = PREVIEW_LINES } = {}) {
  const all = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .filter((l) => !FENCE.test(l) && !TABLE_SEP.test(l) && !RULE.test(l))
    .map(plainLine).filter(Boolean);
  let out = all.slice(0, lines).join('\n');
  let truncated = all.length > lines;
  const g = graphemes(out);
  if (g.length > max) {
    let cut = max;
    for (let i = max; i > max - 12 && i > 0; i -= 1) if (/\s/.test(g[i])) { cut = i; break; } // 단어 중간을 피한다
    out = g.slice(0, cut).join('').trimEnd();
    truncated = true;
  }
  return { text: truncated && out ? `${out}…` : out, truncated };
}

/** 크루 답의 표시 문장 — 루프 루틴 지시 바로 뒤의 답이면 끝의 판정 표지(LOOP: …)를 뺀다(엔진이 읽는 내부 표지).
    루프 회차가 아닌 답은 그대로 — 일반 대화에서 표지 형식을 설명한 답까지 지우지 않는다. 저장 기록은 바꾸지 않는다. */
export function crewReplyText(prev, m) {
  const text = String(m?.text ?? '');
  return inboundCard(prev)?.kind === 'loop' ? stripLoopVerdict(text) : text;
}
