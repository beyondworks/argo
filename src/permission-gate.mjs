// 권한 게이트 — bypass가 꺼진 워크스페이스에서 부작용 도구는 여기서 멈춰 사람 승인을 기다린다.
// 승인(데크 결재함/텔레그램 버튼/슬랙 회신)되면 그 자리에서 이어서 실행되는 interrupt-resume.
import { resolve, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { addApproval, loadApprovals, expireApproval } from './approvals.mjs';
import { setTurnStatus } from './turn-status.mjs';

// 결재 대기 상한 — chat 라우트 maxDuration(300s) 안쪽. 원격(메신저) 승인은 3분이 빠듯해
// env로 조정 가능하게 하되 라우트 한도 아래로 캡한다. 만료돼도 요청은 결재함에 남아
// 나중 승인 시 후속 턴이 잇는다(실패 아님 — 아래 deny 문구가 그 사실을 크루에게 전달).
const WAIT_MS = Math.min(Number(process.env.ARGO_APPROVAL_WAIT_MS) || 180_000, 240_000);
const POLL_MS = 2_000;

// 경로 인자를 갖는 읽기 도구 — 워크스페이스 경계를 적용한다(P1-5). TodoWrite는 경로가 없어 별도(항상 허용).
const READ_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/** 읽기 도구의 경계 검사 대상 경로들 — 하나라도 워크스페이스 밖이면 게이트(P1-5).
    Glob은 path와 pattern을 둘 다 본다: path가 안이어도 pattern이 절대경로/상위탈출이면 밖을 열거할 수 있어서다
    (path만 검사하면 안쪽 path + 절대 pattern 조합으로 우회됨). Grep의 pattern은 정규식이라 제외.
    (export: 회귀 테스트용) */
export function readToolTargets(toolName, input = {}) {
  const s = (v) => (typeof v === 'string' && v.length > 0 ? [v] : []);
  if (toolName === 'Glob') return [...s(input.path), ...s(input.pattern)];
  if (toolName === 'Grep') return s(input.path); // pattern은 정규식 — 경로 아님
  return s(input.file_path); // Read
}
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']); // 읽기지만 회사 밖으로 나간다 — browser 능력을 따른다
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** 워크스페이스 경계 판정(심링크 탈출 방어 포함) — p가 root 안이면 true.
    렉시컬(resolve)로 ../ 탈출을 먼저 막고, 실제 경로(존재분)를 realpath로 정규화해 심링크 탈출까지 막는다.
    (export: 회귀 테스트용) */
export function makeInWorkspace(wsRoot) {
  const root = resolve(wsRoot);
  return async function inWorkspace(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const abs = p.startsWith('/') ? resolve(p) : resolve(root, p);
    if (abs !== root && !abs.startsWith(`${root}/`)) return false; // 렉시컬 탈출 차단
    const canon = async (t) => { try { return await realpath(t); } catch { return null; } };
    const realRoot = (await canon(root)) ?? root;
    const real = (await canon(abs)) ?? (await canon(dirname(abs))); // 대상이 없으면 부모로 심링크 재확인
    if (!real) return true; // 대상·부모 모두 부재 — 렉시컬 통과에 맡김(읽기는 어차피 실패)
    return real === realRoot || real.startsWith(`${realRoot}/`);
  };
}

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
  const inWorkspace = makeInWorkspace(wsRoot);
  const deny = (what) => ({ behavior: 'deny', message: `${what} 사장의 대화창에 "켤까요?" 카드를 띄웠으니, 승인하면 이어서 하겠다고 짧게 안내하라.` });

  return async function canUseTool(toolName, input, { signal } = {}) {
    const allow = { behavior: 'allow', updatedInput: input };
    if (toolName === 'TodoWrite' || toolName.startsWith('mcp__')) return allow; // 경로 없음·opt-in 도구

    if (READ_FILE_TOOLS.has(toolName)) {
      // 파일 읽기(Read/Glob/Grep) — 워크스페이스 안(또는 경로 미지정=cwd)은 허용, 밖이면 fs 능력 결재.
      // capabilities.mjs 계약: fs = "워크스페이스 밖 파일 읽기/쓰기/편집". 읽기도 이 경계를 지킨다(P1-5).
      const targets = readToolTargets(toolName, input); // Read=file_path, Grep=path, Glob=path+pattern
      let outside = false;
      for (const t of targets) { if (!(await inWorkspace(t))) { outside = true; break; } }
      if (!outside) return allow; // 경로형 인자가 없거나(빈 배열) 전부 워크스페이스 안 → 허용
      if (!caps.fs) { await suggestCapability(wsId, slug, 'fs'); return deny('워크스페이스 밖 파일 읽기는 파일 시스템 능력이 필요하다.'); }
      // fs 켜짐 + 밖 읽기 → 결재 대기(아래 공통 흐름). 밖은 부작용처럼 사람 승인.
    } else if (WEB_TOOLS.has(toolName)) {
      if (caps.browser) return allow; // 웹 열람은 읽기 — 능력만 켜져 있으면 결재 없이
      await suggestCapability(wsId, slug, 'browser');
      return deny('웹 브라우징 능력이 꺼져 있다.');
    } else if (WRITE_TOOLS.has(toolName)) {
      const target = input.file_path ?? input.notebook_path ?? '';
      if (await inWorkspace(target)) return allow; // 회사 폴더 안은 크루의 책상이다
      if (!caps.fs) { await suggestCapability(wsId, slug, 'fs'); return deny('파일 시스템 능력이 꺼져 있다.'); }
    } else if (toolName === 'Bash') {
      if (!caps.shell) { await suggestCapability(wsId, slug, 'shell'); return deny('셸 능력이 꺼져 있다.'); }
    }

    // 능력은 켜져 있으나 우회 모드가 아님 — 결재를 올리고 이 자리에서 기다린다
    const item = await addApproval(wsId, {
      slug,
      action: describe(toolName, input),
      reason: '로컬 능력 실행 — 승인하면 멈춘 자리에서 바로 이어집니다',
      kind: 'tool',
    });
    await setTurnStatus(wsId, slug, 'awaiting_approval'); // 코드 — 클라가 i18n으로 번역
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_MS) {
      await setTurnStatus(wsId, slug, 'awaiting_approval'); // 코드 — 클라가 i18n으로 번역
      if (signal?.aborted) return { behavior: 'deny', message: '턴이 중단되었다.' };
      await new Promise((r) => setTimeout(r, POLL_MS));
      const cur = (await loadApprovals(wsId)).find((a) => a.id === item.id);
      if (cur?.status === 'approved') return allow;
      if (cur?.status === 'rejected') return { behavior: 'deny', message: '사장이 이 실행을 거절했다. 실행하지 말고 대안을 한두 줄로 정리하라.' };
    }
    // 만료 — tool 결재는 대기 자리를 떠나면 나중에 승인해도 자동 재개되지 않는다(약속 위반 방지).
    // 죽은 버튼이 결재함/아침보고 카운트에 남지 않게 'expired'로 내리고, 크루가 정직하게 안내하게 한다.
    await expireApproval(wsId, item.id).catch(() => {});
    return { behavior: 'deny', message: `권한 승인 대기 시간(${Math.round(WAIT_MS / 60_000)}분)이 지났다. 이 실행은 대기 자리를 떠나 지금은 이어지지 않는다 — 사장에게 "승인이 필요하면, 승인하신 뒤 같은 지시를 한 번 더 주시면 바로 이어서 하겠다"고 정직하게 안내하고 턴을 마무리하라.` };
  };
}
