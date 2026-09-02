// 러너 연결(BYOK/BYOA) — 4러너(Claude·Codex·Gemini·GLM) × (API키·OAuth) 회사별 자격 관리.
// 일반 사용자가 호스트 CLI 로그인 없이도 어떤 러너든 자기 계정으로 연결하게 하는 관문.
// 응답에는 평문 대신 마스킹만 실린다(보안 규칙).
import { runnerStatus, saveRunnerCred, clearRunnerCred, maskCred, verifyRunnerCred, oauthFormatError, detectRunners, RUNNER_AUTH, hostOptInAllowed, normalizePastedCred, probeGeminiHostOAuth , isHiddenRunner} from '../../../../../src/runners.mjs';
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
    if (isHiddenRunner(runner)) throw new Error('더 이상 제공되지 않는 러너입니다'); // 숨김(gemini) — UI 경로는 없지만 직접 호출도 막는다(해제 DELETE는 허용)
    // host — "이 컴퓨터 로그인 사용" 명시 옵트인(codex/gemini). 서버가 실제 로그인 상태를 검증하고
    // 마커만 저장한다(자격 값 없음). 자동 스캐빈징 금지 원칙에서 이 버튼이 유일한 호스트 사용 관문.
    if (type === 'host') {
      if (!hostOptInAllowed(runner)) throw new Error('이 환경에서는 이 컴퓨터 로그인 사용을 쓸 수 없습니다'); // claude는 데스크톱 번들에서 제외(키체인)
      const host = (await detectRunners(true))[runner]; // 캐시 우회 — 방금 로그인한 CLI를 예열 캐시가 60초 오거절하지 않게(감사 2026-07-20)
      if (!host?.installed) throw new Error('이 컴퓨터에서 해당 CLI가 감지되지 않습니다 — 먼저 설치해 주세요');
      if (!host?.authed) throw new Error('이 컴퓨터의 CLI가 로그인돼 있지 않습니다 — 터미널에서 로그인 후 다시 시도해 주세요');
      // gemini는 로그인이 살아 있어도 구글이 개인 OAuth를 신형 CLI에서 거절할 수 있다 — 실사용 프로브로
      // 확정 부적격이면 '연결됨'을 만들지 않는다(웹 브리지 관문과 대칭, 실사용 신고 2026-07-20)
      if (runner === 'gemini') {
        const hp = await probeGeminiHostOAuth();
        if (hp.ok === false && hp.reason === 'gemini-license') {
          // 라이선스 차단은 개인 OAuth 폐기와 다른 사유 — 같은 메시지를 쓰면 오안내(검수 #1 host 축)
          throw new Error('이 컴퓨터의 구글 계정은 Gemini Code Assist를 쓸 수 없어(라이선스 없음·개인 무료 경로 부적격) 구독 방식 턴이 모두 실패합니다 — API 키로 연결해 주세요(Google AI Studio에서 무료 발급)');
        }
        if (hp.ok === false) {
          throw new Error('이 컴퓨터의 Gemini 로그인(개인 OAuth)은 구글이 최신 CLI에서 지원을 중단해 사용할 수 없습니다 — API 키로 연결해 주세요(Google AI Studio에서 무료 발급)');
        }
      }
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
        // 라이선스 차단(gemini 구독 — 워크스페이스 등 Code Assist 미보유 계정)은 자격 무효와 다르다:
        // "재발급하라"는 오안내(로그인 자체는 정상 — grokCreditNotice 선례). 대안 경로를 짚어 준다.
        if (r.reason === 'gemini-license') {
          throw new Error(lang === 'en'
            ? 'This Google account has no Gemini Code Assist license, so Google blocks subscription-based turns (verified at connect time). Use a Gemini API key instead, or sign in with an account that has the license.'
            : '이 구글 계정에는 Gemini Code Assist 라이선스가 없어 구독 방식 사용을 구글이 차단합니다(연결 시점 실검증). Gemini API 키 방식으로 연결하거나, 라이선스가 있는 계정으로 로그인해 주세요.');
        }
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
