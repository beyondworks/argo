// 오피스 마크다운(src/core/markdown.js → ui/Markdown.jsx, 16차 — PARITY-agents B7·PARITY-common W7): 체크 목록·링크·구분선·코드 블록·하위 목록·머리말.
// 기존 규칙(제목·목록·표·인용·굵게·코드, HTML 글자는 글자 그대로)은 test/company-model.test.mjs가 잠그고 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, inline, stripFrontMatter } from '../src/core/markdown.js';

test('체크 목록: - [ ] / - [x], 글머리 없는 ☐·☑ 줄도 — 켜짐 표시', () => {
  const [b] = parseMarkdown('- [x] 끝냄\n- [ ] 남음\n☐ 상자\n☑ 체크');
  assert.equal(b.type, 'tasks');
  assert.deepEqual(b.items.map((i) => [i.checked, i.text[0].v]), [[true, '끝냄'], [false, '남음'], [false, '상자'], [true, '체크']]);
  assert.deepEqual(parseMarkdown('- 글머리\n- [ ] 체크').map((x) => x.type), ['ul', 'tasks'], '종류가 바뀌면 목록을 나눈다');
});

test('하위 목록: 들여 쓴 줄은 바로 앞 항목 아래 — 첫 줄부터 들여 써도 줄을 잃지 않는다', () => {
  const [b] = parseMarkdown('- 하나\n  - 하나의 하위\n    1. 더 아래\n- 둘');
  assert.deepEqual(b.items.map((i) => i.text[0].v), ['하나', '둘']);
  assert.equal(b.items[0].children[0].type, 'ul');
  assert.equal(b.items[0].children[0].items[0].children[0].type, 'ol');
  const odd = parseMarkdown('  - 들여 쓴 첫 줄\n- 바깥');
  assert.deepEqual(odd.flatMap((x) => x.items.map((i) => i.text[0].v)), ['들여 쓴 첫 줄', '바깥']);
  assert.equal(parseMarkdown('3. 셋\n4. 넷')[0].start, 3);
});

test('코드 블록·구분선: 코드 안의 줄은 꾸미지 않고 그대로, ---·***·─── 줄은 구분선', () => {
  const b = parseMarkdown('```js\n# 제목 아님\n- 목록 아님\n```\n\n---\n***\n───');
  assert.deepEqual(b.map((x) => x.type), ['code', 'hr', 'hr', 'hr']);
  assert.deepEqual([b[0].lang, b[0].text], ['js', '# 제목 아님\n- 목록 아님']);
  assert.equal(parseMarkdown('```\n안 닫힌 코드')[0].text, '안 닫힌 코드', '닫는 줄이 없으면 끝까지');
});

test('링크: [글](주소)와 맨 주소 — http(s)·mailto만, javascript: 같은 주소는 글자만', () => {
  assert.deepEqual(inline('자료 [안내](https://a.test/x) 참고'), [{ t: 'text', v: '자료 ' }, { t: 'link', v: '안내', href: 'https://a.test/x' }, { t: 'text', v: ' 참고' }]);
  assert.deepEqual(inline('[메일](mailto:a@b.c)')[0], { t: 'link', v: '메일', href: 'mailto:a@b.c' });
  assert.deepEqual(inline('[나쁜](javascript:alert(1))').map((p) => p.t), ['text'], '링크로 만들지 않는다');
  assert.deepEqual(inline('보기: https://a.test/x.'), [{ t: 'text', v: '보기: ' }, { t: 'link', v: 'https://a.test/x', href: 'https://a.test/x' }, { t: 'text', v: '.' }], '끝 문장부호는 주소에서 뺀다');
});

test('글자 꾸밈: 굵게·기울임·취소선·코드 — 이름 속 밑줄·곱하기 기호는 꾸밈이 아니다', () => {
  assert.deepEqual(inline('**굵게** *기울임* ~~취소~~ `코드`').filter((p) => p.t !== 'text').map((p) => p.t), ['bold', 'italic', 'strike', 'code']);
  assert.deepEqual(inline('보고서_최종_본.pdf').map((p) => p.t), ['text']);
  assert.deepEqual(inline('a * b * c').map((p) => p.t), ['text']);
  assert.deepEqual(inline('`**굵게 아님**`'), [{ t: 'code', v: '**굵게 아님**' }]);
});

test('머리말: 문서 맨 앞 --- 사이의 이름: 값 줄만 뺀다(공용 문서 본문), 본문 중간 구분선은 그대로', () => {
  assert.equal(stripFrontMatter('---\ntitle: 규칙\ntags: a\n---\n# 규칙\n본문'), '# 규칙\n본문');
  assert.equal(stripFrontMatter('# 제목\n\n---\n\n아래'), '# 제목\n\n---\n\n아래');
  assert.equal(stripFrontMatter('---\n그냥 글\n---\n'), '---\n그냥 글\n---\n', '이름: 값 줄이 없으면 구분선으로 둔다');
});
