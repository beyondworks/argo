import { loadRoutines, addRoutine, updateRoutine, removeRoutine } from '../../../../../src/routines.mjs';
import { guardCompany } from '../../../../auth.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    return Response.json({ routines: await loadRoutines(ws) });
  } catch (e) {
    // 손상(readJson throw) — 조용히 빈 목록으로 붕괴시키지 않는다(디스크엔 루틴이 존재).
    return Response.json({ error: String(e.message || e), code: 'ROUTINES_CORRUPT' }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const routine = await addRoutine(ws, await req.json());
    return Response.json({ routine });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export async function PUT(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id, ...patch } = await req.json();
    const routine = await updateRoutine(ws, id, patch);
    return Response.json({ routine });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
  await removeRoutine(ws, id);
  return Response.json({ ok: true });
}
