// 알림함 v1 + 채널 상단 "크루" 버튼(유건 지적 2026-09-08 "알림창·메시지함이 없고 크루를 채널에 추가하는 UI가 없다"). JSX는 소스 구간 핀.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('apps/messenger/src/App.jsx'); const i18n = read('apps/messenger/src/i18n.js'); const css = read('apps/messenger/src/styles.css');

test('i18n: 알림함·크루 버튼·에이전트 참여 요청 키 ko/en', () => {
  for (const k of ['inbox.title', 'inbox.empty', 'inbox.kind.all', 'inbox.kind.mention', 'inbox.kind.reply', 'inbox.kind.approval', 'inbox.kind.dm', 'inbox.note', 'ch.crews.btn', 'ch.crews.btn.title', 'ch.add.crew.call', 'ch.crew.join.ask', 'ch.crew.join.requested', 'ch.crew.join.approve', 'ch.crew.join.reject', 'inbox.crewjoin.text'])
    assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});

test('알림함 v1: 레일 하단 종(안 읽은 수) · 페이지 분기 · 집계 4종(멘션·크루 답글·대기 결재·DM) · 읽음은 이 기기(localStorage)', () => {
  assert.match(app, /className=\{`btn ghost bell\$\{page === 'inbox' \? ' on' : ''\}`\}/, '종 버튼');
  assert.match(app, /\{inboxUnread > 0 && <span className="n">/, '안 읽은 수 배지');
  assert.match(app, /\) : page === 'inbox' && org \? \(\n\s*<Inbox items=\{inbox\}/, '페이지 분기');
  assert.match(app, /\.contains\('mentions', JSON\.stringify\(\[\{ kind: 'user', id: uid \}\]\)\)/, '나를 멘션한 글 — jsonb cs는 JSON 문자열로(배열이면 PG 배열 문법으로 직렬화돼 400, 실측)');
  assert.match(app, /\.eq\('author_kind', 'crew'\)\.eq\('kind', 'text'\)\.in\('reply_to', myIds\)/, '내 글의 크루 답글(시스템 안내 제외 — 2026-09-12 알림함 최종 답글만)');
  // payload 추가(분리 검수 M-3) — 알림함 미리보기도 plain 있으면 쉬운 문장 + 명령 한 줄로 카드와 모양을 맞춘다.
  assert.match(app, /from\('msgr_crew_approvals'\)\.select\('id, channel_id, crew_id, action, reason, payload, created_at'\)\.eq\('org_id', org\.id\)\.eq\('status', 'pending'\)/, '대기 결재');
  assert.match(app, /\.or\(`author_user_id\.neq\.\$\{uid\},author_user_id\.is\.null`\)/, 'DM 새 글 — 크루 글(author null)도 포함');
  assert.match(app, /const INBOX_SEEN_KEY = 'argo-msgr-inbox-seen';/, '읽음 키');
  assert.match(css, /\.msgr-foot \{ margin-top: auto; display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto auto auto;/, '하단 바 = 프로필(2열 span) + 종·기억·설정');
});

test('채널 상단 "크루" 버튼 → 시트를 크루 패널로 열고, 공개 채널도 초대할 에이전트를 고른다(2026-09-16 — 종전에는 파견 크루 전원을 "@로 부르기")', () => {
  assert.doesNotMatch(app, /className="btn sm crewbtn"/, '헤더 에이전트 버튼은 참여 패널로 통합(유건 2026-09-09)'); assert.match(app, /channel\.kind !== 'dm' && \{ icon: 'at', label: t\('ch\.add\.crew\.call'\), run: \(\) => onMention\?\.\(c\) \}/, '시트 행 메뉴에 @로 부르기(화면 기준 메뉴 — 시트 안에서 잘리던 것, 2026-09-16)'); assert.match(app, /className=\{`msgr-hchip\$\{muted \? ' off' : ''\}`\} onClick=\{onToggleMute\}/, '알림 표지가 토글'); assert.match(app, /onClick=\{onToggleMemory\}/, '기억 표지가 토글'); void ('상단 크루 버튼');
  assert.match(app, /onCrewAdd=\{\(\) => \{ setChSheetAdd\('crew'\); setChSheet\(true\); \}\}/, '버튼 → 시트 크루 패널');
  assert.match(app, /const \[add, setAdd\] = useState\(initialAdd\);/, '시트 초기 패널');
  assert.match(app, /const canAddCrew = \(\(isHost \|\| inRoom\) && addableCrews\.length > 0\) \|\| canDispatch;/, '공개·비공개 모두 방장·참여자에게 추가 메뉴');
  assert.doesNotMatch(app, /ch\.add\.crew\.public/, '공개 채널 "파견 전원 @로 부르기" 패널은 없어졌다');
  assert.match(app, /const mentionCrew = \(c\) => \{/, '작성창 멘션 삽입');
  assert.match(app, /const rows = \[\.\.\.addableCrews\.map\(\(c\) => \(\{ c \}\)\), \.\.\.\(canDispatch \? myAvailable\.map/, '모든 채널에서 초대 목록(유건 2026-09-17: 칩 대신 목록·여러 명 선택)'); assert.match(app, /r\.dispatch \? await onDispatch\(r\.c, channel\.id\) : await joinCrew\(r\.c\.id\)/, '초대는 서버 규칙(msgr_crew_join)으로 한 명씩');
  assert.match(app, /useEffect\(\(\) => \{ if \(!mentionReq\) return; mentionCrew\(mentionReq\); onMentionDone\?\.\(\); \}, \[mentionReq\]\);/, '멘션 요청 효과');
  assert.match(app, /useEffect\(\(\) => \{ setChSheet\(sheetAfterNav\.current\); sheetAfterNav\.current = false; \}, \[chId\]\);/, '시트 닫기 효과 불변(HIGH-1) — [chId] 단독, 알림함의 참여 요청만 이동 뒤 한 번 연다');
});
