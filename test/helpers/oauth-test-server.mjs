// OAuth 2.1 자동승인 테스트 MCP 서버 — 스파이크 실증 코드(oauth-spike/test-server.mjs)의 정식 승격.
// SDK 1.30.0 server/auth 빌딩블록으로 AS(인가서버)+RS(MCP 리소스서버)를 한 오리진에 세운다.
// authorize가 **자동 승인**(사람 동의 화면 없음)이라 브라우저·실계정 0으로 CI에서 OAuth 왕복
// (디스커버리→DCR→PKCE→토큰→도구 호출→refresh 갱신)을 행동 테스트할 수 있다.
// 실서버에선 자동 승인 지점이 "사용자 브라우저 + 로그인·동의 화면"으로 치환된다.
//
// express는 @modelcontextprotocol/sdk의 자체 의존성(mcpAuthRouter가 express Router를 반환) —
// devDependencies에도 명시해 해석을 잠근다. 픽스처 토큰·키는 전부 이 자리에서 난수 생성한 더미다(실키 0).
import http from 'node:http';
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { z } from 'zod';

/**
 * 테스트 서버 기동. 반환: { base, mcpUrl, close(), registerClient(info), revokeRefresh(),
 * counters: { dcr, codeGrants, refreshGrants, toolCalls } } — counters는 라이브 객체(테스트가 직접 읽는다).
 * toolCalls[name] = 그 도구가 **실제로 실행된 횟수**. 결재 게이트가 부작용을 정말 막았는지 재는 유일한 근거다.
 * accessTtlMs를 짧게 주면 만료→자동 refresh 시나리오를 실시간으로 돌릴 수 있다.
 */
export async function startOauthTestServer({ accessTtlMs = 3_600_000 } = {}) {
  // 포트 0 임의 배정 — BASE(issuerUrl)가 라우터 구성보다 먼저 필요하므로, http 서버를 먼저 listen하고
  // 실제 포트를 안 뒤 express 앱을 request 핸들러로 붙인다(선점 경쟁 없음).
  const srv = http.createServer();
  await new Promise((resolve, reject) => { srv.on('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${srv.address().port}`;

  // ── 인메모리 OAuthServerProvider(덕타이핑 — SDK examples의 demoInMemoryOAuthProvider 상당) ──
  const clients = new Map(); // client_id → client info (DCR 산출 또는 registerClient 주입)
  const codes = new Map(); // code → { clientId, codeChallenge, redirectUri, scopes }
  const access = new Map(); // token → { clientId, scopes, expiresAt(ms) }
  const refresh = new Map(); // token → { clientId, scopes }
  const counters = { dcr: 0, codeGrants: 0, refreshGrants: 0, toolCalls: {} };
  const ran = (name) => { counters.toolCalls[name] = (counters.toolCalls[name] ?? 0) + 1; };
  const knobs = { failToolsList: false }; // 런타임 토글(테스트가 연결 후에 켠다)

  const provider = {
    clientsStore: {
      async getClient(id) { return clients.get(id); },
      async registerClient(meta) { // RFC 7591 동적 클라이언트 등록
        const info = { ...meta, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
        clients.set(info.client_id, info);
        counters.dcr += 1;
        return info;
      },
    },
    async authorize(client, params, res) { // 자동 승인 — 실서버에선 사람 동의 화면
      const code = randomBytes(16).toString('hex');
      codes.set(code, { clientId: client.client_id, codeChallenge: params.codeChallenge, redirectUri: String(params.redirectUri), scopes: params.scopes ?? [] });
      const url = new URL(String(params.redirectUri));
      url.searchParams.set('code', code);
      if (params.state) url.searchParams.set('state', params.state);
      res.redirect(url.toString());
    },
    async challengeForAuthorizationCode(_client, code) { // PKCE 대조는 SDK tokenHandler가 수행
      return codes.get(code)?.codeChallenge;
    },
    async exchangeAuthorizationCode(client, code) {
      const rec = codes.get(code);
      codes.delete(code); // 1회용
      if (!rec || rec.clientId !== client.client_id) throw new Error('invalid authorization code');
      const at = randomBytes(24).toString('hex');
      const rt = randomBytes(24).toString('hex');
      access.set(at, { clientId: client.client_id, scopes: rec.scopes, expiresAt: Date.now() + accessTtlMs });
      refresh.set(rt, { clientId: client.client_id, scopes: rec.scopes });
      counters.codeGrants += 1;
      return { access_token: at, token_type: 'bearer', expires_in: Math.floor(accessTtlMs / 1000), refresh_token: rt, scope: rec.scopes.join(' ') };
    },
    async exchangeRefreshToken(client, refreshToken) {
      const rec = refresh.get(refreshToken);
      if (!rec || rec.clientId !== client.client_id) throw new Error('invalid refresh token');
      const at = randomBytes(24).toString('hex');
      access.set(at, { clientId: client.client_id, scopes: rec.scopes, expiresAt: Date.now() + accessTtlMs });
      counters.refreshGrants += 1;
      return { access_token: at, token_type: 'bearer', expires_in: Math.floor(accessTtlMs / 1000), scope: rec.scopes.join(' ') };
    },
    async verifyAccessToken(token) {
      const rec = access.get(token);
      if (!rec || rec.expiresAt < Date.now()) throw new InvalidTokenError('access token expired or unknown');
      return { token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: Math.floor(rec.expiresAt / 1000) };
    },
  };

  // ── MCP 리소스 서버(무상태 — 요청마다 서버·트랜스포트 생성, SDK 문서의 stateless 패턴) ──
  // 도구 3종 = 결재 분류 3계급의 원료: 읽기 annotation / 쓰기 annotation / annotation 없음(이름 휴리스틱 대상).
  function buildMcp() {
    const s = new McpServer({ name: 'oauth-test-server', version: '0.0.1' });
    s.registerTool('search_threads_demo', {
      description: '데모 검색(읽기) — annotations.readOnlyHint=true',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    }, async ({ query }) => { ran('search_threads_demo'); return { content: [{ type: 'text', text: `demo results for "${query}": [t1, t2]` }] }; });
    s.registerTool('send_mail_demo', {
      description: '데모 발송(쓰기) — annotations.readOnlyHint=false',
      inputSchema: { to: z.string(), body: z.string() },
      annotations: { readOnlyHint: false },
    }, async ({ to }) => { ran('send_mail_demo'); return { content: [{ type: 'text', text: `demo mail queued to ${to}` }] }; });
    s.registerTool('create_draft_demo', {
      description: '데모 초안 생성(쓰기, annotations 미제공)',
      inputSchema: { subject: z.string() },
    }, async ({ subject }) => { ran('create_draft_demo'); return { content: [{ type: 'text', text: `demo draft "${subject}" created` }] }; });
    return s;
  }

  const app = express();
  app.use(express.json());
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(base),
    resourceServerUrl: new URL(`${base}/mcp`),
    scopesSupported: ['spike.read', 'spike.write'],
    resourceName: 'oauth-test-server',
  }));
  app.post('/mcp', requireBearerAuth({ verifier: provider }), async (req, res) => {
    // tools/list만 골라 5xx로 떨어뜨리는 노브 — "connect는 성공했는데 tools/list가 실패"하는 경로
    // (구글류: 401이 tools/call에서야 뜬다)의 자원 회수를 테스트가 관측하기 위한 것.
    if (knobs.failToolsList && req.body?.method === 'tools/list') {
      res.status(500).json({ jsonrpc: '2.0', id: req.body.id ?? null, error: { code: -32000, message: 'tools/list unavailable (test knob)' } });
      return;
    }
    const server = buildMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  srv.on('request', app);

  return {
    base,
    mcpUrl: `${base}/mcp`,
    counters,
    /** 사전 등록 클라이언트 주입 — DCR 미지원 서버(구글류) 대역. redirect_uris는 호출측이 안 뒤 넣는다. */
    registerClient(info) { clients.set(info.client_id, info); },
    /** tools/list만 5xx로 — 연결 성공 후 목록 실패 경로(자원 회수 관측)용. */
    setFailToolsList(v) { knobs.failToolsList = !!v; },
    /** 모든 refresh 토큰 폐기 — "refresh 실패 → 재연결 필요 강등" 시나리오용. */
    revokeRefresh() { refresh.clear(); },
    close() { return new Promise((r) => srv.close(r)); },
  };
}
