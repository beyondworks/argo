// 메신저가 일시 중단된 동안 설정 › 연결 화면(0.1.113, 유건 2026-10-16 "알림 받을 메신저에 아르고 메신저나 Argo 메신저 연결 이런 거 빼. 빼고 메신저 대기 알림 신청만 두면 되잖아")
// — 스위치 켬이면 메신저 항목을 화면에서 빼고 출시 알림 단추만, 꺼짐·모름이면 main과 똑같이.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { msgrPausedView, msgrGetLink } from '../app/c/[ws]/settings/msgr-card.mjs';

const MAIN = { showMsgrNotify: true, msgrCard: 'full', noticeSettingsLink: true };

test('스위치 켬 — 알림 칸의 아르고 메신저 줄을 빼고, 메신저 카드는 출시 알림 단추만, 회사 화면 안내의 설정 단추를 뺀다', () => {
  assert.deepEqual(msgrPausedView(true), { showMsgrNotify: false, msgrCard: 'waitlist', noticeSettingsLink: false });
  assert.deepEqual(msgrGetLink(true), { href: 'https://argo.ceo/messenger#waitlist', labelKey: 'settings.msgr.getWaitlist' });
});

test('스위치 꺼짐·모름(로드 전·옛 서버·오류) — main과 같다', () => {
  for (const v of [false, undefined, null, 'true', 1]) assert.deepEqual(msgrPausedView(v), MAIN, String(v));
});

test('판정 전(모름) — 메신저 카드 자리를 비운다(pending). 지금 카드가 먼저 그려졌다 바뀌며 GET을 한 번씩 더 보내는 깜빡임 방지', () => {
  assert.equal(msgrPausedView(null, { known: false }).msgrCard, 'pending');
  assert.equal(msgrPausedView(true, { known: false }).msgrCard, 'pending');
  assert.equal(msgrPausedView(false, { known: true }).msgrCard, 'full', '응답 받음·꺼짐(또는 조회 실패 = false) → main 카드');
  assert.equal(msgrPausedView(true, { known: true }).msgrCard, 'waitlist');
  assert.equal(msgrPausedView(false).msgrCard, 'full', 'known 기본값 true — 옛 호출은 종전과 같다');
});

test('사전 — 카드 제목 한 줄만 새로, #1059의 쉬는 중 문구 키 4개는 지운다', async () => {
  const dict = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  assert.match(dict, /'settings\.msgr\.titlePaused': \['Argo Messenger', 'Argo Messenger'\],/);
  for (const k of ['settings.msgr.pausedHelp', 'settings.msgr.runtime.paused', 'settings.msgr.connection.paused', 'settings.notify.msgrPaused']) {
    assert.ok(!dict.includes(`'${k}':`), `${k} 지움`);
  }
});

// 배선 확인(보조 — 행동은 위 판정 시험이 잠근다)
test('배선 — 부모가 연결 탭에서 스위치를 한 번 읽고, 알림 칸·메신저 카드·회사 화면 안내가 msgrPausedView 값으로 갈린다', async () => {
  const page = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /if \(tab !== 'connections' \|\| msgrPaused !== null\) return;[\s\S]{0,200}api\(`\/api\/companies\/\$\{ws\}\/msgr-archive`\)/, '연결 탭에서 모를 때만 한 번');
  assert.match(page, /<NotifyChannelsCard ws=\{ws\} showMsgr=\{pv\.showMsgrNotify\} \/>/);
  assert.match(page, /\{pv\.msgrCard === 'pending' \? null : pv\.msgrCard === 'waitlist' \? <MsgrWaitlistCard archive=\{msgrArchive\} \/> : <MsgrCard ws=\{ws\} agents=\{data\?\.agents \?\? \[\]\} \/>\}/);
  assert.match(page, /useState\(null\); \/\/ null = 아직 모름/, '처음은 모름(null)');
  assert.match(page, /msgrPausedView\(msgrPaused, \{ known: msgrPaused !== null \}\)/);
  assert.match(page, /\.catch\(\(\) => \{ if \(live\) setMsgrPaused\(false\); \}\)/, '조회 실패면 main 카드');
  assert.match(page, /\.\.\.\(showMsgr \? \[\{ kind: 'msgr'/);
  const card = page.slice(page.indexOf('function MsgrWaitlistCard('), page.indexOf('function MsgrCard('));
  assert.match(card, /msgrGetLink\(true\)/);
  assert.doesNotMatch(card, /MsgrArchiveSection|runtime|chip|downloadHelp/, '출시 알림 카드에는 설명·칩·응답 상태·이관 영역이 없다');
  const notice = await readFile(new URL('../app/c/[ws]/msgr-archive-notice.jsx', import.meta.url), 'utf8');
  assert.match(notice, /msgrPausedView\(st\.paused\)\.noticeSettingsLink && <Link/);
});

test('출시 알림 카드의 \'옮겨진 메신저 기록 · 폴더 열기\' 한 줄 — 받은 기록(done·partial)이 있을 때만, 진행률·옮기기·다시 받기 단추는 없다', async () => {
  const { waitlistArchiveLine } = await import('../app/c/[ws]/settings/msgr-archive-view.mjs');
  assert.deepEqual(waitlistArchiveLine({ signedIn: true, status: 'done', dir: '/x' }), { dir: '/x' });
  assert.deepEqual(waitlistArchiveLine({ signedIn: true, status: 'partial', dir: '/x' }), { dir: '/x' });
  for (const s of ['none', 'running', 'interrupted', 'failed']) assert.equal(waitlistArchiveLine({ signedIn: true, status: s, dir: '/x' }), null, s);
  assert.equal(waitlistArchiveLine({ signedIn: true, status: 'done', dir: null }), null);
  assert.equal(waitlistArchiveLine(null), null);
  const page = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  const card = page.slice(page.indexOf('function MsgrWaitlistCard('), page.indexOf('function MsgrCard('));
  assert.match(card, /waitlistArchiveLine\(archive\)/, '배선(보조)');
  assert.match(card, /settings\.msgrArchive\.open/);
  assert.doesNotMatch(card, /settings\.msgrArchive\.(retry|start|running)|MsgrArchiveSection/, '진행률·지금 옮기기·다시 받기 없음');
  const dict = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  assert.match(dict, /'settings\.msgr\.archiveLine': \['옮겨진 메신저 기록', 'Moved Messenger history'\],/);
});
