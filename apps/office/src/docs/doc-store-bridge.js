// 문서함(트랙 B, src/core/doc-store.js)으로 보내는 다리 — 그 파일이 있을 때만 부른다(import.meta.glob은 파일이 없으면 빈 목록이라 빌드가 깨지지 않는다).
// 견적서·계약서는 만들 때, 서명본은 완료를 처음 본 화면이 한 번 넣는다(markFiled). 문서함이 없으면 조용히 건너뛴다(자체 보관은 그대로).
const mods = import.meta.glob('../core/doc-store.js');
const load = mods['../core/doc-store.js'];

export const hasDocStore = () => !!load;

/** saveDocument(space, { file, filename, title, category, customerId, customerName, dealId, tags, summary, source }) — 트랙 B 계약 */
export async function fileToDocStore(space, entry) {
  if (!load) return null;
  try { return await (await load()).saveDocument(space, entry); } catch (e) { console.warn('[office docs] document store save failed', e?.message); return null; }
}

/** 문서함 미리보기로 이동(있을 때만) */
export async function openInDocStore(space, id) { if (load) (await load()).openDocument?.(space, id); }
