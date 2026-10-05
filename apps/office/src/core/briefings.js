// 브리핑(유건 10/5) — 받는 사람의 내 공간에 모인다. 서버 office_briefing_list / _get / _write 함수로만.
// 부하: 화면·홈 모듈을 열 때 1회 읽기(30건씩, '더 보기'를 누를 때만 다음 30건), 지우기를 누를 때만 쓰기. 폴링 없음.
// 예시 모드(서버 설정 없음)는 data/briefings-sample.js의 예시 글을 화면 메모리에서.
import { configured } from './supabase.js';
import { rpc } from './tasks.js';

let sample = null; // 예시 모드에서 처음 읽을 때 data/briefings-sample.js에서 받는다
const samples = async () => (sample ??= (await import('../data/briefings-sample.js')).SAMPLE_BRIEFINGS.map((b) => ({ ...b })));
const excerpt = (b) => b.body.replace(/\s+/g, ' ').slice(0, 160);

/** 최신순 목록. cursor = 마지막으로 받은 글(이 글 다음부터), q = 제목·본문 찾기, body = 본문까지(홈 모듈 1건) */
export async function listBriefings({ cursor = null, q = '', limit = 30, body = false } = {}) {
  if (!configured) {
    const hits = (await samples()).filter((b) => !q || `${b.title} ${b.body}`.toLowerCase().includes(q.toLowerCase()));
    const from = cursor ? hits.findIndex((b) => b.id === cursor.id) + 1 : 0;
    return hits.slice(from, from + limit).map((b) => ({ ...b, excerpt: excerpt(b), body: body ? b.body : undefined }));
  }
  return rpc('office_briefing_list', { p_before_at: cursor?.created_at ?? null, p_before_id: cursor?.id ?? null, p_q: q || null, p_limit: limit, p_body: body });
}

export async function getBriefing(id) {
  if (!configured) { const b = (await samples()).find((x) => x.id === id); if (!b) throw Object.assign(new Error('briefing_missing'), { code: 'P0001' }); return b; }
  return rpc('office_briefing_get', { p_id: id });
}

export async function deleteBriefing(id) {
  if (!configured) { sample = (await samples()).filter((b) => b.id !== id); return; }
  await rpc('office_briefing_write', { p_org: null, p_action: 'briefing.delete', p_data: { id } });
}
