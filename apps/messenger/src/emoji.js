// 반응 이모티콘 — 슬랙식(유건 지시 2026-09-09): hover에 자주 쓰는 2~3개, '반응'은 검색·분류 드롭다운.
// 항목 = [이모티콘, 검색어(한/영 공백 구분)]. 검색은 검색어 부분 일치. 자주 사용은 localStorage 빈도(기기별).
export const EMOJI_GROUPS = [
  { key: 'work', items: [['✅', '확인 완료 check done ok'], ['👀', '보는중 확인 eyes looking'], ['🙌', '만세 좋아 hands celebrate'], ['🙏', '감사 부탁 thanks please pray'], ['➕', '추가 plus one'], ['👏', '박수 clap'], ['💡', '아이디어 idea'], ['🎯', '목표 target'], ['👋', '인사 wave hi'], ['🎉', '축하 party'], ['1️⃣', '하나 one 1'], ['2️⃣', '둘 two 2'], ['3️⃣', '셋 three 3'], ['📣', '공지 announce'], ['⚪', '흰 원 white circle'], ['🔵', '파란 원 blue circle'], ['🔴', '빨간 원 red circle']] },
  { key: 'face', items: [['😀', '웃음 grin'], ['😃', '웃음 smile'], ['😄', '웃음 smile happy'], ['😁', '씨익 grin'], ['😆', '깔깔 laugh'], ['😅', '식은땀 sweat smile'], ['🤣', '데굴 rofl'], ['😂', '눈물 웃음 joy laugh'], ['🙂', '미소 slight smile'], ['🙃', '거꾸로 upside down'], ['😉', '윙크 wink'], ['😊', '수줍 blush'], ['😇', '천사 angel'], ['🥰', '사랑 love'], ['😍', '하트눈 heart eyes'], ['🤩', '별눈 star struck'], ['😘', '뽀뽀 kiss'], ['🤔', '생각 thinking hmm'], ['😮', '놀람 wow surprised'], ['😢', '슬픔 sad cry'], ['😎', '멋짐 cool sunglasses'], ['🥳', '파티 party'], ['😴', '졸림 sleep'], ['🤯', '충격 mind blown']] },
  { key: 'hand', items: [['👍', '좋아요 thumbs up like'], ['👎', '싫어요 thumbs down'], ['👌', '오케이 ok'], ['✌️', '브이 peace'], ['🤞', '행운 fingers crossed'], ['💪', '힘 muscle strong'], ['🤝', '악수 handshake deal'], ['✍️', '작성 writing'], ['🫡', '경례 salute yes sir'], ['🤙', '연락 call me']] },
  { key: 'thing', items: [['❤️', '하트 heart love'], ['🔥', '불 fire hot'], ['⭐', '별 star'], ['💯', '백점 100'], ['❌', '엑스 no cross'], ['⚠️', '주의 warning'], ['❓', '물음 question'], ['❗', '느낌 exclamation'], ['📌', '핀 pin'], ['📎', '클립 clip'], ['🔗', '링크 link'], ['📝', '메모 memo note'], ['📅', '달력 calendar'], ['⏰', '시계 alarm time'], ['🚀', '로켓 rocket launch'], ['🐛', '버그 bug'], ['🔒', '잠금 lock'], ['💬', '말풍선 comment']] },
];
export const ALL_EMOJI = EMOJI_GROUPS.flatMap((g) => g.items);
const KEY = 'argo-msgr-emoji-freq';
const readFreq = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
export function bumpEmoji(e) { try { const f = readFreq(); f[e] = (f[e] ?? 0) + 1; localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* 저장 못 해도 동작 */ } }
/** 자주 쓴 순 n개 — 부족하면 기본값으로 채운다. */
export function topEmoji(n, defaults = ['✅', '👀', '👍']) {
  const f = readFreq(); const used = Object.entries(f).sort((a, b) => b[1] - a[1]).map(([e]) => e);
  return [...new Set([...used, ...defaults])].slice(0, n);
}
export function searchEmoji(q) { const s = q.trim().toLowerCase(); if (!s) return null; return ALL_EMOJI.filter(([e, k]) => e === s || k.toLowerCase().includes(s)).map(([e]) => e); }
