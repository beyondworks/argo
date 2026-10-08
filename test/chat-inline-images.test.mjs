// 대화창 그림 표시(정비사 10/5 전달·유건 지시) — "산출물에 저장된 페퍼 아바타 이미지를 채팅창에 첨부해줘"에 화면이 비던 사고.
// 격리 서버 재현(origin/main f19d2d21): ① `![](projects/…/페퍼-아바타.png)`가 빈 <p>만 남김 ② 같은 경로 링크는 marked가 한글을
// %인코딩한 값을 다시 인코딩해(%25ED…) files API가 404 ③ 답이 가리킨 기존 파일은 칩에도 없음(artifacts: []).
// 여기서는 실제 app/ui.jsx Markdown을 mini-react 위에서 그대로 돌려 **렌더 결과 HTML과 클릭 동작**을 잠근다(소스 문자열 핀 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const file = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const { loadComponent } = await import('./helpers/load-component.mjs');
const { mount, Fragment } = await import('./helpers/mini-react.mjs');
const markedUrl = import.meta.resolve('marked');
const { Markdown } = await loadComponent(file('../app/ui.jsx'), {
  stubs: {
    marked: `export * from '${markedUrl}';`,
    './i18n': 'export const useLang = () => ({ t: (k) => k, lang: "ko" });',
    'react-dom': 'export const createPortal = (node, target) => ({ type: "portal", props: { node, target } });',
    '@tauri-apps/plugin-opener': 'export const openUrl = async () => {}; export const revealItemInDir = async () => {};',
    '@tauri-apps/api/core': 'export const invoke = async () => "";',
    '@tauri-apps/plugin-dialog': 'export const open = async () => null;',
  },
  real: ['../app/tabs-state.mjs', '../app/md-table.mjs', '../src/vault-links.mjs', '../app/c/[ws]/zoom-math.mjs', '../app/apimsg.mjs', '../app/authmsg.mjs'].map(file),
});
const { rewriteVaultHref, vaultImageSrc, vaultFileRel } = await import('../src/vault-links.mjs').then((m) => ({ vaultImageSrc: () => null, vaultFileRel: () => null, ...m }));

const kids = (n) => [n?.props?.children].flat(Infinity).filter((c) => c && typeof c === 'object');
function find(n, pred) {
  if (!n || typeof n !== 'object') return null;
  if (pred(n)) return n;
  for (const c of kids(n)) { const hit = find(c, pred); if (hit) return hit; }
  if (n.type === 'portal') return find(n.props.node, pred);
  return null;
}
async function render(text, wsId = 'w1') {
  const r = mount(Markdown, { text, wsId });
  await r.flush();
  const out = () => r.state.out;
  const md = () => find(out(), (n) => n.props?.className === 'md');
  return { r, out, md, html: md().props.dangerouslySetInnerHTML.__html };
}
const imgs = (html) => html.match(/<img\b[^>]*>/gi) ?? [];
const srcOf = (tag) => /\ssrc="([^"]*)"/.exec(tag)?.[1] ?? null;
const relOf = (url) => new URL(url, 'http://x').searchParams.get('rel');
/** img 태그가 name="value" 속성들로만 이뤄졌는지 — 속성 탈출(onerror 등)이 생기면 속성 이름으로 드러난다. */
function attrNames(tag) {
  const body = tag.replace(/^<img/i, '').replace(/\/?>$/, '');
  const names = [];
  const rest = body.replace(/\s([a-z-]+)="[^"]*"/gi, (_, n) => { names.push(n.toLowerCase()); return ''; });
  assert.equal(rest.trim(), '', `속성 밖 잔여물: ${tag}`);
  return names;
}
const AVATAR = 'projects/20261002_페퍼-아바타/페퍼-아바타.png';

// ─── 인접 행동 핀(origin/main에서도 초록이어야 한다 — 바꾸면서 망가뜨리지 않을 것) ───
test('핀: 외부 http(s)·data·프로토콜 상대 그림은 태그째 지운다(추적 픽셀·유출 방어)', async () => {
  for (const src of ['https://example.com/pixel.png', 'http://example.com/a.png', '//evil.com/x.png', 'data:image/png;base64,iVBORw0KGgo=']) {
    const { html } = await render(`앞 ![x](${src}) 뒤`);
    assert.equal(imgs(html).length, 0, `${src} 그림이 남았다`);
    assert.doesNotMatch(html, /evil\.com|example\.com|data:image/, `${src} 주소가 본문에 남았다`);
  }
});
test('핀: 같은 출처 "/" 그림은 그대로 둔다', async () => {
  const { html } = await render('![x](/api/companies/w1/files?rel=projects%2Fa.png)');
  assert.equal(imgs(html).length, 1);
  assert.equal(relOf(srcOf(imgs(html)[0]).replace(/&amp;/g, '&')), 'projects/a.png');
});
test('핀: wsId가 없으면(메신저·분할 패널) vault 상대 그림·링크는 살리지 않는다', async () => {
  const { html } = await render(`![x](${AVATAR}) [y](projects/a.pdf)`, null); // null = wsId 없음(기본값 w1을 타지 않게)
  assert.equal(imgs(html).length, 0);
  assert.match(html, /href="#"/);
});
test('핀: 링크 — 산출물은 files API, 스킴·구역 밖은 #, 새 창 안전 속성', async () => {
  const { html } = await render('[a](projects/x/a.pdf) [b](javascript:alert(1)) [c](notes/x.csv)');
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.equal(relOf(hrefs[0]), 'projects/x/a.pdf');
  assert.deepEqual(hrefs.slice(1), ['#', '#']);
  assert.equal((html.match(/rel="noopener noreferrer"/g) ?? []).length, 3);
});
test('핀: 날 HTML <img onerror>는 글자로 이스케이프된다', async () => {
  const { html } = await render('<img src=x onerror=alert(1)>');
  assert.equal(imgs(html).length, 0);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)/);
});

// ─── 새 동작(origin/main에서 빨강) ───
test('vault 구역 안 상대 경로 그림 → files API 주소로 그린다(제보 사례: 한글 폴더·파일명)', async () => {
  const { html } = await render(`페퍼 아바타입니다.\n\n![페퍼 아바타](${AVATAR})`);
  const [tag] = imgs(html);
  assert.ok(tag, `그림이 사라졌다: ${html}`);
  const src = srcOf(tag).replace(/&amp;/g, '&');
  assert.match(src, /^\/api\/companies\/w1\/files\?rel=/);
  assert.equal(relOf(src), AVATAR, 'marked의 %인코딩을 풀어 실제 파일 경로 하나로(이중 인코딩 404 금지)');
  assert.match(tag, /class="md-img"/);
  assert.match(tag, /alt="페퍼 아바타"/);
});
test('경로 표기 변형 — ./ · vault/ · 공백(%20) · 대문자 확장자 · files/_imported 구역', async () => {
  for (const [md, rel] of [
    [`![a](./${AVATAR})`, AVATAR], [`![a](vault/${AVATAR})`, AVATAR],
    ['![a](files/보고%20자료/그림%20(1).PNG)', 'files/보고 자료/그림 (1).PNG'], ['![a](_imported/x/y.webp)', '_imported/x/y.webp'], // 공백은 %20 — <…> 꼴은 렌더러가 <를 먼저 이스케이프해 링크와 똑같이 안 된다(종전)
    ['![a](projects/x/y.jpeg "제목")', 'projects/x/y.jpeg'],
  ]) {
    const { html } = await render(md);
    const [tag] = imgs(html);
    assert.ok(tag, `${md} 그림 없음`);
    assert.equal(relOf(srcOf(tag).replace(/&amp;/g, '&')), rel, md);
  }
});
test('구역 밖·탈출·스킴은 그림으로도 링크로도 살리지 않는다(경로 탈출 방어)', async () => {
  for (const src of ['projects/../company.json', 'projects/%2e%2e/.secrets.json', 'projects/x/%2E%2E/%2E%2E/a.png', 'notes/outside.png', 'journal/2026-10-08-a.png',
    'files\\x.png', 'javascript:alert(1)', 'projects//x.png', '/projects/../../etc/passwd'.slice(1), '%2Fetc%2Fpasswd', 'projects/a.png%00.txt']) {
    const { html } = await render(`![x](${src})`);
    const tags = imgs(html).filter((t) => !/^\/(?!\/)/.test(srcOf(t) ?? ''));
    assert.equal(tags.length, 0, `${src}가 그림으로 남았다: ${html}`);
    for (const t of imgs(html)) assert.ok(!/\/files\?rel=/.test(srcOf(t)), `${src}가 files API로 바뀌었다`);
    assert.doesNotMatch(html, /<a [^>]*href="\/api\//, `${src}가 파일 링크로 바뀌었다: ${html}`);
  }
});
test('구역 안 비래스터(svg·pdf)는 <img>로 못 그린다 — 지우지 않고 파일 링크로 남긴다', async () => {
  const { html } = await render('![차트](projects/x/chart.svg) ![문서](projects/x/r.pdf)');
  assert.equal(imgs(html).length, 0);
  const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [relOf(m[1].replace(/&amp;/g, '&')), m[2]]);
  assert.deepEqual(links, [['projects/x/chart.svg', '차트'], ['projects/x/r.pdf', '문서']]);
});
test('XSS: alt·title·경로에 따옴표·onerror를 넣어도 속성은 src·alt·title·class·loading·tabindex뿐', async () => {
  for (const md of [
    '![x" onerror="alert(1)](projects/a.png)', '![x](projects/a.png "t\\" onerror=\\"alert(1)")', '![x](projects/%22onerror=alert(1)%22.png)',
    "![x](projects/a'onerror='alert(1).png)", '![<script>alert(1)</script>](projects/a.png)', '![x](projects/$&$`$\'.png)',
  ]) {
    const { html } = await render(md);
    for (const tag of imgs(html)) {
      for (const n of attrNames(tag)) assert.ok(['src', 'alt', 'title', 'class', 'loading', 'tabindex'].includes(n), `${md} → 허용 밖 속성 ${n}: ${tag}`);
      assert.doesNotMatch(srcOf(tag), /["<>\s]/, `${md} → src에 날 문자`);
    }
    assert.doesNotMatch(html, /<script/i, md);
  }
  const { html } = await render('![x](projects/$&$`$\'.png)');
  assert.equal(relOf(srcOf(imgs(html)[0]).replace(/&amp;/g, '&')), "projects/$&$`$'.png", '치환 패턴($&)이 주소를 바꾸지 않는다');
});
test('marked 링크도 같은 디코딩 — 한글 파일 링크가 실제 경로로(이중 인코딩 404 해소)', async () => {
  const { html } = await render(`[아바타](${AVATAR}) [메모](notes/회의 메모.md)`.replace('회의 메모', '회의메모'));
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.equal(relOf(hrefs[0]), AVATAR);
  assert.equal(new URL(hrefs[1], 'http://x').searchParams.get('doc'), 'notes/회의메모.md');
});
test('그림을 누르면(또는 Enter) 크게 보기 창이 그 파일로 열리고, 같은 출처 다른 그림·글자 클릭은 열지 않는다', async () => {
  const v = await render(`![a](${AVATAR})\n\n![b](/logo.png)`);
  const viewer = () => find(v.out(), (n) => typeof n.type === 'function' && n.props?.rel !== undefined && n.props?.ws !== undefined);
  assert.equal(viewer(), null, '처음엔 닫혀 있다');
  const src = srcOf(imgs(v.html)[0]);
  const fakeImg = (s) => ({ getAttribute: (k) => (k === 'src' ? s : null), closest: (sel) => (/img/.test(sel) ? fakeImg(s) : null) });
  v.md().props.onClick({ target: { closest: () => null }, preventDefault: () => assert.fail('글자 클릭은 기본 동작을 막지 않는다') });
  await v.r.flush();
  assert.equal(viewer(), null, '글자 클릭은 무반응');
  v.md().props.onClick({ target: fakeImg(srcOf(imgs(v.html)[1])), preventDefault: () => assert.fail('열지 않는 그림은 기본 동작을 막지 않는다') });
  await v.r.flush();
  assert.equal(viewer(), null, 'files API가 아닌 같은 출처 그림은 열지 않는다');
  let navPrevented = false;
  v.md().props.onClick({ target: fakeImg(src), preventDefault: () => { navPrevented = true; } });
  await v.r.flush();
  assert.equal(viewer()?.props.rel, AVATAR, '누른 그림의 실제 경로로 연다');
  assert.ok(navPrevented, '그림을 감싼 링크가 있어도 항해하지 않는다');
  assert.equal(viewer()?.props.ws, 'w1');
  viewer().props.onClose();
  await v.r.flush();
  assert.equal(viewer(), null, '닫기');
  let prevented = false;
  v.md().props.onKeyDown({ key: 'Enter', target: fakeImg(src), preventDefault: () => { prevented = true; } });
  await v.r.flush();
  assert.equal(viewer()?.props.rel, AVATAR, 'Enter로도 연다(키보드 접근)');
  assert.ok(prevented);
  void Fragment;
});

// ─── 순수 함수(src/vault-links.mjs) ───
test('vault-links: marked %인코딩 복원·깨진 %는 날값 유지·%2e%2e 탈출 거부', () => {
  const enc = encodeURI(AVATAR);
  assert.equal(relOf(rewriteVaultHref(enc, 'w1')), AVATAR);
  assert.equal(relOf(rewriteVaultHref('files/100%.pdf', 'w1')), 'files/100%.pdf', '깨진 % — 날값 그대로(던지지 않는다)');
  assert.equal(rewriteVaultHref('projects/%2e%2e/.secrets.json', 'w1'), null);
  assert.equal(rewriteVaultHref('projects%2F..%2F.secrets.json', 'w1'), null);
  assert.equal(relOf(vaultImageSrc(enc, 'w1')), AVATAR);
  assert.equal(vaultImageSrc('projects/a.svg', 'w1'), null, 'svg는 files API가 octet-stream — <img> 불가');
  assert.equal(vaultImageSrc('notes/a.png', 'w1'), null, '구역 밖');
  assert.equal(vaultImageSrc('projects/a.png', ''), null, 'wsId 없음');
  assert.equal(vaultFileRel(vaultImageSrc(enc, 'w1'), 'w1'), AVATAR);
  assert.equal(vaultFileRel(vaultImageSrc(enc, 'w1'), 'w2'), null, '다른 회사 주소는 열지 않는다');
  assert.equal(vaultFileRel('/logo.png', 'w1'), null);
  assert.equal(vaultFileRel('/api/companies/w1/files?rel=projects%2F..%2Fx.png', 'w1'), null);
});
