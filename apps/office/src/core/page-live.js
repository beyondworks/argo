// 열어 둔 페이지 최신화(16차, PARITY-tasks D12·D15) — 새 주기 폴링은 만들지 않는다.
//   · 탭(창)으로 돌아올 때: 판 번호(version)만 한 줄 읽어 비교하고, 바뀌었으면 본문을 다시 읽는다(pages/PageView.jsx).
//   · 같은 브라우저의 다른 창: 저장이 서버에 닿으면 그 창이 제목·본문·판 번호를 BroadcastChannel로 바로 보낸다(서버 읽기 0, transport.js).
//   · 어느 쪽이든 이 창에 안 저장한 편집이 있으면 건너뛴다 — 그 저장이 서버에서 판이 어긋나 기존 충돌 안내(새로 불러오기·사본)로 이어진다.
// 부하: 사람 1명 × 탭 복귀(같은 페이지 10초에 한 번까지) = 행 하나 읽기, 쓰기 0. 창끼리 맞추기는 서버 호출 0.
// 첫 화면 밖(transport.js·PageView·Editor가 불러온다).
import { getClient } from './supabase.js';
import { getState, update } from './store.js';
import { outbox } from './sync.js';
import { getUi } from './ui-state.js';
import { getStorageScope } from './save.js';
import { peerPatch } from './page-fresh.js';

export { shouldReload } from './page-fresh.js';

const editors = new Map(); // 열어 둔 편집기: 페이지 id → { dirty(): 아직 저장 대기 중인 입력이 있나, rename(title): 이름 바꾸기 }
export function registerEditor(id, api) { editors.set(id, api); return () => { if (editors.get(id) === api) editors.delete(id); }; }
export const openEditor = (id) => editors.get(id) ?? null;

/** 이 창에 이 페이지의 안 저장한 편집이 있는가 — 보낼 목록에 남은 저장, 편집기의 입력 대기(0.8초), 고르지 않은 충돌 */
export const pageBusy = (id) => outbox.has(`page:${id}`) || !!editors.get(id)?.dirty() || getUi().conflict === id;

/** 서버의 판 번호만 읽는다(본문 없이 행 하나) — 못 읽으면 null */
export async function serverVersion(id) {
  const sb = await getClient();
  if (!sb) return null;
  const { data, error } = await sb.from('office_pages').select('version').eq('id', id).maybeSingle();
  return error || !data ? null : data.version;
}

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('argo-office-pages') : null;
/** 저장이 닿은 페이지를 같은 브라우저의 다른 창에 알린다 */
export function announce(row, { sample = false } = {}) {
  if (!channel || !row?.id || row.content === undefined) return;
  try { channel.postMessage({ owner: getStorageScope(), id: row.id, title: row.title ?? '', content: row.content, version: row.version, updated: row.updated, sample }); } catch { /* 보낼 수 없는 값 — 이 창만 */ }
}
if (channel) channel.onmessage = (e) => {
  const msg = e.data, page = getState().pages.find((p) => p.id === msg?.id);
  const patch = peerPatch(msg, page, { scope: getStorageScope(), busy: !!page && pageBusy(page.id) });
  if (patch) update((s) => ({ pages: s.pages.map((p) => (p.id === msg.id ? { ...p, ...patch } : p)) }));
};
