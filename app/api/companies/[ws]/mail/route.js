// 쪽지함 — 크루 우편함(src/crewmail.mjs)의 화면용 API. GET 목록 / POST 사장 발신 / DELETE 대기 취소 / PATCH 실패함 조작.
import { listMail, sendCrewMail, cancelMail, requeueDead, deleteDead } from '../../../../../src/crewmail.mjs';
import { loadCompany } from '../../../../../src/workspace.mjs';
import { guardCompany } from '../../../../auth.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    return Response.json(await listMail(ws));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}

/** 사장 발신 — room.mjs의 회의실 cc와 같은 신원(from:'captain', fromRole:'captain'). 이름은 회사 언어에 따른 호칭. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { to, cc = [], message } = await req.json();
    if (!to || !String(message ?? '').trim()) return Response.json({ error: '수신 크루와 내용이 필요합니다' }, { status: 400 });
    const { lang = 'ko' } = await loadCompany(ws).catch(() => ({}));
    const id = await sendCrewMail(ws, {
      from: 'captain', fromName: lang === 'en' ? 'the captain' : '사장', fromRole: 'captain',
      to: String(to), cc: Array.isArray(cc) ? cc.map(String) : [], message: String(message),
    });
    return Response.json({ id });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const url = new URL(req.url);
    const to = url.searchParams.get('to'); const id = url.searchParams.get('id');
    if (!to || !id) return Response.json({ error: 'to·id가 필요합니다' }, { status: 400 });
    return Response.json(await cancelMail(ws, to, id));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { op, file } = await req.json();
    if (op === 'requeue') return Response.json(await requeueDead(ws, file));
    if (op === 'deleteDead') return Response.json(await deleteDead(ws, file));
    return Response.json({ error: 'op는 requeue 또는 deleteDead입니다' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
