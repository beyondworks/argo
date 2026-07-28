// 옵시디언 볼트 임포트 API — 분류·복사 정책은 src/obsidian-import.mjs가 정본.
// 오류는 코드로 반환하고 UI가 i18n 매핑한다(서버 한국어 하드코딩 금지 — K7 계열 예방).
import { importObsidianVault, readImportStatus } from '../../../../../../src/obsidian-import.mjs';
import { guardCompany, csrfDenied } from '../../../../../auth.mjs';

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    // CSRF 가드 — 임의 디스크 폴더를 회사 데이터로 끌어오는 벌크 write라, 로컬 모드(AUTH off)에서
    // 악성 웹페이지의 simple POST로 발동되면 안 된다(export 라우트와 동일 근거 — 끌어온 데이터는
    // 클라우드 동기화를 타고 유출 경로가 된다).
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { src, dryRun } = await req.json();
    const r = await importObsidianVault(ws, src, { dryRun: !!dryRun });
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: e.code || 'invalid', detail: String(e.message || e) }, { status: 400 });
  }
}

/** 진행 상태 폴링 — 임포트 실행 중 UI가 1초 간격으로 읽는다(실행 중에만 — 상시 타이머 아님). */
export async function GET(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    return Response.json(await readImportStatus(ws));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
