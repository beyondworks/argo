import { loadClaudeKey, saveClaudeKey, clearClaudeKey, maskClaudeKey, verifyClaudeKey } from '../../../../../src/runners.mjs';
import { guardCompany } from '../../../../auth.mjs';

// 회사 Claude 키(BYOK) — 일반 사용자가 Claude Code 없이도 크루를 굴리게 하는 온보딩 관문.
// 응답에는 평문 대신 마스킹만 실린다(보안 규칙).

/** 상태 — 연결 여부 + 마스킹된 접두사. */
export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const key = await loadClaudeKey(ws);
  return Response.json({ connected: !!key, masked: maskClaudeKey(key) });
}

/** 저장 — { key, verify? }. verify=true면 Anthropic에 저비용 인증 확인 후 저장(인증 거부면 저장 안 함). */
export async function PUT(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { key, verify } = await req.json();
    const trimmed = String(key ?? '').trim();
    if (!/^sk-ant-/.test(trimmed)) throw new Error('sk-ant- 로 시작하는 Claude API 키를 붙여넣어 주세요');
    if (verify) {
      const v = await verifyClaudeKey(trimmed);
      if (v.ok === false) throw new Error('키가 거부되었습니다 (인증 실패). Anthropic 콘솔에서 키를 확인하세요');
      // v.ok === null(네트워크 불가)는 형식 검증만으로 저장 — 오프라인에서도 온보딩이 막히지 않게
    }
    await saveClaudeKey(ws, trimmed);
    return Response.json({ connected: true, masked: maskClaudeKey(trimmed) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 제거. */
export async function DELETE(_req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    await clearClaudeKey(ws);
    return Response.json({ connected: false, masked: '' });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
