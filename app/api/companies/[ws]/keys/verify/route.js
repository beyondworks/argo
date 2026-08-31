// 저장된 러너 자격의 온디맨드 재검증(P1-2 [연결 확인]) — verifyRunnerCred는 지금까지 저장 시점
// 1회만 돌아, 이후 만료·철회·차단은 턴 실패로만 드러났다(계획서 runner-resilience P1).
// 평문 자격은 응답에 싣지 않는다 — ok/reason만.
import { guardCompany } from '../../../../../auth.mjs';
import { loadRunnerCred, verifyRunnerCred, RUNNER_AUTH } from '../../../../../../src/runners.mjs';

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { runner } = await req.json().catch(() => ({}));
    if (!RUNNER_AUTH[runner]) throw new Error('알 수 없는 러너');
    const cred = await loadRunnerCred(ws, runner);
    if (!cred) return Response.json({ ok: null, reason: 'not-connected' });
    // host 마커는 회사 저장 자격이 아니다 — 원격 판정 불가(관용). CLI 감지는 기존 status가 담당.
    if (cred.type === 'host') return Response.json({ ok: null, reason: 'host' });
    const r = await verifyRunnerCred(runner, cred.type, cred.value);
    return Response.json({ ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
