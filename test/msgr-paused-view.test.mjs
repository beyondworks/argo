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
  assert.match(page, /if \(tab !== 'connections'\) return;[\s\S]{0,200}api\(`\/api\/companies\/\$\{ws\}\/msgr-archive`\)/);
  assert.match(page, /<NotifyChannelsCard ws=\{ws\} showMsgr=\{pv\.showMsgrNotify\} \/>/);
  assert.match(page, /\{pv\.msgrCard === 'waitlist' \? <MsgrWaitlistCard \/> : <MsgrCard ws=\{ws\} agents=\{data\?\.agents \?\? \[\]\} \/>\}/);
  assert.match(page, /\.\.\.\(showMsgr \? \[\{ kind: 'msgr'/);
  const card = page.slice(page.indexOf('function MsgrWaitlistCard()'), page.indexOf('function MsgrCard('));
  assert.match(card, /msgrGetLink\(true\)/);
  assert.doesNotMatch(card, /MsgrArchiveSection|runtime|chip|downloadHelp/, '출시 알림 카드에는 설명·칩·응답 상태·이관 영역이 없다');
  const notice = await readFile(new URL('../app/c/[ws]/msgr-archive-notice.jsx', import.meta.url), 'utf8');
  assert.match(notice, /msgrPausedView\(st\.paused\)\.noticeSettingsLink && <Link/);
});
