// 알림 탭 → 그 채팅 열기(유건 요청 2026-10-01: "개인 메시지·조직 메시지 관계없이 배너를 누르면 해당 채팅으로 바로 이동").
//
// 1) 대기함(createNavInbox) — "이 채널 열기" 요청을 셸(Shell) 밖, 앱 수준에 둔다. 셸이 연결 대기 화면 등으로 내려갔다 다시
//    올라와도 요청이 남는다. 셸은 실제로 열었거나 일부러 버릴 때에만 비운다(가져가자마자 비우면 처리 도중 셸이 내려갈 때 또 사라진다).
// 2) 판단(decideNav) — 지금 상태로 다음 한 걸음만 정한다. 화면 상태를 바꾸고 조회하는 일은 부르는 쪽(App.jsx Shell)이 하고,
//    결과가 오면 다시 부른다. 목록에 없다고 바로 버리지 않는다: 참여 전 공개 채널(미리보기)은 열고, 같은 공간인데 목록에 없으면
//    목록을 한 번 다시 읽은 뒤에만 버린다. 조직이 0개인 개인 공간 사용자(orgId null)도 조회해서 개인 공간으로 옮긴다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NAV_MAX_FAILS = 3; // 조회·다시 읽기 실패 허용 횟수(요청 하나당) — 넘으면 버린다. 요청 하나가 DB를 부르는 상한이기도 하다

export function createNavInbox(now = () => Date.now()) {
  let current = null;
  let seq = 0;
  const subs = new Set();
  const emit = () => { for (const fn of [...subs]) { try { fn(current); } catch { /* 구독자 오류가 다른 구독자를 막지 않게 */ } } };
  return {
    get: () => current,
    /** 새 요청이 앞 요청을 대신한다(마지막으로 누른 배너가 이긴다). owner = 요청 시점의 계정(모르면 null). */
    offer({ channelId, source = 'app', owner = null } = {}) {
      if (typeof channelId !== 'string' || !channelId) return null;
      current = { seq: ++seq, channelId, source, owner: owner || null, at: now() };
      emit();
      return current;
    },
    /** 그 요청이 아직 대기 중일 때만 비운다 — 처리 중에 새 배너를 눌렀으면 새 요청은 남긴다. */
    done(req) {
      if (!req || current?.seq !== req.seq) return false;
      current = null;
      emit();
      return true;
    },
    clear() { if (!current) return; current = null; emit(); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

// tell = 사용자에게 알릴 문구 종류(i18n push.nav.<tell>). 잘못된 데이터·앞 계정 요청은 조용히 버린다
const drop = (reason) => ({ do: 'drop', reason, tell: reason === 'invalid' || reason === 'account' ? null : reason === 'offline' ? 'offline' : 'unavailable' });

/**
 * @param {object} s
 * @param {string} s.target       요청 채널 id 또는 'report'(신고 접수 알림)
 * @param {string|null} s.owner   요청 시점 계정, s.uid = 지금 셸의 계정
 * @param {Array|null} s.orgs     내 조직 목록(아직 안 읽었으면 null)
 * @param {string|null} s.orgId   지금 공간(조직 id · 개인 공간 표식 · 조직이 없으면 null), s.personalId = 개인 공간 표식
 * @param {boolean} s.loaded      지금 공간의 채널 목록이 실제로 도착했는가
 * @param {Array} s.channels      참여한 채널, s.previewChannels = 참여 전 공개 채널(조직 공간만)
 * @param {undefined|null|{org_id: string|null}} s.row  채널 조회 결과 — undefined 아직 안 물음, null 안 보임(권한 없음·없음)
 * @param {number} s.fails  실패 횟수, s.refreshed = 같은 공간 목록을 다시 읽었나, s.orgsRefreshed = 조직 목록을 다시 읽었나
 * @returns {{do: 'report'|'open'|'wait'|'lookup'|'switch'|'refresh'|'refresh-orgs'|'drop', orgId?: string, reason?: string, tell?: 'unavailable'|'offline'|null}}
 */
export function decideNav(s) {
  const { target } = s;
  if (target === 'report') return { do: 'report' };
  if (typeof target !== 'string' || !UUID.test(target)) return drop('invalid'); // 알림 데이터는 채널 uuid·'report'만 — Android는 다른 앱이 가짜 탭 인텐트를 넣을 수 있다
  if (s.owner && s.uid && s.owner !== s.uid) return drop('account'); // 앞 계정에서 누른 요청
  const isHere = (list) => (list ?? []).some((c) => c.id === target);
  if (s.loaded && (isHere(s.channels) || (s.orgId !== s.personalId && isHere(s.previewChannels)))) return { do: 'open' };
  if (!s.orgs) return { do: 'wait' }; // 조직 목록 전 — 셸이 아직 로딩 화면
  if ((s.fails ?? 0) >= NAV_MAX_FAILS) return drop('offline');
  if (s.row === undefined) return { do: 'lookup' };
  if (s.row === null) return drop('unreadable'); // RLS가 안 보여 준다(참여하지 않은 비공개·나간 방·게스트의 공개 채널) 또는 지워짐
  const space = s.row.org_id ?? s.personalId;
  if (space !== s.orgId) {
    if (space === s.personalId || s.orgs.some((o) => o.id === space)) return { do: 'switch', orgId: space };
    return s.orgsRefreshed ? drop('not-member') : { do: 'refresh-orgs' }; // 다른 기기에서 막 들어간 조직일 수 있다 — 조직 목록을 한 번 다시 읽는다
  }
  if (!s.loaded) return { do: 'wait' }; // 같은 공간 목록이 오는 중
  return s.refreshed ? drop('missing') : { do: 'refresh' }; // 목록을 받은 뒤 생긴 DM·비공개·개인 방 — 한 번 다시 읽은 뒤에만 버린다
}
