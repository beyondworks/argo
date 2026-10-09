import { readTrace, pickLiveTrace, TRACE_ID_RE } from '../../../../../src/turn-trace.mjs';
import { guardCompany } from '../../../../auth.mjs';

/** 작업 과정 한 턴 전체 — 화면이 접힌 '작업 과정'을 펼치거나 진행 중 단계의 '더 보기'를 누를 때만 부른다(폴링에는 싣지 않는다).
    끝난 턴은 이 기기 파일(.turn-traces — 동기화 안 함), 진행 중이면 메모리 기록. 값은 저장 때 이미 가려져 있다(maskSecrets). */
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  const id = url.searchParams.get('id');
  if (!slug || !id || !TRACE_ID_RE.test(id)) return Response.json({ error: 'slug와 id가 필요합니다' }, { status: 400 });
  const live = pickLiveTrace(ws, slug, { want: id });
  if (live?.id === id) return Response.json({ trace: live.data(), live: true });
  const trace = await readTrace(ws, slug, id).catch(() => null);
  if (!trace) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ trace, live: false });
}
