// 워크스페이스 = 회사 1개의 격리 폴더 트리. SaaS에서는 유저별로 이 트리가 격리 컨테이너/볼륨에 산다.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { writeJsonAtomic } from './jsonstore.mjs';

export const WS_ROOT = process.env.ARGO_ROOT || process.env.CREWBASE_ROOT || join(process.cwd(), 'workspaces');

// 워크스페이스 id는 회사 생성 규칙(route.js: base-base36)이 내는 문자셋만 허용.
// paths()가 모든 파일 접근의 단일 관문이므로 여기서 막으면 전 API 라우트의 경로 탈출(../, %2f)이 차단된다.
const WS_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function paths(wsId) {
  if (typeof wsId !== 'string' || !WS_ID_RE.test(wsId)) {
    throw new Error('잘못된 워크스페이스 id');
  }
  const root = join(WS_ROOT, wsId);
  // 심층 방어 — 조립 결과가 WS_ROOT 경계 안임을 재확인(정규식을 뚫는 예외 케이스 대비)
  // sep 사용 필수: Windows resolve()는 백슬래시라 '/' 하드코딩이면 전 워크스페이스가 오차단된다 (v0.1.1 실측)
  if (!resolve(root).startsWith(resolve(WS_ROOT) + sep)) {
    throw new Error('워크스페이스 경계 위반');
  }
  return {
    root,
    company: join(root, 'company.json'),
    agents: join(root, 'agents'),
    chats: join(root, 'chats'),
    skills: join(root, 'skills'),
    routines: join(root, 'routines.json'),
    mcp: join(root, 'mcp.json'),
    usage: join(root, 'usage.jsonl'),
    approvals: join(root, 'approvals.json'),
    competitions: join(root, 'competitions'), // 경쟁 시안 — 같은 지시 N명 병렬 시안 기록
    connections: join(root, 'connections.json'),
    capabilities: join(root, 'capabilities.json'),
    vault: join(root, 'vault'),
    conversations: join(root, 'vault', 'conversations'), // 구버전 — 마이그레이션 후 읽기 전용
    journal: join(root, 'vault', 'journal'),
    notes: join(root, 'vault', 'notes'),
    index: join(root, 'vault', '_index.md'),
  };
}

/** 회사 생성 — 가입 직후 1회. 표준 스캐폴드(폴더 트리 + 기본 설정) + company.json 시드.
    ownerId = 인증 사용자 귀속(SaaS). 로컬 모드는 null — 코어는 인증을 모르고 필드만 기록한다. */
export async function createCompany(wsId, name, owner, ownerId = null, lang = 'ko') {
  const p = paths(wsId);
  if (existsSync(p.company)) throw new Error(`이미 존재하는 회사: ${wsId}`);
  const { ensureScaffold } = await import('./provision.mjs'); // 동적 — provision→workspace 순환 방지
  await ensureScaffold(wsId);
  // lang = 시스템(크루 생성) 언어. 크루 답변·페르소나·기억 노트가 이 언어를 따른다(company.json이 단일 진실).
  const company = { id: wsId, name, owner, ...(ownerId ? { ownerId } : {}), lang: lang === 'en' ? 'en' : 'ko', created: new Date().toISOString() };
  await writeJsonAtomic(p.company, company);
  await writeFile(p.index, `# ${name} — 회사 기억 인덱스\n\n(아직 기록 없음)\n`); // 회사 이름 반영 — 스캐폴드 기본을 덮는다
  return company;
}

export async function loadCompany(wsId) {
  return JSON.parse(await readFile(paths(wsId).company, 'utf8'));
}

/** 회사 정보 수정 — 이름 등. id/created는 불변. */
export async function updateCompany(wsId, patch) {
  const company = { ...(await loadCompany(wsId)), ...patch, id: wsId };
  await writeJsonAtomic(paths(wsId).company, company);
  return company;
}

/** 회사 보관 — 삭제 대신 .archive/로 폴더째 이동(복구 가능). */
export async function archiveCompany(wsId) {
  const archive = join(WS_ROOT, '.archive');
  await mkdir(archive, { recursive: true });
  await rename(paths(wsId).root, join(archive, `${Date.now()}-${wsId}`));
}
