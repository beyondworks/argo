// MCP OAuth 커넥터 코어 — "로그인만으로" 외부 서비스 연동의 단일 실행 경로.
// 설계서 docs/mcp-oauth-design.md §2-1 / 스파이크 리포트(oauth-spike §②·④ US-1) 실증 코드 기반.
//
// 러너 무관 원칙(§0, 위반 금지): 이 모듈은 러너를 모른다. MCP 클라이언트는 Argo 코어가 실행하고,
// SDK 표면(use_connector)·CLI 표면(tool 블록)은 후속 스토리가 같은 함수(callConnectorTool)로 배선한다.
//
// SDK 자동/Argo 구현 경계(스파이크 §② 경계 지도, SDK 1.30.0 client/auth 소스 실독):
//   SDK 자동 = 401 감지·PRM/AS 디스커버리·DCR·PKCE·토큰 교환·refresh 갱신·오류 자가치유(invalidateCredentials)
//   Argo 몫  = localhost 콜백 서버(포트 0·state 검증·타임아웃·1회용) + 저장 콜백 5종의 영속 + finishAuth 1줄
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { paths } from './workspace.mjs';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { appendEvent } from './events.mjs';

/* ─── 토큰 보관 — 커넥터 전용 네임스페이스 (설계서 §2-1·§2-4) ───
   회사 루트 직속 도트파일 = 기존 4중 계약에 자동 편입된다(불변식 전수 수색 2026-07-31):
   ① 권한 게이트: 직속 도트 항목은 크루의 **파일 도구**(Read/Write/Edit/Glob/Grep)와 MCP 인자에서
      하드 차단(permission-gate.mjs — "회사 금고"). 셸은 리터럴 1차 방어일 뿐이고(BASH_GUARDED에
      이 파일명을 명시 등재해야 걸린다 — 분리 검수 M1 실측: 등재 전엔 `cat`이 통과했다), CLI 러너
      (codex·gemini·antigravity)는 애초에 이 게이트를 지나지 않는다(docs/runner-isolation-limits.md).
      "하드 차단"을 무조건으로 읽지 말 것 — 표면별 한계가 다르다.
   ② 내보내기: 직속 도트 항목은 클라우드 export 제외(export.mjs)
   ③ 옵시디언 임포트: 도트 규칙이 걸러 반입 안 됨(obsidian-import.mjs)
   ④ 파일 모드: writeJsonAtomic이 0600(jsonstore.mjs P1-8)
   ⑤ sync만 명시 등재 필요 — sync.mjs EXCLUDE에 이 파일명 추가(기기·회사 스코프: 토큰은 동기화하지
      않고 다른 기기는 그 기기에서 다시 연결한다 — .workroots.json과 같은 원칙, 설계서 §2-1).
   러너 자격(.secrets.json)과 분리하는 이유: 러너 자격은 봉투 동기화 대상이지만 커넥터 토큰은
   기기 로컬이라 수명 규칙이 다르다 — 한 파일에 섞으면 sync 경계가 파일 단위로 갈라지지 않는다. */
export const CONNECTOR_SECRETS_BASE = '.connector-secrets.json';
const storeFile = (wsId) => join(paths(wsId).root, CONNECTOR_SECRETS_BASE);

async function loadStore(wsId) {
  // 손상 시 readJson이 .corrupt 백업 후 throw — 조용한 폴백 없이 1회 명시 실패, 다음 로드는 빈 상태로
  // 자가치유(러너 자격 loadSecrets와 같은 계약). UI엔 미연결로 노출된다.
  const s = await readJson(storeFile(wsId), {});
  if (!s.servers) s.servers = {};
  return s;
}

/** 서버 레코드 부분 갱신(원자·직렬화). patch 값 null = 필드 삭제(토큰 무효화용). */
function patchServer(wsId, serverId, patch) {
  return withLock(`connector:${wsId}`, async () => {
    const s = await loadStore(wsId);
    const next = { ...(s.servers[serverId] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    s.servers[serverId] = next;
    await writeJsonAtomic(storeFile(wsId), s);
    return next;
  });
}

/* ─── OAuthClientProvider — SDK client/auth 계약 구현 (저장 콜백 5종 = 커넥터 저장소 영속) ───
   connect 모드(onRedirect 제공): 인가 URL을 붙잡아 호출부에 넘긴다(브라우저 열기는 호출부 몫).
   headless 모드(풀 호출용): refresh까지 실패해 SDK가 재인가를 요구하면(redirectToAuthorization 도달)
   ARGO_REAUTH를 던져 "재연결 필요" 강등 신호로 삼는다 — 조용한 무동작 금지. */
const REAUTH = 'ARGO_REAUTH';
const isReauthErr = (e) => e instanceof UnauthorizedError || e?.code === REAUTH;

function makeProvider(wsId, serverId, { redirectUrl = null, state = null, scopes = null, onRedirect = null } = {}) {
  const redirect = redirectUrl ?? 'http://127.0.0.1/argo-connector-headless'; // headless에선 URL 조립용 자리값(도달 전 REAUTH로 이탈)
  return {
    redirectUrl: redirect,
    clientMetadata: {
      client_name: 'Argo Connector',
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // 퍼블릭 클라이언트(데스크톱) — PKCE가 방어(스파이크 §② 왕복 실증)
      ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
    },
    ...(state ? { state: () => state } : {}),
    // 사전 등록 client(구글류 DCR 미지원)는 startConnect가 store.client로 선기입 → SDK가 DCR을
    // 건너뛴다(auth.js 소스 확인: clientInformation()이 truthy면 registerClient 미호출).
    async clientInformation() { return (await loadStore(wsId)).servers[serverId]?.client; },
    async saveClientInformation(info) { await patchServer(wsId, serverId, { client: info }); },
    async tokens() { return (await loadStore(wsId)).servers[serverId]?.tokens; },
    async saveTokens(t) {
      // refresh 자동 갱신(풀 호출 중)도 여기로 온다 — 갱신 성공은 곧 연결 정상(자가치유 시 정직 상태 복귀).
      await patchServer(wsId, serverId, { tokens: t, status: 'connected', error: null, errorCode: null });
    },
    async saveCodeVerifier(v) { await patchServer(wsId, serverId, { verifier: v }); },
    async codeVerifier() {
      const v = (await loadStore(wsId)).servers[serverId]?.verifier;
      if (!v) throw new Error('PKCE verifier 없음 — 연결을 처음부터 다시 시작해 주세요');
      return v;
    },
    async redirectToAuthorization(url) {
      if (onRedirect) return void onRedirect(url);
      const e = new Error('토큰 갱신 실패 — 재연결이 필요합니다');
      e.code = REAUTH;
      throw e;
    },
    async invalidateCredentials(scope) {
      // SDK 자가치유 신호(auth() 소스: InvalidClient/UnauthorizedClient→'all', InvalidGrant→'tokens').
      // 죽은 자격을 지워 정직 상태로 — 'verifier'는 진행 상태 정리일 뿐이라 강등하지 않는다.
      if (scope === 'verifier') return void await patchServer(wsId, serverId, { verifier: null });
      await patchServer(wsId, serverId, {
        tokens: null, verifier: null,
        ...(scope === 'all' || scope === 'client' ? { client: null } : {}),
        status: 'reauth', errorCode: 'reauth_required', error: connectorMessage('reauth_required', 'ko', serverId),
      });
    },
  };
}

/* ─── 연결 시작 — 인가 URL 생성 + localhost 콜백 수신 + 토큰 영속 (설계서 §2-1 startConnect) ─── */
const CONNECT_TIMEOUT_MS = 120_000;
const LOOPBACK = '127.0.0.1';
/** 평문 http 허용 = loopback뿐(그 외는 TLS 필수 — OAuth 2.1). 호스트명 loopback 별칭도 인정. */
export function isTlsOrLoopback(u) {
  let h;
  try { h = new URL(u); } catch { return false; }
  if (h.protocol === 'https:') return true;
  if (h.protocol !== 'http:') return false;
  return h.hostname === LOOPBACK || h.hostname === 'localhost' || h.hostname === '::1' || h.hostname === '[::1]';
}
const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Argo</title>'
  + '<body style="font-family:sans-serif;padding:2rem">연결되었습니다 — 이 창을 닫아 주세요. / Connected — you may close this tab.</body>';

/**
 * OAuth 연결 시작. serverDef = { id, url, scopes?, oauth?: { client_id, client_secret? } }.
 * 반환 { authUrl, done }: authUrl = 브라우저로 열 인가 URL(여는 건 호출부 몫 — 데스크톱 opener/웹 표기),
 * done = 완료 프라미스(항상 resolve: { ok, serverId, error? }) — 웹 UI는 done 또는 listConnections 폴링으로
 * 완료를 안다(저장소 status: connecting → connected | error). 무보호 서버(인가 불요)는 authUrl=null 즉시 완료.
 * timeoutMs는 테스트 주입용 노브 — 기본 120s(설계서 §2-1).
 */
export async function startConnect(wsId, serverDef, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const id = serverDef?.id;
  const url = serverDef?.url;
  if (typeof id !== 'string' || !id.trim() || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('커넥터 정의가 잘못되었습니다 — id·url이 필요합니다');
  }
  // 평문 http는 loopback(로컬 테스트 서버)에만 허용 — OAuth 2.1은 그 외 TLS 필수다. 베어러 토큰이
  // 평문으로 흐르는 원격 서버는 카탈로그에 실려도 여기서 막는다(검수 L2).
  if (!isTlsOrLoopback(url)) throw new Error('원격 커넥터는 https만 허용됩니다(평문 http는 로컬 전용)');
  dropPool(wsId, id); // 재연결 시 옛 토큰을 문 풀 클라이언트가 살아남지 않게
  await patchServer(wsId, id, {
    url, status: 'connecting', error: null, errorCode: null, verifier: null,
    ...(serverDef.oauth?.client_id
      ? { client: { client_id: serverDef.oauth.client_id, ...(serverDef.oauth.client_secret ? { client_secret: serverDef.oauth.client_secret } : {}) } }
      : {}),
  });

  // localhost 콜백 서버 — loopback 전용·포트 0 임의 배정·state 필수·1회용(설계서 §2-4). SDK 미제공 구간.
  const state = randomUUID();
  // 경로는 **고정**이어야 한다. 한때 난수 세그먼트를 넣었지만(포트 훑는 페이지 차단 의도) 재인가가
  // 통째로 깨졌다(분리 검수 2R 실측 400 `Unregistered redirect_uri`): redirect_uri는 DCR 등록·콘솔
  // 사전 등록으로 **영속**되는데 RFC 8252는 포트만 완화하고 경로는 정확 일치를 요구한다. 즉 매 시도
  // 경로가 바뀌면 두 번째 연결부터(그리고 사전 등록 client_id는 첫 연결부터) 실패한다.
  const cbPath = '/callback';
  let settle;
  const arrived = new Promise((r) => { settle = r; });
  const cb = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${LOOPBACK}`);
    if (u.pathname !== cbPath) { res.writeHead(404).end(); return; } // favicon 등은 시도 소비 아님
    if (u.searchParams.get('state') !== state) {
      // state 불일치 = 위조·혼선 콜백(CSRF 방어) — 거부하되 **시도는 죽이지 않는다**. 코드 배달은
      // 정상 state로만 가능하고 타임아웃이 상한을 주므로 무시해도 보안은 동일한 반면, 종료시키면
      // 로컬 포트를 훑는 아무 웹페이지나 진행 중 인가를 끊을 수 있다(그게 난수 경로로 막으려던 것).
      // 응답에 쿼리값을 되비추지 않는다(반사 XSS 차단 — 고정 문구만).
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('state mismatch');
      return;
    }
    const authErr = u.searchParams.get('error');
    if (authErr) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE.replace('연결되었습니다', '연결이 거부되었습니다').replace('Connected', 'Authorization failed'));
      settle({ errorCode: 'auth_denied', detail: authErr.replace(/[^\w.-]/g, '_') });
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) { res.writeHead(400).end('missing code'); settle({ errorCode: 'no_code' }); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
    settle({ code });
  });
  await new Promise((resolve, reject) => { cb.on('error', reject); cb.listen(0, LOOPBACK, resolve); });
  // 바인드 실측 검증(fail-closed) — 이 콜백은 설계서 §2-4의 유일한 네트워크 표면이고, 바인드 주소
  // 한 글자가 바뀌면 조용히 LAN에 열린다. 리터럴로 비교하는 게 핵심이다: 위 LOOPBACK 상수와
  // 대조하면 상수를 바꾼 변이가 스스로를 통과시킨다(자기 참조 앵커).
  const bound = cb.address();
  if (bound?.address !== '127.0.0.1') {
    cb.close();
    throw new Error(`콜백 서버가 loopback이 아닌 주소에 열렸습니다(${bound?.address}) — 연결을 중단합니다`);
  }
  const redirectUrl = `http://${LOOPBACK}:${bound.port}${cbPath}`;

  let authUrl = null;
  const provider = makeProvider(wsId, id, { redirectUrl, state, scopes: serverDef.scopes, onRedirect: (u) => { authUrl = String(u); } });
  const probe = new Client({ name: 'argo-connector', version: '1.0.0' });
  try {
    // 접속 시도 → 401이면 SDK가 디스커버리→(DCR)→PKCE→인가 URL 생성까지 자동 수행 후 REDIRECT 신호
    // (UnauthorizedError)를 낸다 — 스파이크 실왕복 실증. 이 호출이 연결 버튼의 인가 "선행 트리거"이기도
    // 하다(구글류: 401이 tools/call에서야 뜨는 서버도 여기서 auth를 유발 — 스파이크 §② 특이점 1).
    await probe.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }));
    await probe.close().catch(() => {});
    cb.close();
    await patchServer(wsId, id, { status: 'connected', error: null, errorCode: null });
    return { authUrl: null, callbackAddress: bound.address, done: Promise.resolve({ ok: true, serverId: id }) }; // 무보호 서버 — 인가 불요
  } catch (e) {
    await probe.close().catch(() => {});
    if (!(e instanceof UnauthorizedError) || !authUrl) {
      cb.close();
      const detail = String(e?.message ?? e);
      await patchServer(wsId, id, { status: 'error', errorCode: 'connect_failed', errorDetail: detail, error: connectorMessage('connect_failed', 'ko', detail) });
      throw e; // 즉시 실패(디스커버리 불가 등)는 호출부가 바로 보여준다 — 조용한 무동작 금지
    }
  }

  const done = (async () => {
    const timer = setTimeout(() => settle({ errorCode: 'auth_timeout', detail: Math.round(timeoutMs / 1000) }), timeoutMs);
    timer.unref?.();
    const out = await arrived;
    clearTimeout(timer);
    cb.close(); // 1회용 — 첫 결과(성공·거부·타임아웃)로 콜백 창구를 닫는다
    if (out.errorCode) {
      const text = connectorMessage(out.errorCode, 'ko', out.detail);
      await patchServer(wsId, id, { status: 'error', errorCode: out.errorCode, errorDetail: out.detail ?? null, error: text });
      return { ok: false, serverId: id, errorCode: out.errorCode, error: text };
    }
    try {
      // 토큰 교환(PKCE verifier 포함)은 SDK 몫 — finishAuth 1줄(스파이크 경계 지도). 성공 시 saveTokens가
      // status:'connected'로 영속한다.
      await new StreamableHTTPClientTransport(new URL(url), { authProvider: provider }).finishAuth(out.code);
      await patchServer(wsId, id, { verifier: null }); // 1회용 verifier 정리
      return { ok: true, serverId: id };
    } catch (e) {
      const detail = String(e?.message ?? e);
      const text = connectorMessage('exchange_failed', 'ko', detail);
      await patchServer(wsId, id, { status: 'error', errorCode: 'exchange_failed', errorDetail: detail, error: text });
      return { ok: false, serverId: id, errorCode: 'exchange_failed', error: text };
    }
  })();
  // callbackAddress = 실제 바인드 주소 관측창(테스트가 loopback 불변식을 행동으로 단언한다 — 검수 M2).
  return { authUrl, callbackAddress: bound.address, done };
}

/* ─── 연결 풀 + tools/list 캐시 (설계서 §2-1 callConnectorTool) ───
   규모(관문 0.5): 풀 엔트리 = "최근 5분 내 호출한" 회사×서버당 1 — 소켓/fd 1 + Client 객체(수 KB) +
   tools 캐시(도구 30개 × 스키마 ≈ 30~60KB) ≈ 엔트리당 ~70KB. 회사 100 × 서버 3이 전부 활성인 최악에도
   300 엔트리 ≈ 21MB·fd 300. 유휴 5분 소거(스위프 60s, O(엔트리 수))로 평시 상주는 회사당 0~3개.
   소거 비용 = 풀 재생성 시 connect+tools/list 왕복 2회. */
const POOL_IDLE_MS = 5 * 60_000;
const POOL_SWEEP_MS = 60_000;
const pools = new Map(); // `${wsId}:${serverId}` → { ready, client, tools, lastUsed, close }
/** 풀 회수 계측 — "닫혔는가"를 테스트가 행동으로 단언하기 위한 관측창. 검수 M3는 누수를 계측으로
    잡아냈는데(close 0회) 테스트에는 그 관측이 없어 초록이었다. 동작에는 영향 없는 카운터다. */
export const poolStats = { opened: 0, closed: 0 };
let sweeper = null;
const poolKey = (wsId, serverId) => `${wsId}:${serverId}`;

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, p] of pools) if (now - p.lastUsed > POOL_IDLE_MS) { pools.delete(k); p.close(); }
  }, POOL_SWEEP_MS);
  sweeper.unref?.(); // 유휴 프로세스 종료를 막지 않는다
}

function dropPool(wsId, serverId) {
  const p = pools.get(poolKey(wsId, serverId));
  if (p) { pools.delete(poolKey(wsId, serverId)); p.close(); }
}

/** 전체 풀 종료 — 셧다운·테스트 정리용(열린 소켓이 프로세스 종료를 막지 않게). */
export async function closeConnectorPools() {
  for (const [k, p] of pools) { pools.delete(k); p.close(); }
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
}

function getPooled(wsId, serverId, url) {
  const k = poolKey(wsId, serverId);
  let entry = pools.get(k);
  const reused = !!entry;
  if (!entry) {
    entry = { client: null, tools: [], lastUsed: Date.now(), close: () => {} };
    entry.ready = (async () => {
      const client = new Client({ name: 'argo-connector', version: '1.0.0' });
      poolStats.opened += 1;
      // close는 **생성 직후** 건다 — connect 성공 후 tools/list가 실패하는 경로(구글류: 401이
      // tools/call에서야 뜬다)에서 할당을 뒤로 미루면 close가 no-op으로 남아 원격 세션(DELETE 미발송)과
      // fd가 회수되지 않는다(검수 M3 계측: 그 경로 close 0회). SDK는 connect 자체 실패만 스스로 닫는다.
      // 멱등 — ready.catch와 dropPool이 같은 엔트리를 닫으러 올 수 있다.
      let closed = false;
      entry.close = () => {
        if (closed) return;
        closed = true;
        poolStats.closed += 1;
        client.close().catch(() => {});
      };
      // headless provider — 401은 SDK가 저장 refresh 토큰으로 자동 갱신·재시도(스파이크 실증),
      // 그마저 실패하면 REAUTH가 던져져 아래 호출부가 "재연결 필요"로 강등한다.
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: makeProvider(wsId, serverId, {}) }));
      const list = await client.listTools();
      entry.client = client;
      entry.tools = list.tools ?? [];
    })();
    // 생성 실패가 풀을 오염시키지 않게 + **연결된 소켓 회수까지**. 이 핸들러가 호출부(dropPool)보다
    // 먼저 돌아 엔트리를 지우므로, 여기서 close를 안 하면 dropPool은 빈손이 되고 누수가 남는다.
    entry.ready.catch(() => { if (pools.get(k) === entry) pools.delete(k); entry.close(); });
    pools.set(k, entry);
    ensureSweeper();
  }
  entry.lastUsed = Date.now();
  return { entry, reused };
}

/* 크루·UI가 읽는 문구는 ko/en 둘 다(다국어 상시 규칙). 코드(error)는 안정 식별자로 고정하고
   사람 문구만 언어별로 — 소비자(SDK 표면·CLI 표면·설정 카드)가 회사 언어를 넘긴다. */
const MSG = {
  not_connected: {
    ko: (s) => `커넥터 '${s}'가 연결되어 있지 않습니다 — 설정에서 연결해 주세요`,
    en: (s) => `Connector '${s}' is not connected — connect it in Settings`,
  },
  not_connected_status: {
    ko: (s, d) => `커넥터 '${s}' 상태: ${d} — 설정에서 다시 연결해 주세요`,
    en: (s, d) => `Connector '${s}' status: ${d} — reconnect it in Settings`,
  },
  reauth_required: {
    ko: (s) => `커넥터 '${s}' 인증이 만료되었습니다 — 설정에서 다시 연결해 주세요`,
    en: (s) => `Connector '${s}' authorization expired — reconnect it in Settings`,
  },
  call_failed: {
    ko: (s, d) => `커넥터 호출 실패(${s}): ${d}`,
    en: (s, d) => `Connector call failed (${s}): ${d}`,
  },
  // 연결 시도 실패 — 저장 시 errorCode로 남겨 UI·크루 문구를 회사 언어로 다시 그린다(검수 2R L1:
  // 코드 없이 한국어만 저장하면 영어 모드 문구에 한국어가 그대로 보간된다).
  connect_failed: { ko: (d) => `서버에 연결할 수 없습니다: ${d}`, en: (d) => `Could not reach the server: ${d}` },
  auth_timeout: { ko: (n) => `브라우저 인가가 ${n}초 안에 완료되지 않았습니다`, en: (n) => `Authorization was not completed within ${n}s` },
  auth_denied: { ko: (d) => `인가가 거부되었습니다(${d})`, en: (d) => `Authorization was denied (${d})` },
  no_code: { ko: () => '콜백에 인가 코드가 없습니다', en: () => 'The callback did not carry an authorization code' },
  exchange_failed: { ko: (d) => `토큰 교환에 실패했습니다: ${d}`, en: (d) => `Token exchange failed: ${d}` },
  // 카탈로그에 없는 id로 연결을 시도(오래된 화면·잘못된 요청) — market.connectConnector가 던진다.
  not_in_catalog: { ko: (s) => `카탈로그에 없는 커넥터입니다: ${s}`, en: (s) => `No such connector in the catalog: ${s}` },
};
/** 사람 문구 — 안정 코드(error)와 분리해서 언어만 고른다. */
export const connectorMessage = (key, lang, ...a) => (MSG[key][lang === 'en' ? 'en' : 'ko'])(...a);
/** 실패 결과 — error는 소비자가 분기하는 안정 코드, content는 크루가 읽는 회사 언어 문구. */
const fail = (error, text) => ({ ok: false, isError: true, error, content: [{ type: 'text', text }] });

async function callViaPool(wsId, serverId, url, tool, args, retryLeft, lang) {
  const { entry, reused } = getPooled(wsId, serverId, url);
  try {
    await entry.ready;
    const r = await entry.client.callTool({ name: tool, arguments: args });
    entry.lastUsed = Date.now();
    return { ok: !r.isError, isError: !!r.isError, content: r.content ?? [] };
  } catch (e) {
    dropPool(wsId, serverId); // 죽은 연결이 풀에 남지 않게
    if (isReauthErr(e)) {
      // SDK 자동 refresh까지 실패한 최종 실패 — "재연결 필요"로 강등(조용한 무동작 금지, 설계서 §2-1).
      // 저장 error에는 코드를 같이 남긴다 — 설정 카드(US-6)가 언어에 맞게 다시 그릴 수 있게.
      await patchServer(wsId, serverId, { status: 'reauth', errorCode: 'reauth_required', error: connectorMessage('reauth_required', 'ko', serverId) });
      return fail('reauth_required', connectorMessage('reauth_required', lang, serverId));
    }
    // 유휴 서버가 끊은 stale 소켓을 재사용했을 수 있다 — 새 연결로 1회만 재시도(무한 재시도 금지).
    if (retryLeft > 0 && reused) return callViaPool(wsId, serverId, url, tool, args, retryLeft - 1, lang);
    return fail('call_failed', connectorMessage('call_failed', lang, `${serverId}/${tool}`, String(e?.message ?? e)));
  }
}

/**
 * 커넥터 도구 호출 — 러너 무관 단일 경로. 결과 정규화 { ok, content, isError }(+실패 시 error 코드).
 * 401은 SDK 자동 refresh에 맡기고(스파이크 실증) 최종 실패만 'reauth' 강등. 호출마다 원장 기록.
 */
export async function callConnectorTool(wsId, serverId, tool, args = {}, { lang = 'ko' } = {}) {
  let ok = false;
  try {
    let result;
    const rec = (await loadStore(wsId).catch(() => ({ servers: {} }))).servers[serverId];
    if (!rec?.url || rec.status === 'connecting') {
      result = fail('not_connected', connectorMessage('not_connected', lang, serverId));
    } else if (rec.status === 'reauth') {
      result = fail('reauth_required', connectorMessage('reauth_required', lang, serverId));
    } else if (rec.status !== 'connected') {
      // 저장된 ko 문구를 그대로 끼워 넣으면 영어 모드에 한국어가 샌다 — 코드가 있으면 요청 언어로 다시 그린다.
      const detail = rec.errorCode && MSG[rec.errorCode] ? connectorMessage(rec.errorCode, lang, rec.errorDetail ?? '') : rec.error;
      result = fail('not_connected', connectorMessage('not_connected_status', lang, serverId, `${rec.status}${detail ? ` (${detail})` : ''}`));
    } else {
      result = await callViaPool(wsId, serverId, rec.url, tool, args, 1, lang);
    }
    ok = result.ok;
    return result;
  } finally {
    // 사용 원장 — 활동 화면 가시화(설계서 §2-1). args는 기록하지 않는다(사용자 데이터 최소 수집).
    await appendEvent(wsId, { type: 'connector', server: serverId, tool, ok });
  }
}

/** 연결된 서버의 도구 목록(tools/list 캐시 경유 — annotations 포함). 후속 스토리(SDK 표면 설명 주입·
    결재 분류)의 원료. 실패는 { ok:false, error }로 정직 반환. */
export async function listConnectorTools(wsId, serverId) {
  const rec = (await loadStore(wsId).catch(() => ({ servers: {} }))).servers[serverId];
  if (!rec?.url || rec.status !== 'connected') return { ok: false, error: 'not_connected', tools: [] };
  try {
    const { entry } = getPooled(wsId, serverId, rec.url);
    await entry.ready;
    return { ok: true, tools: entry.tools };
  } catch (e) {
    dropPool(wsId, serverId);
    if (isReauthErr(e)) {
      await patchServer(wsId, serverId, { status: 'reauth', errorCode: 'reauth_required', error: connectorMessage('reauth_required', 'ko', serverId) });
      return { ok: false, error: 'reauth_required', tools: [] };
    }
    return { ok: false, error: 'call_failed', tools: [] };
  }
}

/**
 * 연결 해제 — 저장소에서 그 서버 레코드(토큰·refresh·클라이언트 자격·verifier)를 통째로 지우고 풀을 닫는다.
 * 순서가 계약이다: **레코드 삭제가 먼저**라야 진행 중이던 호출이 저장소 게이트에서 즉시 not_connected로
 * 막히고(callConnectorTool은 매 호출 저장소를 읽는다), 그 다음 dropPool이 이미 열린 소켓·메모리 상의
 * access 토큰을 회수한다. 반대로 하면 닫은 직후 다른 호출이 살아있는 레코드로 풀을 다시 연다.
 * 원격 서버측 토큰 폐기(revocation)는 하지 않는다 — RFC 7009 지원이 서버마다 갈려 "지운 척"이 되기 쉽다.
 * 사용자에겐 이 기기에서 자격이 사라지는 것으로 정직하게 표기한다(재연결하면 다시 동의 화면).
 */
export async function disconnectConnector(wsId, serverId) {
  const existed = await withLock(`connector:${wsId}`, async () => {
    const s = await loadStore(wsId);
    // hasOwn — `in`은 프로토타입 체인을 타서 'toString'·'__proto__' 같은 이름에 "지웠다"는 거짓 성공과
    // 불필요한 0600 파일 재기록을 만든다(분리 검수 F1 실측, DELETE 쿼리로 도달 가능).
    if (!Object.hasOwn(s.servers, serverId)) return false;
    delete s.servers[serverId];
    await writeJsonAtomic(storeFile(wsId), s);
    return true;
  });
  dropPool(wsId, serverId);
  // 한 번 더 쓸어낸다 — 순서(레코드 삭제 → 정리)는 경합 창을 **좁힐 뿐 없애지 못한다**: 호출이
  // 삭제 직전에 저장소를 읽고 dropPool 직후에 풀을 조회하면 올바른 순서에서도 새 풀이 열린다
  // (창은 fs 읽기 완료와 그 continuation 디큐 사이의 마이크로태스크 여러 홉이다 — CI가 실제로 밟았고,
  //  검수가 지연 주입으로 6/6 재현했다).
  // **이 재회수의 하중은 무보호 서버(위 authUrl:null 경로)다.** 인증이 필요한 서버라면 창에서 열린
  // 풀은 삭제 이후라 토큰을 못 찾아 auth가 실패하고 entry.ready.catch가 스스로 닫는다(검수 실측:
  // 경합 결과 reauth_required·closed 델타 2). 무보호 서버는 그 자멸이 없어 정상 연결된 풀이
  // 유휴 소거(5분)까지 살아남는다 — 그 경로를 이 한 줄이 막는다. 비용은 마이크로태스크 1홉 + 멱등 no-op.
  await Promise.resolve();
  dropPool(wsId, serverId);
  return { ok: true, removed: existed };
}

/** 회사의 커넥터 연결 상태 목록 — 시크릿 무노출(토큰·verifier 미포함). UI 폴링·상태 표시용. */
export async function listConnections(wsId) {
  const s = await loadStore(wsId).catch(() => ({ servers: {} }));
  return Object.entries(s.servers).map(([id, r]) => ({
    id,
    url: r.url,
    status: r.status ?? 'error',
    hasTokens: !!r.tokens?.access_token,
    // errorCode = 설정 카드(US-6)가 회사 언어로 다시 그릴 안정 코드. error는 상세(벤더 원문 포함 가능).
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    ...(r.error ? { error: r.error } : {}),
  }));
}
