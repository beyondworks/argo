import { webOrigin, webAddress, externalAddress } from './desktop-urls.js';

const env = import.meta.env ?? {};
export const isDesktop = () => !!globalThis.window?.__TAURI_INTERNALS__;
const origin = () => isDesktop()
  ? webOrigin(env.VITE_OFFICE_WEB_ORIGIN, { allowLocal: env.DEV || env.VITE_OFFICE_REVIEW === '1' })
  : location.origin;
export const publicWebUrl = (path) => webAddress(origin(), path);
export const apiUrl = (path) => isDesktop() ? publicWebUrl(path) : path;

export async function openExternal(value) {
  const url = externalAddress(value);
  if (isDesktop()) return (await import('@tauri-apps/plugin-opener')).openUrl(url);
  return window.open(url, '_blank', 'noopener,noreferrer');
}

/** The OS save dialog owns the destination. No reusable filesystem permission is granted. */
export async function saveAttachment(blob, name) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('save_attachment', { name, bytes: [...new Uint8Array(await blob.arrayBuffer())] });
}
