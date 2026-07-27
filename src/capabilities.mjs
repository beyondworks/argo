// 로컬 능력 토글 — 크루가 워크스페이스 밖 세상(파일·웹·셸)에 손대는 것은 전부 opt-in이다.
// 켜면 그 범위는 결재 없이 바로 실행된다(2026-07-18 모델 단순화 — permission-gate.mjs 주석 참조).
// 이전의 별도 bypass 토글은 잉여가 되어 설정 UI에서 내렸다(저장값은 하위호환으로 보존·무해).
import { paths } from './workspace.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { isAbsolute, resolve, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const CAPABILITY_DEFS = [
  ['fs', '파일 시스템', '워크스페이스 밖 파일 읽기/쓰기/편집 — 켜면 결재 없이 바로 실행됩니다'],
  ['browser', '웹 브라우징', '웹 페이지 열람·검색(WebFetch/WebSearch) — 켜면 결재 없이 바로 실행됩니다'],
  ['shell', '셸·컴퓨터', '명령 실행(Bash) — 켜면 결재 없이 바로 실행됩니다'],
  // 바이패스(유건 지시 2026-07-26) — "사람이 판단해야 하는 것만 결재". 도구·능력 같은 준비성 결재는
  // 자동 승인하고, 회사 밖으로 나가는 행동(발송·게시·구매·삭제·계약)과 크루 영입·프로필 변경은
  // 그대로 결재를 받는다. 그 경계는 크루 도구(request_approval)와 프롬프트 결재 규칙이 지킨다.
  ['bypass', '준비 작업 자동 승인', '도구 설치·능력 켜기처럼 준비성 결재를 자동 승인합니다. 이메일 발송·게시·구매·삭제처럼 사람이 판단해야 하는 일은 그대로 결재를 받습니다'],
];

const EMPTY = { fs: false, browser: false, shell: false, bypass: false, fsRoots: [] };

/* ─── 사용자 지정 허용 폴더(fsRoots) — P0-1 근본 대응(피드백 11건·막힌 사용자 7명, 2026-07-27) ───
   codex 러너의 writable_roots가 홈으로 하드코딩돼 fs 능력을 켜도 홈 밖(C:\services·D:\·외장 SSD)이
   구조적으로 막혔다. 하드코딩의 취지는 "앱 본체 보호"이지 홈 강제가 아니므로(QA 백로그 설계 제안),
   사장이 지정한 폴더를 writable_roots에 추가한다. SDK 러너는 fs ON이면 이미 홈 밖 허용(permission-gate
   하드존 제외)이라 이 목록은 codex 계열 근사에만 쓰인다 — 러너 간 자세가 "SDK 수준으로 상향" 방향.
   갈래 명시: 이것은 QA P0-1의 (B) 외부 폴더 허용이다. (A) 작업 루트(ARGO_ROOT) 이전은 데이터
   마이그레이션이 걸린 별도 트랙으로 남긴다. */
const FSROOTS_MAX = 8;
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 허용 폴더 1건 검증(순수·export 테스트용) — 절대경로 + 드라이브/루트 전체 금지 + 하드존(앱 루트·
    ~/.argo)을 포함하거나 그 안인 경로 금지. 반환: 정규화 경로 또는 throw. */
export function validateFsRoot(p) {
  const v = String(p ?? '').trim();
  if (!v || !isAbsolute(v)) throw new Error('절대 경로가 필요합니다 (예: /Users/me/work, D:\\projects)');
  const r = resolve(v);
  // 루트 전체(/, C:\)는 과광범위 — 하드존 회피가 불가능해진다
  if (r === sep || /^[A-Za-z]:\\?$/.test(r)) throw new Error('드라이브 전체는 지정할 수 없습니다 — 하위 폴더를 지정해 주세요');
  const within = (child, parent) => child === parent || child.startsWith(parent + sep);
  for (const hard of [appRoot, resolve(homedir(), '.argo')]) {
    // 하드존을 포함(상위)하거나 하드존 안(하위)이면 거부 — 앱 본체·자격 보관 보호(permission-gate와 동일 취지)
    if (within(hard, r) || within(r, hard)) throw new Error('앱 설치 폴더·Argo 데이터 폴더(및 그 상위)는 지정할 수 없습니다');
  }
  return r;
}

export async function loadCapabilities(wsId) {
  // 능력 토글은 보안 설정 — 손상을 조용히 리셋해 보안 자세를 바꾸지 않고 throw로 드러낸다.
  // 부재(ENOENT)만 EMPTY로 시드된다.
  // bypass는 2026-07-26에 정식 토글로 복귀했다(준비성 결재 자동 승인). 이전의 "레거시 bypass:true를
  // 3능력 켜기로 이행하고 끄던" 마이그레이션은 제거 — 지금은 UI/API로 켜고 끌 수 있어 고착 위험이 없고,
  // 남겨두면 사용자가 켠 설정을 매 로드마다 되돌린다.
  const raw = { ...EMPTY, ...(await readJson(paths(wsId).capabilities, EMPTY)) };
  // fsRoots 오염 흡수 — 동기화로 온 손상 값이 러너 config 직렬화를 깨지 않게 문자열만 통과
  raw.fsRoots = Array.isArray(raw.fsRoots) ? raw.fsRoots.filter((x) => typeof x === 'string' && x.trim()) : [];
  return raw;
}

export async function updateCapabilities(wsId, patch) {
  return withLock(`capabilities:${wsId}`, async () => {
    const caps = { ...(await loadCapabilities(wsId)) };
    for (const [key] of CAPABILITY_DEFS) {
      if (typeof patch[key] === 'boolean') caps[key] = patch[key];
    }
    if (Array.isArray(patch.fsRoots)) {
      // 전체 교체 방식(추가/제거 모두 클라가 최종 목록을 보냄) — 각 항목 검증, 중복 제거, 상한
      const seen = new Set();
      const roots = [];
      for (const p of patch.fsRoots) {
        const r = validateFsRoot(p); // 무효 항목은 throw — 일부만 조용히 수용하지 않는다(루틴 시각과 동일 원칙)
        if (!seen.has(r)) { seen.add(r); roots.push(r); }
      }
      if (roots.length > FSROOTS_MAX) throw new Error(`허용 폴더는 ${FSROOTS_MAX}개까지입니다`);
      caps.fsRoots = roots;
    }
    await writeJsonAtomic(paths(wsId).capabilities, caps);
    return caps;
  });
}
