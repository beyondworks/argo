// 권한 게이트 — 능력(fs/browser/shell)이 꺼진 워크스페이스에서 부작용 도구는 여기서 멈춰
// "켤까요?" 제안 카드를 올린다. 능력을 켰다면 결재 없이 바로 실행한다.
//
// 2026-07-18 모델 단순화(유건 지시): 이전엔 능력을 켜도 도구 실행마다 결재를 올리고 기다려
// 결재 폭탄·raw 명령 노출·흐름 끊김이 났다(실사용: grep/ls 하나하나 결재 카드). 사장이 설정에서
// 능력을 켠 것 = 그 범위의 신뢰 위임이다 — 켜짐은 즉시 실행, 꺼짐은 켜기 제안 카드 한 장.
// (별도 bypass 토글은 이 모델에서 잉여가 되어 설정 UI에서 내렸다 — capabilities.mjs)
import { resolve, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { addApproval, loadApprovals } from './approvals.mjs';

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

/** 능력 켜기 제안 결재 — 대화창 Yes/No 카드의 원천. 게이트 거절 시와 크루의 request_capability 도구가 함께 쓴다.
    from = 위임 원 크루 slug(있으면) — 카드가 "누구의 위임으로 온 요청인지"를 보여준다. */
const CAP_LABEL = { fs: '파일 시스템', browser: '웹 브라우징', shell: '셸·컴퓨터' };
export async function suggestCapability(wsId, slug, cap, why, from = null) {
  try {
    const dup = (await loadApprovals(wsId)).find((a) => a.status === 'pending' && a.kind === 'capability' && a.cap === cap);
    if (dup) return dup;
    return await addApproval(wsId, {
      slug, cap, kind: 'capability', ...(from ? { from } : {}),
      action: `로컬 능력 켜기: ${CAP_LABEL[cap] ?? cap}`,
      reason: why?.trim() || '크루가 이 능력이 필요한 작업을 받았습니다 — 승인하면 능력을 켜고 이어서 실행합니다',
    });
  } catch { return null; /* 제안 실패는 거절 응답을 막지 않는다 */ }
}

/** caps: {fs, browser, shell} — allowedTools에 없는 도구가 여기로 온다. 켜짐=허용, 꺼짐=켜기 제안 카드.
    from = 위임 원 크루 slug(제안 카드 표기용). */
export function makePermissionGate(wsId, slug, caps, wsRoot, from = null) {
  const inWorkspace = makeInWorkspace(wsRoot);
  const deny = (what) => ({ behavior: 'deny', message: `${what} 사장의 대화창에 "켤까요?" 카드를 띄웠으니, 승인하면 이어서 하겠다고 짧게 안내하라.` });

  return async function canUseTool(toolName, input) {
    const allow = { behavior: 'allow', updatedInput: input };
    if (toolName === 'TodoWrite' || toolName.startsWith('mcp__')) return allow; // 경로 없음·opt-in 도구

    if (READ_FILE_TOOLS.has(toolName)) {
      // 파일 읽기(Read/Glob/Grep) — 워크스페이스 안(또는 경로 미지정=cwd)은 허용, 밖은 fs 능력을 따른다.
      // capabilities.mjs 계약: fs = "워크스페이스 밖 파일 읽기/쓰기/편집". 읽기도 이 경계를 지킨다(P1-5).
      const targets = readToolTargets(toolName, input); // Read=file_path, Grep=path, Glob=path+pattern
      let outside = false;
      for (const t of targets) { if (!(await inWorkspace(t))) { outside = true; break; } }
      if (!outside) return allow; // 경로형 인자가 없거나(빈 배열) 전부 워크스페이스 안 → 허용
      if (caps.fs) return allow; // 사장이 켠 능력 — 결재 없이 실행
      await suggestCapability(wsId, slug, 'fs', null, from);
      return deny('워크스페이스 밖 파일 읽기는 파일 시스템 능력이 필요하다.');
    }
    if (WEB_TOOLS.has(toolName)) {
      if (caps.browser) return allow;
      await suggestCapability(wsId, slug, 'browser', null, from);
      return deny('웹 브라우징 능력이 꺼져 있다.');
    }
    if (WRITE_TOOLS.has(toolName)) {
      const target = input.file_path ?? input.notebook_path ?? '';
      if (await inWorkspace(target)) return allow; // 회사 폴더 안은 크루의 책상이다
      if (caps.fs) return allow;
      await suggestCapability(wsId, slug, 'fs', null, from);
      return deny('파일 시스템 능력이 꺼져 있다.');
    }
    if (toolName === 'Bash') {
      if (caps.shell) return allow;
      await suggestCapability(wsId, slug, 'shell', null, from);
      return deny('셸 능력이 꺼져 있다.');
    }
    return allow; // 그 외 도구 — 경계 개념 없음
  };
}
