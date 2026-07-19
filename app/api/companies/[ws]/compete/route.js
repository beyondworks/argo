import { listCompetitions, startCompetition } from '../../../../../src/compete.mjs';
import { guardCompany } from '../../../../auth.mjs';

export const maxDuration = 60; // 개설은 즉시 반환 — 시안 실행은 백그라운드

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  return Response.json({ competitions: await listCompetitions(ws) });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    // 신형 { entrants: [{slug, runner, model}] } — 크루 1명 + 모델 2~3개. 레거시 { slugs } 겸용.
    const { prompt, slugs, entrants } = await req.json();
    return Response.json(await startCompetition(ws, prompt, entrants ?? slugs));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
