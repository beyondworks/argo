// 가짜 서버·응답 수집기가 한글을 조각 경계에서 깨뜨리지 않는지 잠근다(2026-10-13, LOW-5 후속).
// Buffer 조각을 문자열에 `b += c`로 이으면 3바이트 한글이 조각 사이에서 잘릴 때 U+FFFD 3개가 된다 — #981이 한 곳을 고쳤고, 이 시험은 나머지 수집기 전부를 지킨다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStrictVendor } from './helpers/strict-vendor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** 문자열에 이어 붙이는 HTTP 본문 수집기(`req|q|res.on('data', (c) => b += c)`) 중 같은 줄이나 앞 3줄에 그 변수의 setEncoding이 없는 자리. */
// 한계: 흔한 모양만 잡는다 — 변수 이름 req·q·res, 작은따옴표 'data', 화살표 함수 안의 `x += c`. `request.on`·`"data"`·`function (c) {…}`·함수 참조(`.on('data', collect)`)·`b = b + c`·`+= c.toString()`·자식 프로세스 stdin은 놓친다(2026-10-13 검수 2 LOW-2). 새 수집기는 모양과 관계없이 setEncoding을 붙인다.
export function unsafeCollectors(text) {
  const lines = text.split('\n'); const out = [];
  const re = /\b(req|q|res)\.on\(\s*'data'\s*,\s*\(?\s*(\w+)\s*\)?\s*=>\s*[({]?\s*\w+\s*\+=\s*\2\b/g;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(re)) {
      const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (!near.includes(`${m[1]}.setEncoding('utf8')`)) out.push({ line: i + 1, v: m[1] });
    }
  });
  return out;
}

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  if (n === 'node_modules') return [];
  const p = join(dir, n); const s = statSync(p);
  return s.isDirectory() ? walk(p) : /\.m?js$/.test(n) ? [p] : [];
});

test('검사기 자체 — 고치기 전 모양은 잡고, setEncoding을 붙인 모양은 통과시킨다', () => {
  assert.equal(unsafeCollectors("let b = ''; req.on('data', (c) => (b += c));").length, 1);
  assert.equal(unsafeCollectors("let d = ''; req.on('data', (c) => { d += c; });").length, 1);
  assert.equal(unsafeCollectors("http.createServer((q,r)=>{ let b=''; q.on('data',c=>b+=c); });").length, 1);
  assert.equal(unsafeCollectors("let b = ''; res.on('data', (c) => (b += c));").length, 1);
  assert.equal(unsafeCollectors("let b = ''; req.setEncoding('utf8'); req.on('data', (c) => (b += c));").length, 0);
  assert.equal(unsafeCollectors("res.setEncoding('utf8');\nres.on('data', (c) => { body += c; });").length, 0);
  assert.equal(unsafeCollectors("const chunks = []; req.on('data', (c) => chunks.push(c));").length, 0, 'Buffer.concat 수집은 안전');
});

test('시험 폴더의 HTTP 본문 수집기는 모두 setEncoding을 거친다', () => {
  const dirs = ['test', 'apps/messenger/test'].map((d) => join(ROOT, d));
  const bad = [];
  for (const dir of dirs) {
    let files = []; try { files = walk(dir); } catch { continue; }
    for (const f of files) {
      if (f === SELF) continue;
      for (const h of unsafeCollectors(readFileSync(f, 'utf8'))) bad.push(`${relative(ROOT, f).split('\\').join('/')}:${h.line} ${h.v}`);
    }
  }
  assert.deepEqual(bad, [], `한글이 조각 경계에서 깨질 수 있는 수집기 — ${'`'}X.setEncoding('utf8')${'`'}를 붙인다:\n${bad.join('\n')}`);
});

test('엄격 벤더 가짜 서버 — 요청 본문이 한글 글자 가운데에서 나뉘어 와도 그대로 기록한다', async () => {
  const v = await startStrictVendor({ vendor: 'anthropic' });
  try {
    const sys = '지시한 파일 수정 완료';
    const body = Buffer.from(JSON.stringify({ model: 'm', max_tokens: 8, system: sys, messages: [{ role: 'user', content: '확인' }] }));
    const cut = body.indexOf(Buffer.from('일')) + 1; // '일'(3바이트)의 첫 바이트 뒤에서 자른다
    const stream = new ReadableStream({ async start(ctl) { ctl.enqueue(body.subarray(0, cut)); await new Promise((r) => setTimeout(r, 30)); ctl.enqueue(body.subarray(cut)); ctl.close(); } }); // 두 번째 조각을 늦게 — 서버가 첫 조각을 따로 받게
    const res = await fetch(`${v.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test' }, body: stream, duplex: 'half' });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(v.calls.length, 1);
    assert.equal(v.calls[0].body.system, sys);
  } finally { await v.close(); }
});
