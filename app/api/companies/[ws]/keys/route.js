// 러너 연결(BYOK/BYOA) — 4러너(Claude·Codex·Gemini·GLM) × (API키·OAuth) 회사별 자격 관리.
// 일반 사용자가 호스트 CLI 로그인 없이도 어떤 러너든 자기 계정으로 연결하게 하는 관문.
// 응답에는 평문 대신 마스킹만 실린다(보안 규칙).
import { runnerStatus, saveRunnerCred, clearRunnerCred, maskCred, verifyRunnerCred, oauthFormatError, detectRunners, RUNNER_AUTH, hostOptInAllowed, normalizePastedCred } from '../../../../../src/runners.mjs';
import { loadCompany } from '../../../../../src/workspace.mjs';
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
    // host — "이 컴퓨터 로그인 사용" 명시 옵트인(codex/gemini). 서버가 실제 로그인 상태를 검증하고
    // 마커만 저장한다(자격 값 없음). 자동 스캐빈징 금지 원칙에서 이 버튼이 유일한 호스트 사용 관문.
    if (type === 'host') {
      if (!hostOptInAllowed(runner)) throw new Error('이 환경에서는 이 컴퓨터 로그인 사용을 쓸 수 없습니다'); // claude는 데스크톱 번들에서 제외(키체인)
      const host = (await detectRunners(true))[runner]; // 캐시 우회 — 방금 로그인한 CLI를 예열 캐시가 60초 오거절하지 않게(감사 2026-07-20)
      if (!host?.installed) throw new Error('이 컴퓨터에서 해당 CLI가 감지되지 않습니다 — 먼저 설치해 주세요');
      if (!host?.authed) throw new Error('이 컴퓨터의 CLI가 로그인돼 있지 않습니다 — 터미널에서 로그인 후 다시 시도해 주세요');
      await saveRunnerCred(ws, runner, 'host', 'host');
      return Response.json({ ok: true, runner, connected: true, type: 'host', masked: '' });
    }
    if (!meta.methods.includes(type)) throw new Error(`${runner}는 ${type} 방식을 지원하지 않습니다`);
    // 정규화 — 터미널 줄바꿈이 섞인 복사본을 자기치유(내부 공백 제거). 실사용 2026-07-20 신고의 근본.
    const v = normalizePastedCred(value);
    if (!v) throw new Error('키 또는 토큰을 붙여넣어 주세요');
    const { lang = 'ko' } = await loadCompany(ws).catch(() => ({}));
    if (type === 'apikey' && meta.apikeyPrefix && !v.startsWith(meta.apikeyPrefix)) {
      throw new Error(`${meta.apikeyPrefix} 로 시작하는 키를 붙여넣어 주세요`);
    }
    if (type === 'oauth') {
      // 형식이 다른 값(setup-token 중간 인증 코드 등)이 저장을 통과하면 모든 턴이 401로만 드러난다
      // (실측 2026-07-18) — apikey 접두사 검사와 대칭으로 저장 시점에 잡는다. 안내는 회사 언어로.
      const fmtErr = oauthFormatError(runner, v, lang);
      if (fmtErr) throw new Error(fmtErr);
    }
    // 실검증은 항상 — '저장만'(verify=false)이 무효 자격을 '연결됨'으로 저장해 전 턴이 API 오류로만
    // 드러나던 함정 제거(실사용 2026-07-20). 네트워크 불가(ok:null)만 형식 검증으로 저장(오프라인 온보딩).
    // verify 파라미터는 하위호환으로 수용만 한다(무시).
    {
      const r = await verifyRunnerCred(runner, type, v);
      if (r.ok === false) {
        throw new Error(lang === 'en'
          ? 'This credential failed authentication — it may be expired, revoked, or mis-issued. Please issue a new one and paste it again.'
          : '이 자격이 인증에 실패했습니다 — 만료·철회됐거나 잘못 발급된 값입니다. 새로 발급해 다시 붙여넣어 주세요.');
      }
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
