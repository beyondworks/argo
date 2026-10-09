// 메일 글을 다루는 파서가 공격 입력에서 선형 시간인가 — 10/9 보안 검토 ReDoS(정규식 서비스 거부).
// 메일 제목·보낸 사람·본문·HTML은 바깥 사람이 마음대로 만든다. 오피스 서버 함수(apps/office/server/gmail.js — Vercel)와 본체 비서(src/assistant/mail-*.mjs)가
// 같은 입력을 받는다. 고치기 전 코드는 아래 입력 몇 개에서 몇 초~몇 분이 걸렸다(닫히지 않은 <script 2만 개 → 14초, 주소 패턴은 세제곱 — 스크래치 redos-before-mail.txt).
// 기준 300ms는 선형 코드가 이 맥에서 40ms 안쪽인 크기의 입력에 둔 여유(CI 윈도우 몇 배 느림 포함)이고, 제곱 시간이면 이 크기에서 초 단위가 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = await import(new URL('../apps/office/server/gmail.js', import.meta.url).href);
const C = await import('../src/assistant/mail-classify.mjs');
const P = await import('../src/assistant/mail-prep.mjs');
const X = await import('../src/assistant/mail-text.mjs');
const { htmlText } = await import('../src/gateway/office-mail.mjs'); // 에이전트 메일 도구(mail_read)의 같은 변환 — 기기에서 돈다

const N = 50_000;
const ATTACKS = {
  unclosedScript: '<script'.repeat(N), spaces: `${' '.repeat(N * 4)}x`, lt: '<'.repeat(N * 2), imgOpen: '<img'.repeat(N), gt: '>'.repeat(N * 2),
  quoteLines: `On ${'a'.repeat(300)}\n`.repeat(N / 50), longLine: `On ${'a '.repeat(N * 2)}`, digits: '1 '.repeat(N * 2), dash: '1-'.repeat(N * 2),
  urls: `http://${'a'.repeat(N * 4)}`, at: 'a@'.repeat(N * 2), dot: `${'a.'.repeat(N * 2)}@`, ent: '&#'.repeat(N * 2), lbr: '['.repeat(N * 2),
  eyj: 'eyJ'.repeat(N), korean: `${'년'.repeat(N * 2)}작성`, months: 'oct '.repeat(N), subj: 're: '.repeat(N),
};
const LIMIT_MS = 300;
function within(name, fn) {
  for (const [atk, s] of Object.entries(ATTACKS)) {
    const t = performance.now();
    fn(s);
    const ms = performance.now() - t;
    assert.ok(ms < LIMIT_MS, `${name} ${atk}: ${ms.toFixed(0)}ms (입력 ${s.length}자)`);
  }
}

test('ReDoS — 오피스 서버: htmlToText·stripQuoted·parseAddress·authOf·threadView가 공격 입력에서 300ms 안', () => {
  within('htmlToText', (s) => g.htmlToText(s));
  within('office-mail htmlText(기기)', (s) => htmlText(s));
  within('stripQuoted', (s) => g.stripQuoted(s));
  within('parseAddress', (s) => g.parseAddress(s));
  within('authOf', (s) => g.authOf({ payload: { headers: [{ name: 'Authentication-Results', value: `mx.google.com; dmarc=${s}` }] } }));
  within('threadView', (s) => g.threadView({ messages: [{ id: 'a', threadId: 't', labelIds: ['INBOX'], payload: { mimeType: 'text/html', headers: [{ name: 'From', value: s }, { name: 'Subject', value: s }], body: { data: Buffer.from(s).toString('base64url') } } }] }, 'acc'));
});

test('ReDoS — 본체 비서: 분류·주소·날짜·보안 줄·주제·표시·준비 출력 검증이 공격 입력에서 300ms 안', () => {
  within('classifyMail', (s) => C.classifyMail({ subject: s, snippet: s, addr: s, labels: ['INBOX'], at: '2026-10-08T00:00:00Z', auth: { dmarc: 'pass', from: s } }, { now: Date.parse('2026-10-08T01:00:00Z'), thread: [{ addr: s, at: '2026-10-07T00:00:00Z' }] }));
  within('needsThread', (s) => C.needsThread({ subject: s, snippet: s, addr: s, labels: [] }));
  within('findDates', (s) => C.findDates(s, '2026-10-08'));
  within('scrubLine', (s) => C.scrubLine(s));
  within('addrOf', (s) => C.addrOf(s));
  within('topicOf', (s) => X.topicOf(s));
  within('display', (s) => X.display(s, 200));
  within('composeBatch', (s) => X.composeBatch([{ m: { subject: s, from: s, addr: s, at: '2026-10-08T00:00:00Z' }, cls: { cat: 'security' } }], { now: Date.parse('2026-10-08T01:00:00Z') }));
  const outs = Object.fromEntries(Object.entries(ATTACKS).map(([k, s]) => [k, JSON.stringify({ situation: [s], ask: s, draft: s, brief: s, question: { q: s, answers: [s, s] }, deadline: { quote: s } })]));
  for (const [atk, s] of Object.entries(ATTACKS)) {
    const t = performance.now();
    P.parsePrep(outs[atk], { source: s, today: '2026-10-08', wantBrief: true });
    P.parsePrep(s, { source: s, today: '2026-10-08', wantBrief: true });
    const ms = performance.now() - t;
    assert.ok(ms < LIMIT_MS, `parsePrep ${atk}: ${ms.toFixed(0)}ms`);
  }
});

test('선형으로 바꾼 뒤에도 정상 메일 변환은 그대로 — 블록 줄바꿈·<br>·스크립트·스타일·head 제거·엔터티·줄 끝 공백·인용 자르기', () => {
  const html = '<html><head><title>t</title><style>p{x:1}</style></head><body><p>안녕하세요&nbsp;Vickie님,</p><div>일정 확인 부탁드립니다.&amp; 감사</div>  \n<br/>둘째 줄<script>alert(1)</script><img src="x.png">끝 <b>굵게</b></body></html>';
  assert.equal(g.htmlToText(html), '안녕하세요 Vickie님,\n일정 확인 부탁드립니다.& 감사\n\n둘째 줄끝 굵게');
  assert.equal(g.htmlToText('a < b 그리고 c'), 'a < b 그리고 c', '닫는 > 없는 <는 글자 그대로');
  assert.equal(g.htmlToText('앞<script>bad()'), '앞', '닫히지 않은 script는 끝까지 버린다');
  assert.equal(g.htmlToText('<P>대문자</P><BR>다음'), '대문자\n\n다음');
  assert.equal(g.stripQuoted('네 확인했습니다.\n\nOn Wed, Oct 1, 2026 at 9:00 AM Kim <k@x.com> wrote:\n> 이전 글'), '네 확인했습니다.');
  assert.deepEqual(g.parseAddress('"박지현" <jihyun@hanbit.example>'), { name: '박지현', addr: 'jihyun@hanbit.example' });
  assert.deepEqual(g.parseAddress('solo@x.com'), { name: 'solo@x.com', addr: 'solo@x.com' });
  assert.deepEqual(g.parseAddress('"security@google.com" <attacker@evil.example>'), { name: 'security@google.com', addr: 'attacker@evil.example' }, '표시 이름이 주소처럼 보여도 주소는 꺾쇠 안');
  assert.equal(C.scrubLine('코드 4829 13 · https://evil.example/x · a@b.co 새 로그인'), '코드 … · · 새 로그인');
  assert.equal(X.topicOf('Re: Fwd: Kimi K3 script timeline https://x.y/z (Ref 12345678) me@x.com'), 'Kimi K3 script timeline (Ref )');
});

test('범위 밖 숫자 엔터티(&#99999999999;)가 변환을 깨지 않는다 — 예전에는 String.fromCodePoint가 던져 그 메일의 스레드 읽기·메일 읽기가 통째로 실패했다', () => {
  assert.equal(g.htmlToText('<p>a &#99999999999; b &#x110000; c &#65;</p>'), 'a &#99999999999; b &#x110000; c A');
  assert.equal(htmlText('<p>a &#99999999999; b &#65;</p>'), 'a &#99999999999; b A');
  assert.equal(htmlText('<script>x()</script>A&nbsp;<b>B</b>&#44;'), 'A B,', '도구의 기존 기대값 그대로');
  assert.doesNotThrow(() => g.envelope({ id: 'g', snippet: '&#99999999999;', payload: { headers: [] } }, 'acc'));
});
