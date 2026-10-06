// 메일 규칙(15차) — 목록 합치기·바뀐 것 반영·보기·검색·인용·전달 본문·HTML→글자·링크·큰 첨부 나누기·초안 이어 쓰기·알림 문구, 공유 링크 토큰.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inView, mergeList, applySync, newArrivals, replySubject, forwardSubject, replyTo, replyAll, parseAddrs, fmtExact, htmlToText, linkify,
  quoteBlock, forwardBlock, splitAttachments, linkNote, composeBody, isBlank, resumable, notifyText, avatarOf, ATTACH_CAP, RESUME_DAYS, attachSig, draftSavePlan,
} from '../src/pages/mail-model.js';
import { newLinkToken, linkTokenOk, sha256Hex, linkDaysLeft, linkPath, tokenFromHash } from '../src/files/link-model.js';

const at = (min) => new Date(Date.UTC(2026, 9, 4, 6, 0) - min * 60_000).toISOString();
const mail = (id, o = {}) => ({ id: `a.${id}`, gid: id, account: 'a', folder: 'inbox', unread: false, starred: false, at: at(0), from: 'Kim', addr: 'kim@x.com', subject: 's', ...o });

test('보기: 안 읽음은 받은편지함의 안 읽은 메일, 별표는 메일함과 상관없이(초안 제외), 휴지통은 어디에도 없다, 계정 고르기', () => {
  assert.equal(inView(mail(1, { unread: true }), 'unread'), true);
  assert.equal(inView(mail(1, { unread: true, folder: 'archive' }), 'unread'), false, '보관한 안 읽은 메일은 안 읽음 보기에 없다');
  assert.equal(inView(mail(1, { starred: true, folder: 'archive' }), 'starred'), true);
  assert.equal(inView(mail(1, { starred: true, folder: 'drafts' }), 'starred'), false);
  assert.equal(inView(mail(1, { folder: 'trash' }), 'inbox'), false);
  assert.equal(inView(mail(1), 'inbox', 'b'), false, '다른 계정');
  assert.equal(inView(mail(1), 'inbox', 'a'), true);
  // 나에게 보낸 메일(분리 검수 LOW-6): Gmail처럼 받은편지함과 보낸편지함 둘 다에 보인다 — 보낸편지함은 SENT 라벨로
  const self = mail(9, { folder: 'inbox', labels: ['INBOX', 'SENT'] });
  assert.equal(inView(self, 'sent'), true); assert.equal(inView(self, 'inbox'), true);
  assert.equal(inView(mail(9, { folder: 'inbox', labels: ['INBOX'] }), 'sent'), false);
  assert.equal(inView(mail(9, { folder: 'trash', labels: ['TRASH', 'SENT'] }), 'sent'), false, '지운 메일은 어디에도 없다');
  assert.equal(inView(mail(9, { folder: 'drafts', labels: ['DRAFT'] }), 'sent'), false);
  assert.equal(inView(mail(9, { folder: 'sent' }), 'sent'), true, '라벨을 모르는 예시 메일은 메일함으로');
});

test('목록 합치기: 다른 기기에서 보관한 메일은 빠지고, 보내는 중인 메일은 이 기기 값을 지키고, 다음 쪽이 있으면 오래된 캐시는 남긴다', () => {
  const cache = [mail(1, { at: at(1) }), mail(2, { at: at(0.5) }), mail(3, { at: at(300) }), mail(9, { folder: 'sent' }), { ...mail(5, { account: 'b' }), id: 'b.5' }];
  // 받은편지함 첫 쪽: 1(서버에서 읽음), 4(새 메일). 2는 받은 쪽 안의 시각인데 목록에 없다(다른 기기에서 보관), 3은 받은 쪽보다 오래됨
  const fresh = [mail(1, { at: at(1), unread: true }), mail(4, { at: at(0) })];
  const out = mergeList(cache, fresh, { view: 'inbox', done: new Set(['a']), hasMore: { a: 'next' } });
  const ids = out.map((m) => m.id).sort();
  assert.deepEqual(ids, ['a.1', 'a.3', 'a.4', 'a.9', 'b.5'], '2는 빠지고 3(아직 안 받은 쪽일 수 있다)·보낸편지함·다른 계정은 그대로');
  assert.equal(out.find((m) => m.id === 'a.1').unread, true);
  const noMore = mergeList(cache, fresh, { view: 'inbox', done: new Set(['a']), hasMore: {} });
  assert.ok(!noMore.some((m) => m.id === 'a.3'), '다음 쪽이 없으면 목록에 없는 받은편지함 메일은 모두 빠진다');
  const busy = mergeList([mail(1, { unread: false, starred: true })], [mail(1, { unread: true, starred: false })], { view: 'inbox', done: new Set(['a']), busy: (id) => id === 'a.1' });
  assert.deepEqual([busy[0].unread, busy[0].starred], [false, true], '보내는 중이면 이 기기 값');
  const failed = mergeList(cache, [], { view: 'inbox', done: new Set() });
  assert.equal(failed.length, cache.length, '받지 못한 계정은 캐시를 지우지 않는다');
  const more = mergeList(cache, [mail(7, { at: at(400) })], { view: 'inbox', done: new Set(['a']), append: true });
  assert.equal(more.length, cache.length + 1, '더 보기는 붙이기만 한다');
  assert.ok(!mergeList([], [mail(8, { folder: 'trash' })], { view: 'inbox' }).length, '휴지통 메일은 넣지 않는다');
});

test('바뀐 것 반영: 새 메일은 더하고, 라벨이 바뀐 메일은 새 값, 지워진 메일·휴지통으로 간 메일은 뺀다, 이 기기에만 있는 칸은 남긴다', () => {
  const cache = [mail(1, { note: { crew: 'c' } }), mail(2), mail(3)];
  const out = applySync(cache, [mail(1, { unread: true }), mail(4, { unread: true }), mail(3, { folder: 'trash' })], new Set(['a.2']));
  assert.deepEqual(out.map((m) => m.id).sort(), ['a.1', 'a.4']);
  assert.deepEqual(out.find((m) => m.id === 'a.1').note, { crew: 'c' });
  const kept = applySync([mail(1, { unread: false })], [mail(1, { unread: true })], new Set(), () => true);
  assert.equal(kept[0].unread, false, '보내는 중인 읽음 표시를 서버 값이 되돌리지 않는다');
});

test('알림 대상: 처음 보는, 30분 안에 온, 안 읽은 받은편지함 메일만', () => {
  const now = Date.parse(at(0));
  const cache = [mail(1)];
  const changed = [mail(1, { unread: true }), mail(2, { unread: true }), mail(3, { unread: false }), mail(4, { unread: true, folder: 'archive' }), mail(5, { unread: true, at: at(45) })];
  assert.deepEqual(newArrivals(cache, changed, now).map((m) => m.id), ['a.2']);
});

test('답장·전체 회신: 제목 접두, 받는 사람, 참조에서 보낸 사람과 나를 빼고 중복은 하나로 — 내가 보낸 메일이면 원래 받는 사람에게', () => {
  assert.equal(replySubject('견적'), 'Re: 견적'); assert.equal(replySubject('RE: 견적'), 'RE: 견적');
  assert.equal(forwardSubject('견적'), 'Fwd: 견적'); assert.equal(forwardSubject('Fw: 견적'), 'Fw: 견적');
  assert.deepEqual(parseAddrs('"박지현" <J@x.com>, b@y.com; c@z.co'), ['J@x.com', 'b@y.com', 'c@z.co']);
  const m = mail(1, { addr: 'boss@x.com', to: 'me@ours.com, Lee <lee@x.com>' });
  assert.deepEqual(replyAll(m, 'boss@x.com, Park <PARK@x.com>, park@x.com', 'ME@ours.com'), { to: 'boss@x.com', cc: 'lee@x.com, PARK@x.com' });
  assert.equal(replyTo(m, 'me@ours.com'), 'boss@x.com');
  const mine = mail(2, { addr: 'me@ours.com', to: 'a@x.com, b@x.com' });
  assert.equal(replyTo(mine, 'me@ours.com'), 'a@x.com, b@x.com');
  assert.deepEqual(replyAll(mine, 'c@x.com', 'me@ours.com'), { to: 'a@x.com, b@x.com', cc: 'c@x.com' });
});

test('정확한 날짜: 한국 시각, 요일', () => {
  assert.equal(fmtExact('2026-10-04T06:04:00Z', 'ko'), '2026년 10월 4일 (일) 오후 3:04');
  assert.equal(fmtExact('2026-10-04T06:04:00Z', 'en'), 'Sun, Oct 4, 2026, 3:04 PM');
  assert.equal(fmtExact('2026-10-03T15:30:00Z', 'ko'), '2026년 10월 4일 (일) 오전 12:30', '자정 넘은 한국 시각');
  assert.equal(fmtExact('nope'), '');
});

test('HTML → 글자: 문단·줄바꿈·목록·링크(글자 (주소))를 살리고 style·script는 버린다', () => {
  const html = '<style>p{color:red}</style><p>안녕하세요 <b>김</b>님</p><ul><li>하나</li><li>둘</li></ul><ol><li>첫째</li><li>둘째</li></ol><p><a href="https://x.com/a?b=1&amp;c=2">견적서</a> · <a href="https://y.com">https://y.com</a></p><script>alert(1)</script><p>a&nbsp;&lt;b&gt;</p>';
  assert.equal(htmlToText(html), '안녕하세요 김님\n\n- 하나\n- 둘\n\n1. 첫째\n2. 둘째\n\n견적서 (https://x.com/a?b=1&c=2) · https://y.com\n\na <b>');
  assert.equal(htmlToText(''), '');
});

test('글자 본문 링크: http(s)만, 끝의 문장부호·짝 없는 괄호는 주소에서 뺀다, javascript:는 글자로', () => {
  const parts = linkify('자료: https://x.com/a.pdf. 그리고 (https://w.org/wiki/A_(b)) javascript:alert(1)');
  assert.deepEqual(parts.filter((p) => p.t === 'url').map((p) => p.v), ['https://x.com/a.pdf', 'https://w.org/wiki/A_(b)']);
  assert.equal(parts.map((p) => p.v).join(''), '자료: https://x.com/a.pdf. 그리고 (https://w.org/wiki/A_(b)) javascript:alert(1)', '글자는 하나도 잃지 않는다');
});

test('인용·전달: 날짜와 보낸 사람 머리, 글자 갈래는 "> ", HTML 갈래는 원문을 이스케이프, 전달은 원래 머리·참조까지', () => {
  const m = mail(1, { from: '박지현', addr: 'j@x.com', at: '2026-10-04T06:04:00Z', subject: '견적', to: 'me@ours.com' });
  const q = quoteBlock(m, { text: '줄1\n<줄2>' }, 'ko');
  assert.equal(q.text, '2026년 10월 4일 (일) 오후 3:04 박지현 <j@x.com> 님이 작성:\n> 줄1\n> <줄2>');
  assert.match(q.html, /&lt;줄2&gt;/); assert.doesNotMatch(q.html, /<줄2>/);
  const html = quoteBlock(m, { text: null, html: '<p>본문</p>' }, 'ko');
  assert.match(html.text, /> 본문/, '글자 갈래가 없으면 HTML을 글자로');
  const f = forwardBlock(m, { text: '원문', cc: 'c@x.com' }, 'ko');
  assert.equal(f.text, '---------- 전달된 메일 ----------\n보낸 사람: 박지현 <j@x.com>\n날짜: 2026년 10월 4일 (일) 오후 3:04\n제목: 견적\n받는 사람: me@ours.com\n참조: c@x.com\n\n원문');
  assert.match(forwardBlock(m, { text: 'x' }, 'en').text, /^---------- Forwarded message ----------\nFrom: 박지현 <j@x.com>/);
});

test('큰 첨부 나누기(결정 5): 합계 3MB 안에 작은 파일부터 싣고 나머지는 링크로 — 각 묶음은 원래 순서', () => {
  const MB = 1024 * 1024;
  const files = [{ name: 'a', size: 2.5 * MB }, { name: 'b', size: 1 * MB }, { name: 'c', size: 0.4 * MB }, { name: 'd', size: 5 * MB }];
  const s = splitAttachments(files, ATTACH_CAP);
  assert.deepEqual(s.attach.map((f) => f.name), ['b', 'c']);
  assert.deepEqual(s.link.map((f) => f.name), ['a', 'd']);
  assert.deepEqual(splitAttachments([{ name: 'x', size: 3 * MB }]).attach.map((f) => f.name), ['x'], '딱 3MB는 싣는다');
  assert.deepEqual(splitAttachments([]), { attach: [], link: [] });
});

test('링크 안내와 보낼 본문: 쓴 글 + 링크 안내 + 인용, 글자·HTML 두 갈래, 주소·이름은 이스케이프', () => {
  const links = [{ name: '도면 <최종>.pdf', size: 12.3 * 1024 * 1024, url: 'https://o.example/f/tok"en' }];
  const n = linkNote(links, 'ko', 30);
  assert.equal(n.text, '큰 파일은 링크로 보냅니다(30일 동안 받을 수 있습니다):\n- 도면 <최종>.pdf (12.3 MB): https://o.example/f/tok"en');
  assert.match(n.html, /<a href="https:\/\/o\.example\/f\/tok&quot;en">도면 &lt;최종&gt;\.pdf<\/a> \(12\.3 MB\)/);
  const b = composeBody({ html: '<p>안녕하세요</p>', quote: { text: '> 원문', html: '<blockquote>원문</blockquote>' }, links }, 'ko');
  assert.equal(b.text, '안녕하세요\n\n' + n.text + '\n\n> 원문');
  assert.equal(b.html, '<p>안녕하세요</p>' + n.html + '<blockquote>원문</blockquote>');
  assert.deepEqual(composeBody({ html: '' }), { text: '', html: '' });
});

test('초안 이어 쓰기: 빈 메일은 저장·복원하지 않고, 7일 지난 것·모양이 다른 것도 열지 않는다', () => {
  assert.equal(isBlank({ to: '', subject: ' ', html: '<p></p>' }), true);
  assert.equal(isBlank({ html: '<p>a</p>' }), false);
  assert.equal(isBlank({ carry: [{ name: 'a' }] }), false, '원문 첨부만 있어도 빈 메일이 아니다');
  assert.equal(isBlank({ files: 1 }), false);
  const now = Date.parse(at(0));
  const snap = { v: 1, at: now - 1000, to: 'a@x.com', html: '' };
  assert.equal(resumable(snap, now), true);
  assert.equal(resumable({ ...snap, at: now - (RESUME_DAYS * 864e5 + 1) }, now), false);
  assert.equal(resumable({ ...snap, v: 2 }, now), false);
  assert.equal(resumable({ v: 1, at: now, to: '', html: '<p></p>' }, now), false);
  assert.equal(resumable(null, now), false);
});

// 이유(분리 검수 MEDIUM-2): Gmail은 초안 일부만 고칠 수 없다 — 첨부가 있는 초안을 글만 바꿔 저장해도 첨부를 매번 다시 올렸다(원문 첨부는 서버가 Gmail에서 다시 받았다).
// 첨부가 지난번 저장 그대로면 자동 저장은 이 기기에만, 첨부가 바뀌었거나 닫을 때만 첨부까지 임시 보관함에 저장한다
test('초안 저장 방식: 첨부 없으면 글만, 첨부가 바뀌면·닫을 때 첨부까지, 첨부 그대로면 이 기기에만', () => {
  const f1 = { name: 'a.pdf', size: 1000, lastModified: 1 }, f2 = { name: 'b.png', size: 2000, lastModified: 2 }, c1 = { name: '원문.xlsx', size: 3000, id: 'att-1' };
  assert.equal(draftSavePlan({}).kind, 'text');
  const first = draftSavePlan({ files: [f1], carry: [c1], savedSig: null });
  assert.equal(first.kind, 'full', '처음 저장은 첨부까지');
  assert.equal(draftSavePlan({ files: [f1], carry: [c1], savedSig: first.sig }).kind, 'local', '글만 바뀌면 첨부를 다시 보내지 않는다');
  assert.equal(draftSavePlan({ files: [f1], carry: [c1], savedSig: first.sig, final: true }).kind, 'full', '닫을 때는 첨부까지');
  assert.equal(draftSavePlan({ files: [f1, f2], carry: [c1], savedSig: first.sig }).kind, 'full', '파일을 더하면');
  assert.equal(draftSavePlan({ files: [f1], carry: [], savedSig: first.sig }).kind, 'full', '원문 첨부를 빼면');
  assert.equal(draftSavePlan({ files: [{ ...f1, lastModified: 9 }], carry: [c1], savedSig: first.sig }).kind, 'full', '같은 이름의 다른 파일');
  assert.equal(draftSavePlan({ files: [], carry: [c1], savedSig: attachSig([], [c1]) }).kind, 'local', '고칠 초안에 이미 있는 원문 첨부는 다시 받지 않는다');
  const none = draftSavePlan({ files: [], carry: [], savedSig: first.sig });
  assert.deepEqual(none, { kind: 'text', sig: attachSig([], []) }, '첨부를 모두 빼면 글만 — 다음에 첨부를 더하면 다시 첨부까지');
  assert.equal(draftSavePlan({ files: [f1], carry: [], savedSig: none.sig }).kind, 'full');
});

test('알림 문구: 1통이면 보낸 사람/제목, 여러 통이면 새 메일 N통/이름 세 개(같은 사람은 한 번)', () => {
  assert.deepEqual(notifyText([mail(1, { from: '박지현', subject: '견적' })], 'ko'), { title: '박지현', body: '견적', id: 'a.1' });
  assert.equal(notifyText([mail(1, { subject: ' ' })], 'ko').body, '(제목 없음)');
  const many = notifyText([mail(1, { from: 'A' }), mail(2, { from: 'B' }), mail(3, { from: 'A' }), mail(4, { from: 'C' }), mail(5, { from: 'D' })], 'ko');
  assert.deepEqual(many, { title: '새 메일 5통', body: 'A, B, C', id: null });
  assert.equal(notifyText([], 'ko'), null);
});

test('아바타: 이름 첫 글자(없으면 주소), 같은 주소는 같은 색 번호(0~5)', () => {
  assert.equal(avatarOf('박지현', 'j@x.com').letter, '박');
  assert.equal(avatarOf('', 'kim@x.com').letter, 'K');
  assert.equal(avatarOf('"Lee"', 'l@x.com').letter, 'L');
  assert.equal(avatarOf('A', 'same@x.com').tone, avatarOf('B', 'SAME@x.com').tone);
  assert.ok(avatarOf('A', 'z@x.com').tone >= 0 && avatarOf('A', 'z@x.com').tone < 6);
});

test('공유 링크 토큰: 32바이트 base64url 43자, 형식 검사, SHA-256 hex, 남은 날', async () => {
  const tok = newLinkToken();
  assert.match(tok, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(linkTokenOk(tok), true);
  assert.notEqual(newLinkToken(), tok, '매번 다르다');
  assert.equal(newLinkToken(() => new Uint8Array(32).fill(255)), '_'.repeat(42) + '8');
  for (const bad of ['short', 'a'.repeat(65), 'has space'.padEnd(43, 'x'), '../'.padEnd(43, 'x'), null, 1]) assert.equal(linkTokenOk(bad), false, String(bad));
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(linkDaysLeft(new Date(Date.now() + 29.2 * 864e5).toISOString()), 30);
  assert.equal(linkDaysLeft(new Date(Date.now() - 1000).toISOString()), 0);
});

// 이유(분리 검수 LOW-11): 토큰은 주소 조각(#)에 — 조각은 브라우저가 서버로 보내지 않아 접근 기록·Referer에 남지 않는다
test('공유 링크 주소: 토큰은 경로가 아니라 조각에, 공개 화면은 조각에서 그대로 꺼낸다', () => {
  const token = newLinkToken();
  const u = new URL(linkPath(token), 'https://office.example');
  assert.equal(u.pathname, '/f'); assert.equal(u.search, '');
  assert.equal(u.hash, `#${token}`);
  assert.ok(!u.pathname.includes(token) && !`${u.origin}${u.pathname}${u.search}`.includes(token), '서버로 가는 부분에 토큰이 없다');
  assert.equal(tokenFromHash(u.hash), token); assert.equal(tokenFromHash(''), ''); assert.equal(tokenFromHash(undefined), '');
  assert.equal(linkTokenOk(tokenFromHash(u.hash)), true);
});
