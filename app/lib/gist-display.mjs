// 지시 요약(gist) 표시 — JSX 없는 순수 함수. 메신저 턴의 gist는 엔진(chat.mjs)이 userMsg 앞 60자로 만드는데, 메신저 턴의 userMsg는
// 크루에게만 보이는 머리말("[팀 메신저 #채널 — 주인 …의 메시지. 아래는 크루 주인의 지시다: …]")로 시작해 요약 줄이 통째로
// 내부 지시문이었다(UX-A08, 2026-10-05 — 아침 조회·활동·작업 독). 엔진 파일은 다른 담당이라 화면 쪽에서 머리말을 뗀다.
// 머리말 형식은 src/inbound-marks.mjs msgrHead 한 곳에서 만든다 — 같은 함수로 접두를 얻어 형식이 바뀌어도 어긋나지 않게.
import { msgrHead } from '../../src/inbound-marks.mjs';

const HOLE = '\u0000';
const PREFIXES = ['ko', 'en'].map((lang) => msgrHead(HOLE, lang).split(HOLE)[0]);

/** { channel: 채널 이름 | null, text: 머리말을 뗀 본문 } — 메신저 머리말이 아니면 channel null, text 원문. */
export function gistView(gist) {
  const s = String(gist ?? '');
  for (const pre of PREFIXES) {
    if (!s.startsWith(pre)) continue;
    const rest = s.slice(pre.length);
    const dash = rest.indexOf(' — ');
    const channel = (dash >= 0 ? rest.slice(0, dash) : rest).trim().slice(0, 40);
    const close = s.indexOf(']');
    return { channel, text: close >= 0 ? s.slice(close + 1).trim() : '' };
  }
  return { channel: null, text: s };
}

/** 화면에 쓸 한 줄 — 머리말만 있으면 "메신저 #채널에서 받은 지시", 본문이 남으면 "#채널 · 본문". t = i18n 함수. */
export function gistLabel(gist, t) {
  const v = gistView(gist);
  if (v.channel == null) return v.text;
  return v.text ? `#${v.channel} · ${v.text}` : t('activity.msgrGist', { channel: v.channel });
}
