// 메신저 v2 대화(방) 삭제 — 재공개 전 검수 b(2026-10-23, 총괄 결정 "실제 삭제"). 서버 20261023180000 b절.
// 순서: msgr2_room_delete_files(지울 수 있는지 + 이 방 파일 경로) → Storage API remove(첨부·일 파일 객체) → msgr2_room_delete(행 삭제).
// 파일을 먼저 지우는 이유: 방 행이 없어지면 Storage 지우기 판정(_msgr2_storage_delete)이 그 경로의 방을 찾지 못해 거부한다.
// 파일 지우기가 실패해도 방 삭제는 진행한다(v1 deleteChannel과 같다 — 남은 객체는 방이 없어 아무도 열 수 없다). 남은 수는 돌려준다.
// rpc = (이름, 인자) => Promise<{ data, error }> (rawSupabase.rpc), bucket = rawSupabase.storage.from('msgr'). 순수 — 시험이 가짜로 부른다.

const CHUNK = 100; // Storage remove 한 번에 보내는 경로 수

/** 반환: { ok: true, filesLeft } | { code } (forbidden·work_active·migration 등 서버 거부) | { error } (호출 실패) */
export async function deleteRoomV2(rpc, bucket, room) {
  const f = await rpc('msgr2_room_delete_files', { p_room: room });
  if (f.error) return { error: f.error };
  if (!f.data?.ok) return { code: f.data?.code ?? 'internal' };
  const paths = Array.isArray(f.data.paths) ? f.data.paths : [];
  let filesLeft = 0;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const part = paths.slice(i, i + CHUNK);
    try {
      const r = await bucket.remove(part);
      if (r?.error) filesLeft += part.length;
      else filesLeft += part.length - (Array.isArray(r?.data) ? r.data.length : part.length);
    } catch { filesLeft += part.length; }
  }
  const d = await rpc('msgr2_room_delete', { p_room: room });
  if (d.error) return { error: d.error };
  if (!d.data?.ok) return { code: d.data?.code ?? 'internal' };
  return { ok: true, filesLeft };
}

/** 서버 거부 코드 → 화면 문구 키 */
export const roomDeleteErrKey = (code) => ({ forbidden: 'ch.noEdit', work_active: 'room.delete.workActive', migration: 'room.delete.migration' })[code] ?? 'err.generic';
