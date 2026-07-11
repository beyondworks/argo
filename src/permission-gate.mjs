// 권한 게이트 — bypass가 꺼진 워크스페이스에서 부작용 도구는 여기서 멈춰 사람 승인을 기다린다.
// 승인(데크 결재함/텔레그램 버튼/슬랙 회신)되면 그 자리에서 이어서 실행되는 interrupt-resume.
import { resolve } from 'node:path';
import { addApproval, loadApprovals } from './approvals.mjs';
import { setTurnStatus } from './turn-status.mjs';

const WAIT_MS = 180_000; // 결재 대기 상한 — chat 라우트 maxDuration(300s) 안쪽
const POLL_MS = 2_000;

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoWrite']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']); // 읽기지만 회사 밖으로 나간다 — browser 능력을 따른다
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function describe(toolName, input) {
  if (toolName === 'Bash') return `명령 실행: ${String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 140)}`;
  if (WRITE_TOOLS.has(toolName)) return `워크스페이스 밖 파일 ${toolName === 'Write' ? '쓰기' : '수정'}: ${String(input.file_path ?? input.notebook_path ?? '')}`;
  return `${toolName} 실행`;
}

/** 능력 켜기 제안 결재 — 대화창 Yes/No 카드의 원천. 게이트 거절 시와 크루의 request_capability 도구가 함께 쓴다. */
const CAP_LABEL = { fs: '파일 시스템', browser: '웹 브라우징', shell: '셸·컴퓨터' };
export async function suggestCapability(wsId, slug, cap, why) {
  try {
    const dup = (await loadApprovals(wsId)).find((a) => a.status === 'pending' && a.kind === 'capability' && a.cap === cap);
    if (dup) return dup;
    return await addApproval(wsId, {
      slug, cap, kind: 'capability',
      action: `로컬 능력 켜기: ${CAP_LABEL[cap] ?? cap}`,
      reason: why?.trim() || '크루가 이 능력이 필요한 작업을 받았습니다 — 승인하면 능력을 켜고 이어서 실행합니다',
    });
  } catch { return null; /* 제안 실패는 거절 응답을 막지 않는다 */ }
}

/** caps: {fs, browser, shell, bypass(false 전제)} — allowedTools에 없는 도구가 여기로 온다. */
export function makePermissionGate(wsId, slug, caps, wsRoot) {
  const root = resolve(wsRoot);
  const inWorkspace = (p) => {
    if (typeof p !== 'string' || !p.trim()) return false;
    const abs = p.startsWith('/') ? resolve(p) : resolve(root, p);
    return abs === root || abs.startsWith(`${root}/`);
  };

  return async function canUseTool(toolName, input, { signal } = {}) {
    const allow = { behavior: 'allow', updatedInput: input };
    if (READ_TOOLS.has(toolName) || toolName.startsWith('mcp__')) return allow; // 읽기·opt-in 도구

    if (WEB_TOOLS.has(toolName)) {
      if (caps.browser) return allow; // 웹 열람은 읽기 — 능력만 켜져 있으면 결재 없이
      await suggestCapability(wsId, slug, 'browser');
      return { behavior: 'deny', message: '웹 브라우징 능력이 꺼져 있다. 사장의 대화창에 "켤까요?" 카드를 띄웠으니, 승인하면 이어서 하겠다고 짧게 안내하라.' };
    }

    if (WRITE_TOOLS.has(toolName)) {
      const target = input.file_path ?? input.notebook_path ?? '';
      if (inWorkspace(target)) return allow; // 회사 폴더 안은 크루의 책상이다
      if (!caps.fs) {
        await suggestCapability(wsId, slug, 'fs');
        return { behavior: 'deny', message: '파일 시스템 능력이 꺼져 있다. 사장의 대화창에 "켤까요?" 카드를 띄웠으니, 승인하면 이어서 하겠다고 짧게 안내하라.' };
      }
    } else if (toolName === 'Bash') {
      if (!caps.shell) {
        await suggestCapability(wsId, slug, 'shell');
        return { behavior: 'deny', message: '셸 능력이 꺼져 있다. 사장의 대화창에 "켤까요?" 카드를 띄웠으니, 승인하면 이어서 하겠다고 짧게 안내하라.' };
      }
    }

    // 능력은 켜져 있으나 우회 모드가 아님 — 결재를 올리고 이 자리에서 기다린다
    const item = await addApproval(wsId, {
      slug,
      action: describe(toolName, input),
      reason: '로컬 능력 실행 — 승인하면 멈춘 자리에서 바로 이어집니다',
      kind: 'tool',
    });
    await setTurnStatus(wsId, slug, '사장 결재 대기 중 — 결재함·메신저에서 승인하면 이어집니다');
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_MS) {
      await setTurnStatus(wsId, slug, '사장 결재 대기 중 — 결재함·메신저에서 승인하면 이어집니다');
      if (signal?.aborted) return { behavior: 'deny', message: '턴이 중단되었다.' };
      await new Promise((r) => setTimeout(r, POLL_MS));
      const cur = (await loadApprovals(wsId)).find((a) => a.id === item.id);
      if (cur?.status === 'approved') return allow;
      if (cur?.status === 'rejected') return { behavior: 'deny', message: '사장이 이 실행을 거절했다. 실행하지 말고 대안을 한두 줄로 정리하라.' };
    }
    return { behavior: 'deny', message: '권한 승인 대기 시간(3분)이 지났다. 실행하지 못했다고 보고하고, 결재함에 요청이 남아있다고 안내하라.' };
  };
}
