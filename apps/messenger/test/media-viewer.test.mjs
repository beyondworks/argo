// 첨부 말풍선·크게 보기(2026-10-02 유건 요청) — 순수 로직 행동 테스트.
// lightbox-gesture.mjs: 확대 한도·지점 기준 확대·이동 한도·넘기기/닫기 판정·두 번 탭.
// media-actions.mjs: 환경별로 보일 버튼(저장·공유·이미지 복사·링크 복사), 파일 말풍선 표시값, 보낸 글의 미리보기 요청 여부.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, zoomAt, clampPan, swipeDecision, dismissDecision, isDoubleTap, ZOOM_MAX, wheelZoom } from '../src/lightbox-gesture.mjs';
import { mediaCaps, fileView, shouldRequestPreview, splitAttachments, previewFor } from '../src/media-actions.mjs';

test('clampZoom — 1~최대, 숫자 아님은 1', () => {
  assert.equal(clampZoom(0.3), 1);
  assert.equal(clampZoom(2), 2);
  assert.equal(clampZoom(99), ZOOM_MAX);
  assert.equal(clampZoom(NaN), 1);
});

test('zoomAt — 누른 지점이 화면에서 그대로 있도록 이동값을 바꾼다', () => {
  // 중심 기준 좌표 p=(100,0)에서 1→2배: 그 지점은 이미지 좌표 100 → 화면 200이 되므로 -100만큼 옮겨야 제자리
  assert.deepEqual(zoomAt({ z: 1, x: 0, y: 0 }, 2, { x: 100, y: 0 }), { z: 2, x: -100, y: 0 });
  assert.deepEqual(zoomAt({ z: 2, x: -100, y: 0 }, 1, { x: 100, y: 0 }), { z: 1, x: 0, y: 0 }, '되돌리면 원래대로');
  assert.deepEqual(zoomAt({ z: 1, x: 0, y: 0 }, 10, { x: 0, y: 0 }).z, ZOOM_MAX);
});

test('clampPan — 확대한 그림이 화면 밖으로 빠지지 않게, 1배면 0', () => {
  const box = { w: 300, h: 200 }, view = { w: 400, h: 800 };
  assert.deepEqual(clampPan({ z: 1, x: 50, y: -40 }, box, view), { z: 1, x: 0, y: 0 });
  // 2배: 600×400 — 가로 여유 (600-400)/2=100, 세로는 화면보다 작아 0
  assert.deepEqual(clampPan({ z: 2, x: 500, y: 90 }, box, view), { z: 2, x: 100, y: 0 });
  assert.deepEqual(clampPan({ z: 2, x: -500, y: 0 }, box, view), { z: 2, x: -100, y: 0 });
});

test('swipeDecision — 화면 폭 18% 넘게 끌거나 빠르게 튕기면 넘긴다, 확대 중·끝 장은 넘기지 않는다', () => {
  assert.equal(swipeDecision({ dx: -100, vx: 0, width: 390, zoom: 1, index: 0, count: 3 }), 1);
  assert.equal(swipeDecision({ dx: 100, vx: 0, width: 390, zoom: 1, index: 1, count: 3 }), -1);
  assert.equal(swipeDecision({ dx: -30, vx: -0.8, width: 390, zoom: 1, index: 0, count: 3 }), 1, '빠른 튕김');
  assert.equal(swipeDecision({ dx: -30, vx: -0.1, width: 390, zoom: 1, index: 0, count: 3 }), 0);
  assert.equal(swipeDecision({ dx: 100, vx: 0, width: 390, zoom: 1, index: 0, count: 3 }), 0, '첫 장에서 이전 없음');
  assert.equal(swipeDecision({ dx: -100, vx: 0, width: 390, zoom: 1, index: 2, count: 3 }), 0, '마지막 장에서 다음 없음');
  assert.equal(swipeDecision({ dx: -200, vx: -2, width: 390, zoom: 2, index: 0, count: 3 }), 0, '확대 중엔 이동만');
});

test('dismissDecision — 1배에서 아래로 충분히 끌거나 빠르게 내리면 닫는다', () => {
  assert.equal(dismissDecision({ dy: 140, vy: 0, zoom: 1 }), true);
  assert.equal(dismissDecision({ dy: 40, vy: 1.0, zoom: 1 }), true);
  assert.equal(dismissDecision({ dy: 40, vy: 0.1, zoom: 1 }), false);
  assert.equal(dismissDecision({ dy: 300, vy: 2, zoom: 2 }), false);
  assert.equal(dismissDecision({ dy: -300, vy: -2, zoom: 1 }), false, '위로는 닫지 않는다');
});

test('isDoubleTap — 300ms 안·30px 안 두 번', () => {
  assert.equal(isDoubleTap({ t: 1000, x: 10, y: 10 }, { t: 1200, x: 20, y: 18 }), true);
  assert.equal(isDoubleTap({ t: 1000, x: 10, y: 10 }, { t: 1400, x: 10, y: 10 }), false);
  assert.equal(isDoubleTap({ t: 1000, x: 10, y: 10 }, { t: 1100, x: 80, y: 10 }), false);
  assert.equal(isDoubleTap(null, { t: 1, x: 0, y: 0 }), false);
});

test('wheelZoom — 휠을 위로 굴리면 커지고 아래로 굴리면 작아진다(한도 안)', () => {
  assert.ok(wheelZoom(1, -100) > 1);
  assert.equal(wheelZoom(1, 500), 1);
  assert.equal(wheelZoom(ZOOM_MAX, -500), ZOOM_MAX);
});

test('mediaCaps — 환경별로 되는 버튼만', () => {
  // 폰 앱(Tauri iOS·Android): 저장·공유는 기기 플러그인, 복사 버튼 없음
  assert.deepEqual(mediaCaps({ mobileNative: true, nativeShare: true }), { save: true, share: true, copyImage: false, copyLink: false });
  // 플러그인이 없는 옛 빌드라도 웹 공유(파일)가 되면 공유만
  assert.deepEqual(mediaCaps({ mobileNative: true, nativeShare: false, webShareFiles: true }), { save: false, share: true, copyImage: false, copyLink: false });
  // 데스크톱 앱: 다운로드 폴더 저장 + 이미지·링크 복사, 공유 시트 없음
  assert.deepEqual(mediaCaps({ desktopTauri: true, clipboardImage: true, clipboardText: true }), { save: true, share: false, copyImage: true, copyLink: true });
  // 브라우저(데스크톱): 다운로드 + 복사, 웹 공유가 되면 공유도
  assert.deepEqual(mediaCaps({ clipboardImage: true, clipboardText: true }), { save: true, share: false, copyImage: true, copyLink: true });
  assert.deepEqual(mediaCaps({ webShareFiles: true, clipboardText: true, touch: true }), { save: true, share: true, copyImage: false, copyLink: true });
  assert.deepEqual(mediaCaps({}), { save: true, share: false, copyImage: false, copyLink: false });
});

test('fileView — 아이콘·가운데 말줄임 이름(확장자 유지)·종류·크기', () => {
  const v = fileView({ name: '2026년 3분기 아르고 메신저 사용자 인터뷰 정리본 최종.pdf', mime: 'application/pdf', bytes: 1536000 }, 24);
  assert.equal(v.icon, 'fpdf');
  assert.equal(v.kind, 'pdf');
  assert.ok(v.short.endsWith('.pdf') && v.short.includes('…') && Array.from(v.short).length === 24, v.short);
  assert.equal(v.full, '2026년 3분기 아르고 메신저 사용자 인터뷰 정리본 최종.pdf');
  assert.equal(v.ext, 'PDF');
  assert.equal(v.size, '1.5 MB');
  assert.equal(fileView({ name: 'notes.md', mime: '', bytes: 0 }).icon, 'ftext');
  assert.equal(fileView({ name: 'data.xlsx' }).icon, 'fsheet');
  assert.equal(fileView({ name: 'a.docx' }).icon, 'doc');
  assert.equal(fileView({ name: 'blob' }).icon, 'ffile');
  assert.equal(fileView({ name: 'blob' }).ext, '');
  // 화면은 이름을 두 칸으로 — 앞(폭이 모자라면 CSS가 …로 줄임) + 끝(마지막 글자 몇 개와 확장자, 줄지 않음) → 폭에 맞춘 가운데 말줄임
  const long = fileView({ name: '2026년 3분기 아르고 메신저 사용자 인터뷰 정리본 최종 수정판.pdf' });
  assert.equal(long.head + long.tail, long.full);
  assert.equal(long.tail, '종 수정판.pdf');
  assert.deepEqual([fileView({ name: 'a.pdf' }).head, fileView({ name: 'a.pdf' }).tail], ['', 'a.pdf'], '짧은 이름은 끝 칸 하나');
  assert.deepEqual([fileView({ name: 'README' }).head, fileView({ name: 'README' }).tail], ['R', 'EADME']);
});

test('splitAttachments — 그림과 파일을 나누고 순서는 지킨다(mime이 비어도 확장자로)', () => {
  const atts = [{ id: 1, name: 'a.png', mime: 'image/png' }, { id: 2, name: 'r.pdf', mime: '' }, { id: 3, name: 'b.JPG', mime: '' }, { id: 4, name: 'c.heic', mime: 'application/octet-stream' }];
  const { images, files } = splitAttachments(atts);
  assert.deepEqual(images.map((a) => a.id), [1, 3, 4]);
  assert.deepEqual(files.map((a) => a.id), [2]);
  assert.deepEqual(splitAttachments(atts, new Set([3])).files.map((a) => a.id), [2, 3], '그리지 못한 그림은 파일 말풍선으로 물러난다');
});

test('shouldRequestPreview — 링크가 든 내 글만, 한 번', () => {
  assert.equal(shouldRequestPreview({ body: '봐 https://example.com', messageId: 5 }), true);
  assert.equal(shouldRequestPreview({ body: '링크 없음', messageId: 5 }), false);
  assert.equal(shouldRequestPreview({ body: 'https://example.com', messageId: null }), false);
  assert.equal(shouldRequestPreview({ body: '`https://in-code.example`', messageId: 5 }), false);
});

test('previewFor — 저장된 카드는 본문에 그 링크가 남아 있고 모양이 맞을 때만 그린다', () => {
  const card = { v: 1, url: 'https://example.com/a', title: '제목', description: '설명', image: 'https://img.example/a.png', site: '예시' };
  assert.deepEqual(previewFor({ body: '봐 https://example.com/a', meta: { link_preview: card } }), { ...card, host: 'example.com' });
  assert.equal(previewFor({ body: '링크를 지웠다', meta: { link_preview: card } }), null, '본문을 고쳐 링크를 지우면 카드도 숨긴다');
  assert.equal(previewFor({ body: 'https://example.com/a', meta: {} }), null);
  assert.equal(previewFor({ body: 'https://example.com/a', deleted_at: '2026', meta: { link_preview: card } }), null);
  assert.equal(previewFor({ body: 'javascript:alert(1)', meta: { link_preview: { ...card, url: 'javascript:alert(1)' } } }), null);
  assert.equal(previewFor({ body: 'https://example.com/a', meta: { link_preview: { ...card, image: 'http://x/a.png' } } }).image, '', 'http 이미지는 그리지 않는다');
  assert.equal(previewFor({ body: 'https://example.com/a', meta: { link_preview: { url: 'https://example.com/a', title: 7 } } }), null, '모양이 틀리면 그리지 않는다');
});
