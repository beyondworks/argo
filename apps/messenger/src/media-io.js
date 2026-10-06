// 첨부 입출력(2026-10-02) — 서명 URL, 진행률 있는 내려받기, 환경별 저장·공유·복사. 판정(어떤 버튼을 보일지)은 media-actions.mjs mediaCaps.
// 환경별 저장 방법(근거는 PR 본문·보고):
//   폰 앱(Tauri iOS·Android) → 기기 플러그인 media-share(src-tauri/plugins/media-share): 사진은 사진 앱/갤러리, 파일은 iOS '파일에 저장'·Android 다운로드 폴더,
//     공유는 시스템 공유 시트, 파일 열기는 Android 앱 선택·iOS 공유 시트. 서명 URL을 기기 쪽이 직접 받는다(25MB를 IPC로 넘기지 않는다).
//   데스크톱 앱(Tauri macOS·Windows) → 바이트를 받아 Rust 명령 save_download가 다운로드 폴더에 쓴다(웹뷰의 <a download>는 처리기가 없어 아무 일도 없다 — wry).
//   브라우저 → <a download>.
import { supabase } from './supabase.js';
import { inTauri, isMobileNative, isDesktopTauri } from './platform.js';
import { mediaCaps } from './media-actions.mjs';

const SIGN_TTL = 3600; // 말풍선 썸네일·크게 보기·링크 복사 — 1시간
const cache = new Map(); // `${path}|${download}` → { url, exp }
/** 서명 URL — 5분 넘게 남았으면 다시 만들지 않는다(같은 화면을 다시 그려도 Storage 호출 0). fresh면 새로(만료로 실패한 뒤). */
export async function signedUrl(path, { ttl = SIGN_TTL, download = null, fresh = false } = {}) {
  const key = `${path}|${download ?? ''}`;
  const hit = cache.get(key);
  if (!fresh && hit && hit.exp - Date.now() > 5 * 60_000) return hit.url;
  const { data, error } = await supabase.storage.from('msgr').createSignedUrl(path, ttl, download ? { download } : undefined);
  if (error || !data?.signedUrl) throw new Error(error?.message || 'sign_failed');
  if (cache.size > 500) cache.delete(cache.keys().next().value); // 오래 켜 둔 앱의 상한
  cache.set(key, { url: data.signedUrl, exp: Date.now() + ttl * 1000 });
  return data.signedUrl;
}
export function forgetSigned(path) { for (const k of [...cache.keys()]) if (k.startsWith(`${path}|`)) cache.delete(k); }

/** 진행률(0~1, 크기를 모르면 null) 있는 내려받기. 만료된 주소(400·403)면 한 번 새로 받아 다시 시도한다. */
export async function fetchAttachment(att, { onProgress, signal } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = await signedUrl(att.storage_path, { fresh: attempt > 0 });
    const r = await fetch(url, { signal });
    if ((r.status === 400 || r.status === 403) && attempt === 0) { forgetSigned(att.storage_path); continue; }
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    const total = Number(r.headers.get('content-length')) || att.bytes || 0;
    const type = att.mime || r.headers.get('content-type') || 'application/octet-stream';
    if (!r.body?.getReader) return new Blob([await r.arrayBuffer()], { type });
    const reader = r.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress?.(total ? Math.min(1, got / total) : null);
    }
    return new Blob(chunks, { type });
  }
  throw new Error('sign_expired');
}

function canShareFiles() {
  try { return typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [new File(['x'], 'a.png', { type: 'image/png' })] }); } catch { return false; }
}
/** 지금 환경 — mediaCaps 입력. 폰 앱은 같은 빌드에 기기 플러그인이 들어 있다(nativeShare). */
export function currentEnv() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  return {
    mobileNative: isMobileNative, nativeShare: isMobileNative, desktopTauri: isDesktopTauri(), webShareFiles: canShareFiles(),
    clipboardImage: typeof ClipboardItem !== 'undefined' && !!nav.clipboard?.write, clipboardText: !!nav.clipboard?.writeText,
    touch: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
  };
}
export const currentCaps = () => mediaCaps(currentEnv());

const native = async (cmd, args) => (await import('@tauri-apps/api/core')).invoke(`plugin:media-share|${cmd}`, args);
const nativeArgs = async (att) => ({ url: await signedUrl(att.storage_path, { ttl: 600, fresh: true }), name: att.name || 'file', mime: att.mime || '' });

/** 저장 → { where: 'photos'|'files'|'downloads'|'browser', path? } */
export async function saveAttachment(att, { onProgress } = {}) {
  if (isMobileNative) return native('save', await nativeArgs(att));
  const blob = await fetchAttachment(att, { onProgress });
  if (isDesktopTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const path = await invoke('save_download', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-file-name': encodeURIComponent(att.name || 'file') } });
    return { where: 'downloads', path };
  }
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = att.name || 'file'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return { where: 'browser' };
}

/** 공유 시트 — 폰 앱은 기기 플러그인, 그 밖에는 웹 공유(파일). 사용자가 닫으면 { cancelled: true }. */
export async function shareAttachment(att, { onProgress } = {}) {
  if (isMobileNative) return native('share', await nativeArgs(att));
  const blob = await fetchAttachment(att, { onProgress });
  try { await navigator.share({ files: [new File([blob], att.name || 'file', { type: blob.type })] }); return {}; }
  catch (e) { if (e?.name === 'AbortError') return { cancelled: true }; throw e; }
}

/** 파일 말풍선을 눌렀을 때 — 폰 앱은 열기(Android 앱 선택·iOS 공유 시트), 데스크톱·브라우저는 저장. */
export async function openAttachment(att, opts) {
  if (isMobileNative) return native('open', await nativeArgs(att));
  return saveAttachment(att, opts);
}

async function asPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('png'))), 'image/png'));
}
/** 이미지 복사(데스크톱) — Safari·WebKit은 누른 순간 안에서만 클립보드를 허용해 Promise를 담은 ClipboardItem으로 바로 쓴다. */
export async function copyImage(att) {
  const png = fetchAttachment(att).then(asPng);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
/** 링크 복사 — 1시간 서명 URL(받는 사람이 로그인 없이 연다 — 화면에 유효 시간을 적는다). */
export async function copyLink(att) {
  const url = signedUrl(att.storage_path, { ttl: SIGN_TTL, fresh: true });
  try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': url.then((u) => new Blob([u], { type: 'text/plain' })) })]); }
  catch { await navigator.clipboard.writeText(await url); }
}

/** 외부 브라우저로 — Tauri 웹뷰는 window.open을 막는다(D54). 앱 오프너 허용 목록은 https·mailto뿐(http는 열리지 않는다 — 화면이 링크로 그리지 않는다) */
export async function openExternalUrl(url) {
  if (!/^https?:\/\//i.test(String(url))) return;
  try { if (inTauri()) await (await import('@tauri-apps/plugin-opener')).openUrl(url); else window.open(url, '_blank', 'noopener'); } catch { /* 막히면 조용히 */ }
}
/** 데스크톱 앱 — 저장한 파일을 폴더에서 보기 */
export async function revealSaved(path) {
  try { await (await import('@tauri-apps/plugin-opener')).revealItemInDir(path); } catch { /* 권한·플랫폼 밖 */ }
}
