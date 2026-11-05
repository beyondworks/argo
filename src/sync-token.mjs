// 외부 동기화 통로 토큰 — 이 컴퓨터의 상시 작업(launchd)이 로컬 API의 좁은 쓰기 하나를 정식으로 부르게 한다.
//
// 배경(2026-11-05): 효일 기억 동기화(launchd 작업, /opt/homebrew/bin/node)는 launchd에 입양된 고아이고 실행 파일이 앱 묶음 밖이라
// 방지턱 ⑥ orphan-cli(src/agent-peer.mjs)에 걸려 vault 쓰기(POST·PUT)가 10/22부터 403이었다. 방지턱은 그대로 두고,
// **판정 사유가 orphan-cli일 때만** 범위가 묶인 토큰으로 그 한 요청을 통과시킨다.
//
// 범위(scope)는 고정 표다 — 토큰마다 회사(ws) 하나 + 표의 메서드·경로만. 지금 표는 'vault-notes' 하나:
//   POST·PUT /api/companies/<ws>/vault (주제 노트 생성·수정. 삭제·consolidate·다른 라우트는 범위 밖)
// 이 서버의 자손·표지 env·에이전트 묶음(①②④)은 토큰이 있어도 통과하지 않는다 — Argo 에이전트가 토큰을 읽어도 이 통로를 못 쓴다.
// 같은 OS 계정의 다른 프로그램은 토큰 파일을 읽을 수 있다 — 방지턱의 한 겹이고, 통과해도 할 수 있는 일은 주제 노트 쓰기뿐이다.
//
// 저장: 서버는 토큰의 sha256만 <ARGO_ROOT>/.sync-tokens.json(권한 600)에 둔다. 평문은 발급 때 한 번 --out 파일(600)로만 쓴다.
// 요청마다 파일을 다시 읽는다(캐시 없음) — 지우면(revoke) 다음 요청부터 바로 거절된다. 헤더가 있고 orphan-cli일 때만 읽으므로 비용은 그 요청뿐이다.
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

export const SYNC_TOKEN_HEADER = 'x-argo-sync-token';
export const SYNC_TOKEN_FILE = '.sync-tokens.json';

/** 범위 표 — 이름 → (메서드, 경로, ws) 판정(순수). 경로는 쿼리를 뗀 원문 그대로 비교한다(정규화 차이로 다른 라우트에 닿지 않게). */
export const SYNC_SCOPES = {
  'vault-notes': ({ method, path, ws }) => (method === 'POST' || method === 'PUT') && path === `/api/companies/${encodeURIComponent(ws)}/vault`,
};

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

const rootDir = () => process.env.ARGO_ROOT || process.env.CREWBASE_ROOT || join(process.cwd(), 'workspaces');
export const syncTokenFile = (root = rootDir()) => join(root, SYNC_TOKEN_FILE);

/** 토큰 표 읽기 — 없거나 깨졌으면 빈 표(=전부 거절). */
export async function loadSyncTokens(file = syncTokenFile()) {
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(j?.tokens) ? j.tokens : [];
  } catch { return []; }
}

const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === 64 && b.length === 64
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** 이 요청이 토큰 범위 안인가(순수 — 표를 받아 판정). 맞으면 토큰 이름, 아니면 null. */
export function matchSyncToken({ token, method, path, tokens }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
  const h = tokenHash(token);
  const m = String(method ?? '').toUpperCase();
  for (const t of tokens) {
    if (!t || typeof t.name !== 'string' || typeof t.ws !== 'string' || !t.ws) continue;
    const scope = SYNC_SCOPES[t.scope];
    if (!scope || !sameHex(h, t.sha256)) continue;
    if (scope({ method: m, path, ws: t.ws })) return t.name;
  }
  return null;
}

/** 요청 머리에서 토큰을 꺼내 범위를 판정한다. 헤더가 없으면 파일을 읽지 않는다. */
export async function syncTokenAllows(req, { load = loadSyncTokens } = {}) {
  const raw = req?.headers?.[SYNC_TOKEN_HEADER];
  const token = Array.isArray(raw) ? null : raw; // 같은 헤더 여러 개는 받지 않는다
  if (!token) return null;
  const path = String(req.url ?? '').split('?')[0];
  return matchSyncToken({ token, method: req.method, path, tokens: await load() });
}
