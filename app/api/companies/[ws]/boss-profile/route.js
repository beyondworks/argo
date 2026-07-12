import { readBossProfile, writeBossProfile } from '../../../../../src/memory.mjs';
import { guardCompany } from '../../../../auth.mjs';

/** 사장 프로필 — "회사가 아는 사장". 크루 카드의 기억 카드 섹션이 먹는다. */
export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  return Response.json(await readBossProfile(ws));
}

/** 정정("그거 잊어") — 항목 배열을 통째로 받아 정규 md로 재저장. */
export async function PUT(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { items } = await req.json();
    if (!Array.isArray(items)) return Response.json({ error: 'items 배열이 필요합니다' }, { status: 400 });
    return Response.json(await writeBossProfile(ws, items));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
