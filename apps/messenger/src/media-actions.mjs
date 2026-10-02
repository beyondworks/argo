// 첨부 말풍선·링크 카드의 순수 판정(2026-10-02) — 화면 부품(media.jsx)과 입출력(media-io.js)에서 쓴다. 테스트: test/media-viewer.test.mjs
// 이미지·파일 판정, 이름 말줄임은 본체 게이트웨이와 같은 규칙(src/media-kind.mjs), 링크 규칙은 엣지 함수와 같은 파일을 쓴다.
import { isImage, fileKind, fileExt, middleEllipsis, formatBytes } from '../../../src/media-kind.mjs';
import { firstUrl } from '../../../src/link-preview.mjs';

/**
 * 환경별로 보일 버튼 — 되지 않는 버튼은 숨긴다.
 * env: { mobileNative(Tauri iOS·Android), nativeShare(기기 저장·공유 플러그인), desktopTauri, webShareFiles(navigator.canShare({files})),
 *        clipboardImage(ClipboardItem + clipboard.write), clipboardText, touch(폰 브라우저) }
 */
export function mediaCaps(env = {}) {
  if (env.mobileNative) return { save: !!env.nativeShare, share: !!(env.nativeShare || env.webShareFiles), copyImage: false, copyLink: false };
  if (env.desktopTauri) return { save: true, share: false, copyImage: !!env.clipboardImage, copyLink: !!env.clipboardText };
  return { save: true, share: !!(env.webShareFiles && env.touch), copyImage: !!(env.clipboardImage && !env.touch), copyLink: !!env.clipboardText };
}

const ICON = { pdf: 'fpdf', doc: 'doc', sheet: 'fsheet', slide: 'fslide', archive: 'fzip', video: 'fvideo', audio: 'faudio', text: 'ftext', code: 'fcode', image: 'image', file: 'ffile' };

const TAIL = 5; // 끝 칸에 남길 이름 글자 수(확장자 앞)
/** 파일 말풍선 표시값 — { kind, icon, head·tail(화면: 앞 칸은 폭이 모자라면 …로 줄고 끝 칸은 마지막 글자와 확장자를 지킨다), short(글자 수 기준 가운데 말줄임), full, ext(대문자), size } */
export function fileView(att, max = 28) {
  const name = String(att?.name ?? '');
  const kind = fileKind(name, att?.mime);
  const ext = fileExt(name);
  const chars = Array.from(name);
  const stemLen = ext ? chars.length - ext.length - 1 : chars.length;
  const cut = Math.max(0, stemLen - TAIL);
  return { kind, icon: ICON[kind] ?? 'ffile', head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join(''), short: middleEllipsis(name, max), full: name, ext: ext.toUpperCase(), size: att?.bytes ? formatBytes(att.bytes) : '' };
}

/** 그림(묶음 격자)과 파일(말풍선)로 나눈다 — 순서 유지. failed: 그리지 못한 그림 id(파일 말풍선으로 물러난다). */
export function splitAttachments(atts, failed = new Set()) {
  const images = []; const files = [];
  for (const a of atts ?? []) (isImage(a) && !failed.has(a.id) ? images : files).push(a);
  return { images, files };
}

/** 보낸 글에 미리보기를 한 번 요청할지 — 글 번호가 있고 본문(코드 밖)에 http(s) 링크가 있을 때만. */
export const shouldRequestPreview = ({ body, messageId }) => !!messageId && !!firstUrl(body);

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : null);
/** 저장된 카드(meta.link_preview)를 그릴 모양으로 — 본문에 그 링크가 남아 있고 모양이 맞을 때만. 글자는 화면에서 글자로만 그린다. */
export function previewFor(m) {
  const p = m?.meta?.link_preview;
  if (!p || typeof p !== 'object' || m.deleted_at) return null;
  const f = { url: str(p.url), title: str(p.title), description: str(p.description), image: str(p.image), site: str(p.site) };
  if (Object.values(f).some((v) => v === null)) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(f.url) || !String(m.body ?? '').includes(f.url) || (!f.title && !f.description)) return null;
  let host = '';
  try { host = new URL(f.url).hostname.replace(/^www\./, ''); } catch { return null; }
  return { v: 1, ...f, image: /^https:\/\/[^\s]+$/i.test(f.image) ? f.image : '', host };
}
