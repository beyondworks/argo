// 대화창 그림 — 같은 경로를 덮어쓴 뒤("시안 수정해줘")에도 새 답·크게 보기·칩 미리보기·저장이 새 그림이어야 한다(IMG 1차 검수 MEDIUM).
// 격리 실측(2026-10-09, :3497, ego-browser): files API를 no-cache+ETag로 바꿔도 **같은 문서 안에서는** 브라우저가 같은 주소 그림을 서버에 다시
// 묻지 않고 재사용해 새 답 그림이 256px(옛 그림), 새로고침 뒤에만 32px였다. 그래서 그림 주소에 판을 붙인다: 답 그림 = 그 답의 시각,
// 크게 보기·칩 미리보기 = 연 시각. 데스크톱 저장(artifactDownload)은 fetch no-store. 겹친 보기 창의 ESC는 맨 위 창만(IMG 1차 검수 LOW).
// 실제 app/ui.jsx·artifact-chips.jsx를 mini-react 위에서 돌려 렌더 결과·이벤트를 단언한다(소스 문자열 핀 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const file = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const { loadComponent } = await import('./helpers/load-component.mjs');
const { mount } = await import('./helpers/mini-react.mjs');
const markedUrl = import.meta.resolve('marked');

// 브라우저 대역 — window(이벤트)·document.body(스크롤 잠금)·Tauri 표지(데스크톱 저장 경로)
globalThis.window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} });
globalThis.document = { body: { style: {} }, getElementById: () => null };
const invoked = []; const fetched = [];
globalThis.__invoked = invoked;

const ui = await loadComponent(file('../app/ui.jsx'), {
  stubs: {
    marked: `export * from '${markedUrl}';`,
    './i18n': 'export const useLang = () => ({ t: (k) => k, lang: "ko" });',
    'react-dom': 'export const createPortal = (node, target) => ({ type: "portal", props: { node, target } });',
    '@tauri-apps/plugin-opener': 'export const openUrl = async () => {}; export const revealItemInDir = async () => {};',
    '@tauri-apps/api/core': 'export const invoke = async (cmd, args) => { globalThis.__invoked.push([cmd, args]); return "/tmp/x"; };',
    '@tauri-apps/plugin-dialog': 'export const open = async () => null;',
  },
  real: ['../app/tabs-state.mjs', '../app/md-table.mjs', '../src/vault-links.mjs', '../src/deck-metrics.mjs', '../app/c/[ws]/zoom-math.mjs', '../app/apimsg.mjs', '../app/authmsg.mjs'].map(file),
});
const { Markdown, artifactDownload, useEscapeClose } = ui;

const kids = (n) => [n?.props?.children].flat(Infinity).filter((c) => c && typeof c === 'object');
function find(n, pred) {
  if (!n || typeof n !== 'object') return null;
  if (pred(n)) return n;
  for (const c of kids(n)) { const hit = find(c, pred); if (hit) return hit; }
  if (n.type === 'portal') return find(n.props.node, pred);
  return null;
}
const imgTags = (html) => html.match(/<img\b[^>]*>/gi) ?? [];
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const unamp = (s) => s.replace(/&amp;/g, '&');
const params = (url) => new URL(unamp(url), 'http://x').searchParams;
const AVATAR = 'projects/20261008_시안/시안.png';
async function md(text, props = {}) {
  const r = mount(Markdown, { text, wsId: 'w1', ...props });
  await r.flush();
  const node = find(r.state.out, (n) => n.props?.className === 'md');
  return { r, node, html: node.props.dangerouslySetInnerHTML.__html };
}
const esc = () => { const e = new Event('keydown'); e.key = 'Escape'; globalThis.window.dispatchEvent(e); return e; };
const unmount = (r) => { for (const h of r.state.hooks) h?.cleanup?.(); }; // mini-react엔 언마운트가 없다 — effect 정리만 돌린다

test('답 그림 주소 = 파일 경로 + 그 답의 시각(v) — 같은 경로를 가리킨 새 답은 다른 주소라 문서 안 옛 그림을 재사용하지 않는다', async () => {
  const old = await md(`![시안](${AVATAR})`, { ver: 1791470000000 });
  const neu = await md(`![시안](${AVATAR})`, { ver: 1791470900000 });
  const [a] = imgTags(old.html); const [b] = imgTags(neu.html);
  assert.ok(a && b, '그림이 그려진다');
  assert.equal(params(attr(a, 'src')).get('rel'), AVATAR, '경로는 그대로');
  assert.equal(params(attr(a, 'src')).get('v'), '1791470000000');
  assert.notEqual(attr(a, 'src'), attr(b, 'src'), '새 답은 새 주소');
  assert.match(attr(a, 'src'), /&amp;v=/, 'HTML 속성 안 &는 &amp;');
  const plain = await md(`![시안](${AVATAR})`);
  assert.equal(params(attr(imgTags(plain.html)[0], 'src')).get('v'), null, '시각이 없는 자리(기억 문서·미리보기)는 종전 주소');
});

test('크게 보기 창 = 연 시각의 지금 파일 — 누른 답 그림 주소(옛 그림일 수 있다)가 아니라 새 판으로 연다, 경로는 그대로', async () => {
  const v = await md(`![시안](${AVATAR})`, { ver: 1 });
  const src = unamp(attr(imgTags(v.html)[0], 'src'));
  const fake = { getAttribute: (k) => (k === 'src' ? src : null), closest: (sel) => (/img/.test(sel) ? fake : null) };
  v.node.props.onClick({ target: fake, preventDefault() {} });
  await v.r.flush();
  const viewerNode = find(v.r.state.out, (n) => typeof n.type === 'function' && n.props?.rel === AVATAR);
  assert.ok(viewerNode, '창이 열린다');
  const realNow = Date.now; Date.now = () => 1791479999999;
  const viewer = mount(viewerNode.type, viewerNode.props);
  try { await viewer.flush(); } finally { Date.now = realNow; }
  const img = find(viewer.state.out, (n) => n.type === 'img');
  assert.equal(params(img.props.src).get('rel'), AVATAR);
  assert.equal(params(img.props.src).get('v'), '1791479999999', '연 시각');
  assert.notEqual(img.props.src, src, '말풍선 주소와 다르다(문서 안 옛 그림 재사용 차단)');
  const save = find(viewer.state.out, (n) => n.type === 'a' && /download=1/.test(n.props?.href ?? ''));
  assert.equal(params(save.props.href).get('rel'), AVATAR, '저장 버튼은 같은 파일');
  unmount(viewer);
});

test('겹친 보기 창 ESC: 맨 위 창만 닫히고, 그 창이 닫히면 다음 ESC가 아래 창을 닫는다(전파는 맨 위 창이 끊는다)', async () => {
  const closed = [];
  const Layer = ({ name }) => { useEscapeClose(() => closed.push(name)); return null; };
  const outer = mount(Layer, { name: 'outer' }); await outer.flush();
  const inner = mount(Layer, { name: 'inner' }); await inner.flush();
  let later = 0; const after = () => { later += 1; };
  globalThis.window.addEventListener('keydown', after, true); // 창 뒤 패널·메뉴 대역 — 맨 위 창이 전파를 끊어야 한다
  esc();
  assert.deepEqual(closed, ['inner'], '안쪽(나중에 연) 창만');
  assert.equal(later, 0, '같은 ESC가 뒤로 새지 않는다');
  unmount(inner);
  esc();
  assert.deepEqual(closed, ['inner', 'outer'], '안쪽이 닫힌 뒤엔 바깥 창');
  unmount(outer);
  esc();
  assert.deepEqual(closed, ['inner', 'outer'], '다 닫히면 무반응');
  assert.equal(later, 1, '창이 없으면 ESC는 원래대로 흐른다');
  globalThis.window.removeEventListener('keydown', after, true);
});

test('데스크톱 저장(artifactDownload): 브라우저 캐시를 건너뛴 지금 바이트(fetch no-store)를 IPC로 저장한다', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  globalThis.fetch = async (url, init) => { fetched.push([url, init]); return { ok: true, blob: async () => new Blob([bytes]) }; };
  const url = `/api/companies/w1/files?rel=${encodeURIComponent(AVATAR)}`;
  let prevented = false;
  await artifactDownload(url, '시안.png')({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented, '앱에서는 기본 앵커 동작을 막는다');
  assert.equal(fetched.at(-1)[0], url);
  assert.equal(fetched.at(-1)[1]?.cache, 'no-store', '옛 max-age 사본·같은 문서 사본을 저장하지 않는다');
  assert.deepEqual(invoked.at(-1), ['save_download', { name: '시안.png', data: [1, 2, 3, 4] }]);
});

// ─── 칩 미리보기(app/c/[ws]/artifact-chips.jsx) — 같은 계약: 펼친 시각의 지금 파일, 보기 창 ESC는 공용 층 ───
const escCalls = [];
globalThis.__escCalls = escCalls;
const chips = await loadComponent(file('../app/c/[ws]/artifact-chips.jsx'), {
  stubs: {
    '../../ui': `export const Icon = () => null; export const Markdown = () => null; export const Spinner = () => null; export const api = async () => ({ content: '' });
      export const artifactDownload = () => () => {}; export const useScrollLock = () => {}; export const useEscapeClose = (f) => { globalThis.__escCalls.push(f); };`,
    '../../i18n': 'export const useLang = () => ({ t: (k) => k, lang: "ko" });',
    'react-dom': 'export const createPortal = (node, target) => ({ type: "portal", props: { node, target } });',
  },
});
async function openChip(rel, how) {
  const r = mount(chips.ArtifactChips, { ws: 'w1', rels: [rel] });
  await r.flush();
  const a = find(r.state.out, (n) => n.type === 'a' && n.props?.className === 'memo-chip');
  const eye = find(r.state.out, (n) => n.type === 'button' && /ap-toggle/.test(n.props?.className ?? ''));
  if (how === 'eye') eye.props.onClick(); else a.props.onClick({ preventDefault() {} });
  await r.flush();
  return r;
}

test('칩 미리보기: 그림은 펼친 시각(v)으로, pdf 프레임도 같은 판 — 텍스트·svg는 fetch no-cache(매번 재확인)', async () => {
  const realNow = Date.now; Date.now = () => 1791480000000;
  try {
    const r = await openChip(AVATAR, 'eye');
    const prevNode = find(r.state.out, (n) => typeof n.type === 'function' && n.props?.rel === AVATAR && !n.props?.onClose);
    const prev = mount(prevNode.type, prevNode.props); await prev.flush();
    const img = find(prev.state.out, (n) => n.type === 'img');
    assert.equal(params(img.props.src).get('rel'), AVATAR);
    assert.equal(params(img.props.src).get('v'), '1791480000000');
    const pdfNode = { ...prevNode, props: { ...prevNode.props, rel: 'projects/x/r.pdf' } };
    const pdf = mount(pdfNode.type, pdfNode.props); await pdf.flush();
    const frame = find(pdf.state.out, (n) => n.type === 'iframe');
    assert.equal(params(frame.props.src).get('inline'), '1');
    assert.equal(params(frame.props.src).get('v'), '1791480000000');
  } finally { Date.now = realNow; }
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(init); return { ok: true, body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: new TextEncoder().encode('a,b') })), cancel: async () => {} }; } } }; };
  const r2 = await openChip('projects/x/t.csv', 'eye');
  const tNode = find(r2.state.out, (n) => typeof n.type === 'function' && n.props?.rel === 'projects/x/t.csv' && !n.props?.onClose);
  const tp = mount(tNode.type, tNode.props); await tp.flush(); await tp.flush();
  assert.equal(seen.at(-1)?.cache, 'no-cache', '텍스트 미리보기 fetch는 매번 재확인');
});

test('칩 보기 창(ArtifactViewer): ESC는 공용 층(useEscapeClose)으로 — 안쪽 그림 창과 같은 층 목록을 쓴다', async () => {
  const r = await openChip(AVATAR, 'chip');
  const viewerNode = find(r.state.out, (n) => typeof n.type === 'function' && n.props?.rel === AVATAR && typeof n.props?.onClose === 'function');
  assert.ok(viewerNode, '칩을 누르면 보기 창');
  const before = escCalls.length;
  const v = mount(viewerNode.type, viewerNode.props); await v.flush();
  assert.equal(escCalls.length, before + 1, '보기 창이 ESC 층에 든다');
  escCalls.at(-1)();
  await r.flush();
  assert.equal(find(r.state.out, (n) => typeof n.type === 'function' && typeof n.props?.onClose === 'function' && n.props?.rel === AVATAR), null, '층의 닫기 = 그 보기 창 닫기');
});
