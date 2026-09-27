// 메일 서버 순수 함수 — 봉인·state, Gmail 메시지 해석, 보낼 메시지 만들기, 권한 확인.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, unseal, sealState, openState, mailKey } from '../server/seal.js';
import { decodeWords, parseAddress, envelope, content, buildRaw, missingScopes, SCOPES } from '../server/gmail.js';

const key = randomBytes(32);

test('봉인: 같은 주인(aad)만 풀린다 — 남의 계정 봉인 문자열을 제 계정에 넣어도 못 푼다', () => {
  const s = seal(key, 'refresh-1', 'u1:google:a@x.com');
  assert.equal(unseal(key, s, 'u1:google:a@x.com'), 'refresh-1');
  assert.equal(unseal(key, s, 'u2:google:a@x.com'), null);
  assert.equal(unseal(randomBytes(32), s, 'u1:google:a@x.com'), null, '다른 키');
  assert.equal(unseal(key, s.slice(0, -2) + 'AA', 'u1:google:a@x.com'), null, '변조');
  assert.equal(unseal(key, 'garbage', 'x'), null);
});

test('state: 10분 안에만, 봉인이라 사용자 id가 주소에 드러나지 않는다', () => {
  const s = sealState(key, { uid: 'user-123', v: 'ver' }, 0);
  assert.ok(!s.includes('user-123'));
  assert.equal(openState(key, s, 60_000).uid, 'user-123');
  assert.equal(openState(key, s, 11 * 60_000), null);
});

test('서버 키가 32바이트가 아니면 설정 안 됨으로 거절', () => {
  assert.throws(() => mailKey({ OFFICE_MAIL_KEY: 'short' }), (e) => e.code === 'not_configured');
  assert.equal(mailKey({ OFFICE_MAIL_KEY: key.toString('base64') }).length, 32);
});

test('헤더: 인코딩된 한글 제목·보낸 사람 이름을 푼다', () => {
  assert.equal(decodeWords('=?UTF-8?B?7ZWc67mb?= =?UTF-8?Q?_=EA=B2=AC=EC=A0=81?='), '한빛 견적');
  assert.deepEqual(parseAddress('"박지현" <jihyun@hanbit.example>'), { name: '박지현', addr: 'jihyun@hanbit.example' });
  assert.deepEqual(parseAddress('solo@x.com'), { name: 'solo@x.com', addr: 'solo@x.com' });
});

test('목록 한 줄: 안 읽음·시각·요약 문자 엔터티', () => {
  const m = envelope({ id: 'g1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], internalDate: '1790000000000', snippet: 'Tom&#39;s &amp; co',
    payload: { headers: [{ name: 'From', value: 'Tom <t@x.com>' }, { name: 'Subject', value: 'Hi' }] } }, 'acc');
  assert.equal(m.id, 'acc.g1'); assert.equal(m.unread, true); assert.equal(m.snippet, "Tom's & co");
  assert.equal(m.at, new Date(1790000000000).toISOString());
});

test('본문: 중첩 multipart에서 html·text·첨부를 가른다', () => {
  const b = (s) => Buffer.from(s).toString('base64url');
  const c = content({ payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Message-ID', value: '<m1@x>' }], parts: [
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b('안녕') } }, { mimeType: 'text/html', body: { data: b('<p>안녕</p>') } }] },
    { mimeType: 'application/pdf', filename: '견적.pdf', body: { attachmentId: 'A1', size: 1200 } },
  ] } });
  assert.equal(c.text, '안녕'); assert.equal(c.html, '<p>안녕</p>'); assert.equal(c.messageId, '<m1@x>');
  assert.deepEqual(c.attachments, [{ id: 'A1', name: '견적.pdf', type: 'application/pdf', size: 1200 }]);
});

const decodeRaw = (raw) => Buffer.from(raw, 'base64url').toString();
test('보낼 메시지: 한글 제목 인코딩, 답장 헤더, 헤더 주입 차단', () => {
  const raw = decodeRaw(buildRaw({ to: 'a@x.com\r\nBcc: evil@x.com', subject: 'Re: 견적', text: '확인했습니다', inReplyTo: '<m1@x>' }));
  assert.match(raw, /^To: a@x.com Bcc: evil@x.com\r\n/m, '줄바꿈이 헤더를 새로 만들지 못한다');
  assert.doesNotMatch(raw, /^Bcc:/m);
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(raw, /^In-Reply-To: <m1@x>\r\nReferences: <m1@x>/m);
  const body = raw.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), '확인했습니다');
});

test('보낼 메시지: 첨부는 multipart/mixed, 한글 파일명', () => {
  const raw = decodeRaw(buildRaw({ to: 'a@x.com', subject: 's', text: 't', attachments: [{ name: '견적서.pdf', type: 'application/pdf', data: Buffer.from('PDF').toString('base64') }] }, 'B'));
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="B"/);
  assert.match(raw, /filename\*=UTF-8''%EA%B2%AC%EC%A0%81%EC%84%9C\.pdf/);
  assert.match(raw, /--B--$/);
});

test('권한: 동의 화면에서 하나라도 끄면 빠진 권한을 알려 준다', () => {
  assert.deepEqual(missingScopes(`openid ${SCOPES.join(' ')}`), []);
  assert.deepEqual(missingScopes(`openid ${SCOPES[0]}`), [SCOPES[1]]);
});
