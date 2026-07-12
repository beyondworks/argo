import { readAgentCard, saveAgentCard, removeAgentCard, updateAgentMeta } from '../../../../../../src/persona.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 카드 열람 — 카드가 곧 시스템 프롬프트(투명성) + 최근 업무·적용 스킬(크루 프로필). */
export async function GET(_req, { params }) {
  try {
    const { ws, slug } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { md, meta } = await readAgentCard(ws, slug);
    const [{ readEvents }, { listInstalledSkills }, { agentStats }] = await Promise.all([
      import('../../../../../../src/events.mjs'),
      import('../../../../../../src/market.mjs'),
      import('../../../../../../src/usage.mjs'),
    ]);
    const events = await readEvents(ws, 300).catch(() => []);
    const recent = events
      .filter((e) => e.slug === slug && e.type === 'turn' && e.gist)
      .slice(-8).reverse()
      .map((e) => ({ gist: e.gist, ts: e.ts, ok: e.ok !== false, ms: e.ms ?? null }));
    const skills = await listInstalledSkills(ws).catch(() => []);
    const stats = await agentStats(ws, slug).catch(() => null);
    return Response.json({ md, meta, recent, skills, stats });
  } catch {
    return Response.json({ error: '크루를 찾을 수 없습니다' }, { status: 404 });
  }
}

export async function PUT(req, { params }) {
  try {
    const { ws, slug } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { md } = await req.json();
    if (!md?.trim()) return Response.json({ error: '카드 내용이 필요합니다' }, { status: 400 });
    const agent = await saveAgentCard(ws, slug, md);
    return Response.json({ agent });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 신원 수정 — 이름·역할·팀·모델만 갱신(카드 본문·슬러그·기록 보존). */
export async function PATCH(req, { params }) {
  try {
    const { ws, slug } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { name, role, team, model, runner } = await req.json();
    const meta = await updateAgentMeta(ws, slug, { name, role, team, model, runner });
    return Response.json({ meta });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 해고 — .archive/로 이동(복구 가능). */
export async function DELETE(_req, { params }) {
  try {
    const { ws, slug } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    await removeAgentCard(ws, slug);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
