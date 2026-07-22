// 권한 게이트 — 능력(fs/browser/shell)이 꺼진 워크스페이스에서 부작용 도구는 여기서 멈춰
// "켤까요?" 제안 카드를 올린다. 능력을 켰다면 결재 없이 바로 실행한다.
//
// 2026-07-18 모델 단순화(유건 지시): 이전엔 능력을 켜도 도구 실행마다 결재를 올리고 기다려
// 결재 폭탄·raw 명령 노출·흐름 끊김이 났다(실사용: grep/ls 하나하나 결재 카드). 사장이 설정에서
// 능력을 켠 것 = 그 범위의 신뢰 위임이다 — 켜짐은 즉시 실행, 꺼짐은 켜기 제안 카드 한 장.
// (별도 bypass 토글은 이 모델에서 잉여가 되어 설정 UI에서 내렸다 — capabilities.mjs)
import { resolve, dirname, join, basename, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
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
    if (abs !== root && !abs.startsWith(`${root}${sep}`)) return false; // 렉시컬 탈출 차단(sep — Windows 백슬래시)
    const canon = async (t) => { try { return await realpath(t); } catch { return null; } };
    const realRoot = (await canon(root)) ?? root;
    const real = (await canon(abs)) ?? (await canon(dirname(abs))); // 대상이 없으면 부모로 심링크 재확인
    if (!real) return true; // 대상·부모 모두 부재 — 렉시컬 통과에 맡김(읽기는 어차피 실패)
    return real === realRoot || real.startsWith(`${realRoot}${sep}`);
  };
}

/* ─── 금지 구역(하드 차단) — 능력(fs)·결재·bypass로도 열리지 않는다 ───
   실사용 신고(2026-07-22, 크리티컬): 데스크톱은 앱 서버 소스가 로컬에 함께 배포되는 구조라,
   fs 능력이 켜진 크루에게 "앱 디자인 고쳐줘"라고 하면 실행 중인 Argo 코드를 실제로 수정할 수 있었다.
   금지 구역: ① 실행 중인 Argo 코드 루트(dev=레포, 데스크톱=Resources/server) ② ~/.argo(격리 홈·조달
   도구·자격) ③ WS_ROOT의 다른 회사 워크스페이스·계정 시크릿(교차 테넌트) ④ 자기 워크스페이스 직속
   도트파일(.secrets.json 등 — 회사 자격). 자기 워크스페이스 일반 파일이 우선 판정(안이면 항상 허용). */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // src/의 부모 = 실행 중인 Argo 코드 루트

/** p가 금지 구역인가 — 판정 전 자기 워크스페이스 안(inWorkspace)이 먼저 통과됐다는 전제의 2차 검사.
    canonical(실경로) 기준 — 심링크로 금지 구역을 우회하지 못한다. (export: 회귀 테스트용) */
export function makeIsForbidden(wsRoot, appRoot = APP_ROOT) {
  const wsAbs = resolve(wsRoot);
  // sep 사용 필수 — Windows resolve()는 백슬래시라 '/' 하드코딩이면 경계 비교가 전부 불발돼
  // 보호가 통째로 무력화된다(검수 MED — workspace.mjs paths()의 v0.1.1 실측과 같은 계열).
  const inside = (p, root) => p === root || p.startsWith(`${root}${sep}`);
  const canon = async (t) => { try { return await realpath(t); } catch { return null; } };
  // 비교 기준(루트들)도 canonical로 — macOS /var→/private/var 같은 루트 쪽 심링크 때문에
  // 대상만 realpath하면 경계 비교가 전부 어긋난다(테스트 실측). 1회 계산 후 재사용.
  let rootsP = null;
  const roots = () => (rootsP ??= (async () => {
    const ws = (await canon(wsAbs)) ?? wsAbs;
    return {
      ws,
      parent: dirname(ws), // WS_ROOT — 형제 = 다른 회사, 직속 도트파일 = 계정 시크릿·기기 마커
      hard: await Promise.all([resolve(appRoot), join(homedir(), '.argo')].map(async (r) => (await canon(r)) ?? r)),
    };
  })());
  return async function isForbidden(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const abs = p.startsWith('/') ? resolve(p) : resolve(wsAbs, p);
    const real = (await canon(abs)) ?? (await canon(dirname(abs))) ?? abs; // 미존재 대상은 부모→렉시컬 순 판정
    const R = await roots();
    if (inside(real, R.ws)) {
      // 자기 워크스페이스 안 — 직속 도트파일(.secrets.json 등)만 금지. chats/.archive처럼 한 단계
      // 아래의 도트 경로는 정상 데이터라 통과(부모가 wsRoot 직속일 때만 검사).
      return dirname(real) === R.ws && basename(real).startsWith('.');
    }
    for (const r of R.hard) if (inside(real, r)) return true;
    if (inside(real, R.parent)) return true; // WS_ROOT 아래인데 자기 회사 밖 — 타사 데이터·계정 시크릿
    return false;
  };
}

const FORBIDDEN_MSG = {
  ko: 'Argo 앱 자체(설치 폴더·서버 코드)와 다른 회사의 데이터, 자격 파일은 보호 구역이라 읽거나 고칠 수 없다. 앱 개선 요청이면 코드를 만지는 대신 사장에게 "설정 → 피드백"으로 전달하라고 안내하라.',
  en: 'The Argo app itself (install folder, server code), other companies’ data, and credential files are protected — you cannot read or modify them. If the captain wants app improvements, point them to Settings → Feedback instead of touching code.',
};

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

/** caps: {fs, browser, shell, bypass} — allowedTools에 없는 도구가 여기로 온다. 켜짐=허용, 꺼짐=켜기 제안 카드.
    bypass = 결재·능력 체크 생략(전권 위임)이되 **금지 구역은 예외 없이 차단**한다 — bypass의 의미는
    "사장 확인 생략"이지 "Argo 보호 구역 해제"가 아니다(실사용 신고 2026-07-22 크리티컬).
    from = 위임 원 크루 slug(제안 카드 표기용). lang = 거절 메시지 언어. */
export function makePermissionGate(wsId, slug, caps, wsRoot, from = null, lang = 'ko') {
  const inWorkspace = makeInWorkspace(wsRoot);
  const isForbidden = makeIsForbidden(wsRoot);
  const deny = (what) => ({ behavior: 'deny', message: `${what} 사장의 대화창에 "켤까요?" 카드를 띄웠으니, 승인하면 이어서 하겠다고 짧게 안내하라.` });
  const denyHard = () => ({ behavior: 'deny', message: FORBIDDEN_MSG[lang === 'en' ? 'en' : 'ko'] });
  // Bash 보완 방어 — 명령 문자열에 금지 구역 경로가 리터럴로 들어간 순진한 시도를 차단한다.
  // (셸은 변수·상대경로로 우회 가능한 프로세스 단위 도구 — 완전 차단이 아니라 1차 방어 + 프롬프트 지시가 계약)
  const appRootLiteral = APP_ROOT;
  const argoHome = join(homedir(), '.argo');

  return async function canUseTool(toolName, input) {
    const allow = { behavior: 'allow', updatedInput: input };
    if (toolName === 'TodoWrite' || toolName.startsWith('mcp__')) return allow; // 경로 없음·opt-in 도구

    if (READ_FILE_TOOLS.has(toolName)) {
      // 파일 읽기(Read/Glob/Grep) — 워크스페이스 안(또는 경로 미지정=cwd)은 허용, 밖은 fs 능력을 따른다.
      // capabilities.mjs 계약: fs = "워크스페이스 밖 파일 읽기/쓰기/편집". 읽기도 이 경계를 지킨다(P1-5).
      const targets = readToolTargets(toolName, input); // Read=file_path, Grep=path, Glob=path+pattern
      let outside = false;
      for (const t of targets) {
        if (await inWorkspace(t)) continue;
        outside = true;
        if (await isForbidden(t)) return denyHard(); // 금지 구역 — 능력·bypass 불문(자격 유출·앱 코드 열람 차단)
      }
      if (!outside) {
        // 워크스페이스 안이어도 직속 도트파일(.secrets.json)은 금지 — isForbidden의 ws 내부 분기
        for (const t of targets) if (await isForbidden(t)) return denyHard();
        return allow;
      }
      if (caps.fs || caps.bypass) return allow; // 사장이 켠 능력/전권 — 결재 없이 실행
      await suggestCapability(wsId, slug, 'fs', null, from);
      return deny('워크스페이스 밖 파일 읽기는 파일 시스템 능력이 필요하다.');
    }
    if (WEB_TOOLS.has(toolName)) {
      if (caps.browser || caps.bypass) return allow;
      await suggestCapability(wsId, slug, 'browser', null, from);
      return deny('웹 브라우징 능력이 꺼져 있다.');
    }
    if (WRITE_TOOLS.has(toolName)) {
      const target = input.file_path ?? input.notebook_path ?? '';
      if (await isForbidden(target)) return denyHard(); // 금지 구역 — 워크스페이스 안 도트파일 포함
      if (await inWorkspace(target)) return allow; // 회사 폴더 안은 크루의 책상이다
      if (caps.fs || caps.bypass) return allow;
      await suggestCapability(wsId, slug, 'fs', null, from);
      return deny('파일 시스템 능력이 꺼져 있다.');
    }
    if (toolName === 'Bash') {
      const cmd = String(input?.command ?? '');
      if (cmd.includes(appRootLiteral) || cmd.includes(argoHome)) return denyHard(); // 리터럴 경로 1차 방어
      if (caps.shell || caps.bypass) return allow;
      await suggestCapability(wsId, slug, 'shell', null, from);
      return deny('셸 능력이 꺼져 있다.');
    }
    // 그 외 도구 — 능력 분류 밖(SDK 내장 Task 등). 이전 모델도 결재만 걸고 결국 허용했으므로
    // allow가 동작 등가·회귀 제로다(부작용 도구가 새로 생기면 위 분류에 추가하는 것이 대응 지점).
    return allow;
  };
}
