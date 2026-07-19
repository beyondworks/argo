// 계정 스코프 러너 연결(온보딩) — 회사 생성 전 "로그인 → 러너 연결 → 회사 만들기" 순서를 위한 관문.
// 회사 keys 라우트(companies/[ws]/keys)와 같은 계약이되, 가드가 로그인만 요구하고(회사 불요)
// 저장 대상이 그 사용자의 계정 스코프(WS_ROOT/.account-secrets-{uid}.json)다. 회사 생성 시 seedRunnerCreds가 복사한다.
// 응답에는 평문 대신 마스킹만 실린다(보안 규칙).
import {
  accountScope, runnerStatus, saveRunnerCred, clearRunnerCred,
  maskCred, verifyRunnerCred, oauthFormatError, detectRunners, RUNNER_AUTH, hostOptInAllowed,
} from '../../../../src/runners.mjs';
import { currentUser, tenantDenied } from '../../../auth.mjs';

/** 로그인 가드 — 회사 소유권 검사 없이 인증만(companies POST와 동일 패턴).
    통과 시 { scope }(그 사용자의 계정 스코프 — 사용자별 파일 격리), 위반 시 { denied: Response }. */
async function guardAccount() {
  const user = await currentUser();
  if (!user) return { denied: Response.json({ error: '로그인이 필요합니다' }, { status: 401 }) };
  const td = tenantDenied(user); if (td) return { denied: td };
  return { scope: accountScope(user.id) };
}

/** 상태 — 러너별 계정 연결 + 호스트 로그인 여부 + 지원 인증 방식. */
export async function GET() {
  const g = await guardAccount(); if (g.denied) return g.denied;
  return Response.json({ runners: await runnerStatus(g.scope) });
}

/** 저장 — { runner, type:'apikey'|'oauth', value, verify?, lang? }. 검증 규칙은 회사 라우트와 동일. */
export async function PUT(req) {
  try {
    const g = await guardAccount(); if (g.denied) return g.denied;
    const { runner, type = 'apikey', value, verify, lang = 'ko' } = await req.json();
    const meta = RUNNER_AUTH[runner];
    if (!meta) throw new Error('알 수 없는 러너');
    // host — "이 컴퓨터 로그인 사용" 명시 옵트인(codex/gemini). 회사 라우트와 동일 검증·마커 저장.
    if (type === 'host') {
      if (!hostOptInAllowed(runner)) throw new Error('이 환경에서는 이 컴퓨터 로그인 사용을 쓸 수 없습니다'); // claude는 데스크톱 번들에서 제외(키체인)
      const host = (await detectRunners(true))[runner]; // 캐시 우회 — 방금 로그인한 CLI를 예열 캐시가 60초 오거절하지 않게(감사 2026-07-20)
      if (!host?.installed) throw new Error('이 컴퓨터에서 해당 CLI가 감지되지 않습니다 — 먼저 설치해 주세요');
      if (!host?.authed) throw new Error('이 컴퓨터의 CLI가 로그인돼 있지 않습니다 — 터미널에서 로그인 후 다시 시도해 주세요');
      await saveRunnerCred(g.scope, runner, 'host', 'host');
      return Response.json({ ok: true, runner, connected: true, type: 'host', masked: '' });
    }
    if (!meta.methods.includes(type)) throw new Error(`${runner}는 ${type} 방식을 지원하지 않습니다`);
    const v = String(value ?? '').trim();
    if (!v) throw new Error('키 또는 토큰을 붙여넣어 주세요');
    if (type === 'apikey' && meta.apikeyPrefix && !v.startsWith(meta.apikeyPrefix)) {
      throw new Error(`${meta.apikeyPrefix} 로 시작하는 키를 붙여넣어 주세요`);
    }
    if (type === 'oauth') {
      // 형식이 다른 값이 저장을 통과하면 모든 턴이 401로만 드러난다 — 회사 라우트와 대칭(계정엔 회사 lang이 없어 요청 lang 사용)
      const fmtErr = oauthFormatError(runner, v, lang === 'en' ? 'en' : 'ko');
      if (fmtErr) throw new Error(fmtErr);
    }
    if (verify) {
      const r = await verifyRunnerCred(runner, type, v);
      if (r.ok === false) throw new Error('키가 거부되었습니다 (인증 실패). 콘솔에서 키를 확인하세요');
    }
    await saveRunnerCred(g.scope, runner, type, v);
    return Response.json({ ok: true, runner, connected: true, type, masked: maskCred(v) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 제거 — { runner } (쿼리 또는 바디). */
export async function DELETE(req) {
  try {
    const g = await guardAccount(); if (g.denied) return g.denied;
    const runner = new URL(req.url).searchParams.get('runner') || (await req.json().catch(() => ({}))).runner;
    if (!RUNNER_AUTH[runner]) throw new Error('알 수 없는 러너');
    await clearRunnerCred(g.scope, runner);
    return Response.json({ ok: true, runner, connected: false });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
