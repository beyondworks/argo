// 다른 사람의 요청에 내 에이전트가 답하지 못했을 때 에이전트 주인에게 알린다(유건 지시 2026-10-15 "알려 주기만 하던 것을 해결까지").
// #980은 방(요청한 사람들)에 원인을 알렸지만, 고칠 수 있는 사람(실행기 주인)이 그 방에 없으면 몰랐다. 이 턴은 주인의 실행기에서 돌므로
// 실패한 바로 그 자리(gateway/msgr.mjs 답 실패 처리)에서 주인의 개인 공간 1:1 방에 안내 한 번을 올린다(personal-notice.mjs — 목표 하트비트와 같은 길).
// 대상 원인은 실행기가 켜져 있고 주인이 고칠 수 있는 것만(총괄 확정 2026-10-15): AI 로그인 만료 · 연결된 AI 없음 · AI 프로그램이 멈춤(crash).
// 시간 초과는 작업 크기의 문제라 빼고, 실행기가 꺼진 경우는 이 코드가 돌지 않으므로 다루지 않는다(메신저 화면·서버 쪽 별도 과제).
// 같은 원인은 6시간에 한 번 — 기준(basis)에 6시간 구간을 넣어 서버 유니크(client_msg_id)가 묶는다. 로컬 상태·주기 호출 없음(쓰기 = 안내 글 1건).
// 방 이름·요청자·원문·계정·토큰은 싣지 않는다 — 러너 이름과 고칠 곳만.
import { pick } from './protocol.mjs';
import { RUNNERS } from '../runners/catalog.mjs';
import { roomAuthRunner } from './msgr-room-errors.mjs';

export const OWNER_NOTICE_WINDOW_MS = 6 * 3600_000;
export const OWNER_NOTICE_KIND = 'runner'; // meta.notification — 끌 수 없는 장애 안내(총괄 확정 2026-10-15). 하트비트('assistant')와 다른 종류

/** 실패 → 주인에게 알릴 원인 { kind: 'auth'|'no_runner'|'crash', runner } | null(알리지 않음). chat.mjs가 붙인 필드만 본다(원문을 다시 판정하지 않는다). */
export function ownerNoticeCause(e) {
  if (!e || typeof e !== 'object' || e.aborted || e.subscriptionBlocked) return null;
  const auth = roomAuthRunner(e);
  if (auth) return { kind: 'auth', runner: auth };
  if (e.failCode === 'no_runner' || e.noRunner === true) return { kind: 'no_runner', runner: null }; // noRunner = chat.mjs 러너 확인 갈래의 표지(실패 코드 없이 던진다 — D6)
  if (e.failCode === 'crash') return { kind: 'crash', runner: typeof e.failRunner === 'string' ? e.failRunner : null };
  return null;
}

/** 주인에게 보낼 글(에이전트가 주인 1:1에 쓰는 말) — 원인과 고칠 곳만. */
export function ownerNoticeText(cause, lang = 'ko') {
  const name = RUNNERS[cause?.runner]?.name;
  if (cause?.kind === 'auth') return name
    ? pick(`다른 분의 요청에 답하지 못했습니다. 이 실행기의 ${name} 로그인이 만료됐습니다. Argo 데스크톱 설정 → AI 연결에서 ${name}에 다시 로그인하면 다시 답할 수 있습니다.`,
      `I couldn't answer someone's request because the ${name} login on this runner has expired. Sign in to ${name} again in Argo desktop Settings → AI connection and I can answer again.`, lang)
    : pick('다른 분의 요청에 답하지 못했습니다. 이 실행기의 AI 로그인이 만료됐습니다. Argo 데스크톱 설정 → AI 연결에서 다시 로그인하면 다시 답할 수 있습니다.',
      "I couldn't answer someone's request because the AI login on this runner has expired. Sign in again in Argo desktop Settings → AI connection and I can answer again.", lang);
  if (cause?.kind === 'no_runner') return pick('다른 분의 요청에 답하지 못했습니다. 이 실행기에 연결된 AI가 없습니다. Argo 데스크톱 설정 → AI 연결에서 AI를 연결하면 다시 답할 수 있습니다.',
    "I couldn't answer someone's request because no AI is connected on this runner. Connect one in Argo desktop Settings → AI connection and I can answer again.", lang);
  return pick(`다른 분의 요청에 답하지 못했습니다. 이 실행기의 ${name ?? 'AI'} 프로그램이 응답하지 않고 멈췄습니다. Argo를 다시 시작한 뒤에도 같으면 설정 → AI 연결에서 상태를 확인해 주세요.`,
    `I couldn't answer someone's request because the ${name ?? 'AI'} program on this runner stopped responding. Restart Argo; if it keeps happening, check Settings → AI connection.`, lang);
}

/** 보낼까 — 요청자가 주인 자신이거나 주인 혼자 1:1 방이면 방 글로 이미 안다(중복 안 함). */
export const ownerNoticeWanted = ({ cause, authorId, ownerId, ownerSolo }) => !!cause && !ownerSolo && !!ownerId && authorId !== ownerId;

/** 주인 1:1에 안내 한 번 — 'sent' | 'dup'(6시간 안 같은 원인) | 'skip'(대상 아님). 방이 없으면(개인 행 없는 주인) personal_room_unavailable을 던진다. */
export async function sendOwnerNotice({ c, wsId, slug, cause, lang = 'ko', now = Date.now() }, deps = {}) {
  if (!cause) return 'skip';
  const { personalRoom, insertNotice } = deps.personalRoom ? deps : await import('../personal-notice.mjs');
  const room = await personalRoom(c, wsId, slug);
  const bucket = Math.floor(now / OWNER_NOTICE_WINDOW_MS);
  return insertNotice(c, { ...room, ws: wsId, slug, lang }, {
    basis: `runner-fail:${cause.kind}:${cause.runner ?? '-'}:${bucket}`,
    body: ownerNoticeText(cause, lang),
    notification: OWNER_NOTICE_KIND,
    meta: { kind: cause.kind, runner: cause.runner ?? null },
  });
}
