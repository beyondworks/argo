// 알림함 v1 + 채널 상단 "크루" 버튼(유건 지적 2026-09-08 "알림창·메시지함이 없고 크루를 채널에 추가하는 UI가 없다"). JSX는 소스 구간 핀.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('apps/messenger/src/App.jsx'); const i18n = read('apps/messenger/src/i18n.js'); const css = read('apps/messenger/src/styles.css');

test('i18n: 알림함·크루 버튼·공개 채널 부르기 키 ko/en', () => {
  for (const k of ['inbox.title', 'inbox.empty', 'inbox.kind.all', 'inbox.kind.mention', 'inbox.kind.reply', 'inbox.kind.approval', 'inbox.kind.dm', 'inbox.note', 'ch.crews.btn', 'ch.crews.btn.title', 'ch.add.crew.public', 'ch.add.crew.public.note', 'ch.add.crew.call'])
    assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});

test('알림함 v1: 레일 하단 종(안 읽은 수) · 페이지 분기 · 집계 4종(멘션·크루 답글·대기 결재·DM) · 읽음은 이 기기(localStorage)', () => {
  assert.match(app, /className=\{`btn ghost bell\$\{page === 'inbox' \? ' on' : ''\}`\}/, '종 버튼');
  assert.match(app, /\{inboxUnread > 0 && <span className="n">/, '안 읽은 수 배지');
  assert.match(app, /\) : page === 'inbox' && org \? \(\n\s*<Inbox items=\{inbox\}/, '페이지 분기');
  assert.match(app, /\.contains\('mentions', JSON\.stringify\(\[\{ kind: 'user', id: uid \}\]\)\)/, '나를 멘션한 글 — jsonb cs는 JSON 문자열로(배열이면 PG 배열 문법으로 직렬화돼 400, 실측)');
  assert.match(app, /\.eq\('author_kind', 'crew'\)\.in\('reply_to', myIds\)/, '내 글의 크루 답글');
  assert.match(app, /from\('msgr_crew_approvals'\)\.select\('id, channel_id, crew_id, action, reason, created_at'\)\.eq\('org_id', org\.id\)\.eq\('status', 'pending'\)/, '대기 결재');
  assert.match(app, /\.or\(`author_user_id\.neq\.\$\{uid\},author_user_id\.is\.null`\)/, 'DM 새 글 — 크루 글(author null)도 포함');
  assert.match(app, /const INBOX_SEEN_KEY = 'argo-msgr-inbox-seen';/, '읽음 키');
  assert.match(css, /\.msgr-foot \{ margin-top: auto; display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto auto auto;/, '하단 바 = 프로필(2열 span) + 종·기억·설정');
});

test('채널 상단 "크루" 버튼 → 시트를 크루 패널로 열고, 공개 채널은 파견 크루 전원을 "@로 부르기"로 보인다', () => {
  assert.match(app, /\{channel\.kind !== 'dm' && <button type="button" className="btn sm crewbtn" onClick=\{onCrewAdd\}/, '상단 크루 버튼');
  assert.match(app, /onCrewAdd=\{\(\) => \{ setChSheetAdd\('crew'\); setChSheet\(true\); \}\}/, '버튼 → 시트 크루 패널');
  assert.match(app, /const \[add, setAdd\] = useState\(initialAdd\);/, '시트 초기 패널');
  assert.match(app, /\|\| \(channel\.kind === 'public' && chCrews\.length > 0\);/, '공개 채널에도 추가 메뉴');
  assert.match(app, /\{channel\.kind === 'public' && chCrews\.length > 0 && \(<>\n\s*<div className="msgr-klabel">\{t\('ch\.add\.crew\.public'\)\}<\/div>/, '공개 채널 부르기 패널');
  assert.match(app, /onClick=\{\(\) => onMention\?\.\(c\)\} title=\{t\('ch\.add\.crew\.call'\)\}/, '@로 부르기');
  assert.match(app, /const mentionCrew = \(c\) => \{/, '작성창 멘션 삽입');
  assert.match(app, /\{channel\.kind !== 'public' && addableCrews\.length > 0 && <>/, '공개 채널에는 멤버 추가 칩을 안 보인다(실측: 부르기와 중복)');
  assert.match(app, /useEffect\(\(\) => \{ if \(!mentionReq\) return; mentionCrew\(mentionReq\); onMentionDone\?\.\(\); \}, \[mentionReq\]\);/, '멘션 요청 효과');
  assert.match(app, /useEffect\(\(\) => \{ setChSheet\(false\); \}, \[chId\]\);/, '시트 닫기 효과 불변(HIGH-1)');
});
