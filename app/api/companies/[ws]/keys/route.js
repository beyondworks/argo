// 러너 연결(BYOK/BYOA) — 4러너(Claude·Codex·Gemini·GLM) × (API키·OAuth) 회사별 자격 관리.
// 일반 사용자가 호스트 CLI 로그인 없이도 어떤 러너든 자기 계정으로 연결하게 하는 관문.
// 응답에는 평문 대신 마스킹만 실린다(보안 규칙).
import { runnerStatus, saveRunnerCred, clearRunnerCred, maskCred, verifyRunnerCred, RUNNER_AUTH } from '../../../../../src/runners.mjs';
import { guardCompany } from '../../../../auth.mjs';

/** 상태 — 러너별 회사 연결 + 호스트 로그인 여부 + 지원 인증 방식. */
export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  return Response.json({ runners: await runnerStatus(ws) });
}

/** 저장 — { runner, type:'apikey'|'oauth', value, verify? }.
    verify=true면 저비용 인증 확인 후 저장(거부면 저장 안 함). 네트워크 불가는 형식 검증만으로 통과. */
export async function PUT(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { runner, type = 'apikey', value, verify } = await req.json();
    const meta = RUNNER_AUTH[runner];
    if (!meta) throw new Error('알 수 없는 러너');
    if (!meta.methods.includes(type)) throw new Error(`${runner}는 ${type} 방식을 지원하지 않습니다`);
    const v = String(value ?? '').trim();
    if (!v) throw new Error('키 또는 토큰을 붙여넣어 주세요');
    if (type === 'apikey' && meta.apikeyPrefix && !v.startsWith(meta.apikeyPrefix)) {
      throw new Error(`${meta.apikeyPrefix} 로 시작하는 키를 붙여넣어 주세요`);
    }
    if (verify) {
      const r = await verifyRunnerCred(runner, type, v);
      if (r.ok === false) throw new Error('키가 거부되었습니다 (인증 실패). 콘솔에서 키를 확인하세요');
      // r.ok === null(네트워크 불가·oauth 토큰)은 형식 검증만으로 저장 — 오프라인에서도 온보딩이 막히지 않게
    }
    await saveRunnerCred(ws, runner, type, v);
    return Response.json({ ok: true, runner, connected: true, type, masked: maskCred(v) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 제거 — { runner } (쿼리 또는 바디). */
export async function DELETE(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const runner = new URL(req.url).searchParams.get('runner') || (await req.json().catch(() => ({}))).runner;
    if (!RUNNER_AUTH[runner]) throw new Error('알 수 없는 러너');
    await clearRunnerCred(ws, runner);
    return Response.json({ ok: true, runner, connected: false });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
