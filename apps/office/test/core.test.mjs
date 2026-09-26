// 오피스 기초 규칙 — 규칙마다 이유 한 줄. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mergeLayout, sizeForSpan, move, mergePages } from '../src/core/layout.js';
import { dragHasFiles, filesFromTransfer } from '../src/core/files.js';
import { imeGuardWith } from '../src/core/ime.js';
import { build, graphiteBlocks } from '../scripts/gen-tokens.mjs';

const REG = [
  { id: 'a', sizes: ['s', 'm'], defaultSize: 'm', spaces: ['me', 'org'] },
  { id: 'b', sizes: ['m', 'full'], defaultSize: 'full', spaces: ['me'] },
  { id: 'c', sizes: ['s', 'm'], defaultSize: 's', spaces: ['org'] },
];

// 이유: 저장된 배치가 없으면 기본 배치 — 처음 들어온 사람에게 빈 화면을 보이지 않는다.
test('배치 없음 → 기본 배치(이 공간에서 못 쓰는 모듈 제외)', () => {
  assert.deepEqual(mergeLayout(null, REG, 'me', [{ id: 'a', size: 's' }, { id: 'c', size: 's' }]), [{ id: 'a', size: 's', hidden: false }]);
});

// 이유: 사용자가 고른 화면을 새 모듈이 밀어내면 안 된다 → 새 모듈은 끝에 숨김으로.
test('새 모듈은 끝에 숨김, 없어진 모듈·중복은 버린다, 허용되지 않은 크기는 기본 크기로', () => {
  const saved = { items: [{ id: 'b', size: 's' }, { id: 'gone', size: 'm' }, { id: 'b', size: 'm' }] };
  assert.deepEqual(mergeLayout(saved, REG, 'me', []), [{ id: 'b', size: 'full', hidden: false }, { id: 'a', size: 'm', hidden: true }]);
});

// 이유: 크기는 1/3·1/2·2/3·전체 네 단계만(유건 확정) — 끌어서 바꿔도 가장 가까운 단계에 붙는다.
test('열 수 → 가장 가까운 크기 단계', () => {
  assert.equal(sizeForSpan(1), 's'); assert.equal(sizeForSpan(5), 's'); assert.equal(sizeForSpan(6), 'm');
  assert.equal(sizeForSpan(7), 'm'); assert.equal(sizeForSpan(9), 'l'); assert.equal(sizeForSpan(11), 'full');
  assert.deepEqual(move(['x', 'y', 'z'], 0, 2), ['y', 'z', 'x']);
});

// 이유: 맥 WKWebView는 파일 드래그를 public.* 타입으로만 알리기도 한다 — 'Files'만 보면 드롭이 조용히 죽는다.
test('파일 드래그 판정·추출(본체 규칙)', () => {
  assert.equal(dragHasFiles({ types: ['public.file-url'], items: [] }), true);
  assert.equal(dragHasFiles({ types: ['text/plain'], items: [{ kind: 'string' }] }), false);
  const f = { name: 'shot.png' };
  assert.deepEqual(filesFromTransfer({ files: [], items: [{ kind: 'file', getAsFile: () => f }] }), [f]);
});

// 이유: 한글 조합 중 Enter가 제출로 새면 마지막 글자가 잘린 채 보내진다.
test('IME 조합 중 Enter는 처리기로 넘기지 않는다', () => {
  let calls = 0; let prevented = false;
  const h = imeGuardWith(() => { calls++; });
  h.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault: () => { prevented = true; } });
  assert.equal(calls, 0); assert.equal(prevented, true);
  h.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} });
  assert.equal(calls, 1);
});

// 이유: 테마 토큰을 손으로 옮기면 한쪽만 고쳐진다 — 정본에서 생성하고, 시스템 다크 값 = graphite-dark 값이어야 한다.
test('graphite 토큰 생성: 자동 다크 = graphite-dark', () => {
  const g = graphiteBlocks(readFileSync(new URL('../../../app/globals.css', import.meta.url), 'utf8'));
  const vars = (s) => s.split('\n').filter((l) => l.includes('--')).map((l) => l.trim()).filter((l) => !l.startsWith('--tg-')).sort();
  assert.deepEqual(vars(g.auto), vars(g['graphite-dark']));
  assert.match(build(), /:root\[data-theme='linen-dark'\]/);
  assert.equal(readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8'), build(), 'tokens.css가 정본과 다르다 — npm run tokens');
});

/* ── 소스 규칙 잠금 ── */
const SRC = new URL('../src/', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
const code = files(SRC).filter((p) => /\.(jsx?|mjs)$/.test(p));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// 이유: Tauri 웹뷰·PWA에서 네이티브 확인 창은 동작이 제각각 — 파괴 액션은 DangerModal, 되돌릴 수 있는 건 되돌리기 토스트.
test('window.confirm/alert/prompt 금지', () => {
  for (const p of code) assert.doesNotMatch(strip(readFileSync(p, 'utf8')), /\b(window\.)?(confirm|alert|prompt)\(/, p);
});

// 이유: 모든 화면 문자열은 ko/en 사전으로(프로젝트 규칙). 예시 데이터·사전 파일만 예외.
test('사전 밖 한글 문자열 금지', () => {
  for (const p of code.filter((x) => !/i18n\.js$|data\/sample\.js$/.test(x))) {
    assert.doesNotMatch(strip(readFileSync(p, 'utf8')), /[가-힣]/, p);
  }
});

// 이유: 터치 기기에서 :hover가 탭에 붙어 남는다 — hover는 (hover: hover) 안에서만. transition: all은 의도 밖 속성까지 움직인다.
test('CSS: hover는 (hover: hover) 안에서만, transition: all 금지', () => {
  const css = readFileSync(new URL('../src/base.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /transition:\s*all/);
  let depth = 0, inHover = -1, buf = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') { if (/@media[^{]*\(hover:\s*hover\)[^{]*$/.test(buf.split('}').at(-1))) inHover = depth; depth++; buf = ''; continue; }
    if (ch === '}') { depth--; if (depth === inHover) inHover = -1; buf = ''; continue; }
    buf += ch;
    if (inHover < 0 && buf.endsWith(':hover')) assert.fail(`(hover: hover) 밖의 :hover — ${buf.trim().slice(-80)}`);
  }
});

// 이유: 노션 열처럼 한 줄의 두 모듈은 경계를 함께 움직인다 — 하나를 당기면 옆이 그만큼 줄고, 둘의 합(줄 폭)은 그대로(유건 2026-09-26).
import { linkedResize, rowsOf } from '../src/core/layout.js';
test('연결된 폭 조절: 합은 유지, 옆은 1/3에서 멈추고 밀려나지 않는다', () => {
  const all = ['s', 'm', 'l', 'full'];
  assert.deepEqual(linkedResize('m', 'm', 8, all, all), ['l', 's']);   // 1/2+1/2 → 오른쪽으로 → 2/3+1/3
  assert.deepEqual(linkedResize('l', 's', 6, all, all), ['m', 'm']);   // 되돌리면 옆도 같이 돌아온다
  assert.deepEqual(linkedResize('m', 'm', 12, all, all), ['l', 's']);  // 끝까지 당겨도 옆은 1/3에서 멈춘다
  assert.deepEqual(linkedResize('m', 'm', 1, all, all), ['s', 'l']);
  assert.deepEqual(linkedResize('m', 'm', 8, all, ['m', 'l', 'full']), ['m', 'm']); // 옆이 1/3을 허용하지 않으면 그대로
  assert.deepEqual(linkedResize('s', 's', 8, all, all), ['s', 's']);   // 1/3씩 셋인 줄은 둘이 나눌 폭이 없어 그대로
  assert.deepEqual(linkedResize('l', 's', 5.45, all, all), ['m', 'm']); // 커서 위치는 반올림하지 않는다 — 5.45열은 1/2(6열)에 더 가깝다(실측 결함)
});

// 이유: 경계 손잡이는 "같은 줄 옆 모듈"이 있어야 뜬다 — 줄 구성은 CSS 격자 자동 배치와 같은 규칙으로 계산한다.
test('줄 나누기: 12열을 넘으면 다음 줄', () => {
  assert.deepEqual(rowsOf([{ id: 'a', size: 'm' }, { id: 'b', size: 'm' }, { id: 'c', size: 'l' }, { id: 'd', size: 's' }, { id: 'e', size: 'full' }]).map((r) => r.map((i) => i.id)), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(rowsOf([{ id: 'a', size: 'l' }, { id: 'b', size: 'm' }]).map((r) => r.map((i) => i.id)), [['a'], ['b']]);
});

// 이유(9/27 실측): 목록 응답은 요청 시점 스냅숏이다. 요청 뒤 응답 전에 새 페이지 만들기가 끝나면 응답엔 그 페이지가 없고
// 보낼 목록에서도 이미 빠져 있어, 화면에서 새 페이지가 사라지고 이어 입력한 글이 저장되지 않았다.
test('목록 병합: 요청 시점에 보낼 것이 있던 페이지는 응답에 없어도 이 기기 값을 지킨다', () => {
  const local = [{ id: 'new', title: 'B', version: 1 }, { id: 'old', title: 'A', version: 3, content: { x: 1 } }];
  const rows = [{ id: 'old', title: 'A', version: 2 }];
  const { pages } = mergePages(rows, local, { before: new Set(['new', 'old']), pendingNow: new Set(), spaceOf: () => 'me' });
  assert.deepEqual(pages.map((p) => p.id).sort(), ['new', 'old']);
  assert.equal(pages.find((p) => p.id === 'old').version, 3); // 응답이 더 옛것 — 이 기기 버전을 지켜야 다음 저장이 거짓 충돌이 안 난다
});

test('목록 병합: 보낼 것이 없던 페이지는 서버 값으로, 서버에 없으면 뺀다', () => {
  const local = [{ id: 'gone', title: 'X', version: 1 }, { id: 'a', title: 'old', version: 1, content: { v: 1 } }];
  const rows = [{ id: 'a', title: 'new', version: 2 }, { id: 'z', title: 'Z', version: 1, archived_at: 't' }];
  const { pages, trash } = mergePages(rows, local, { before: new Set(), pendingNow: new Set(), spaceOf: () => 'me' });
  assert.deepEqual(pages.map((p) => [p.id, p.title, p.content]), [['a', 'new', undefined]]); // 버전이 달라 본문은 열 때 다시
  assert.deepEqual(trash.map((p) => p.id), ['z']);
});
