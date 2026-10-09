// 가드(installAgentPeerGuard) 아래에서 실제 크루·브라우저 도구 중계 다리가 자손(러너 CLI)의 호출을 받는가.
// HIGH-1 회귀 방지: 중계 서버에 PEER_GUARD_EXEMPT가 없으면 러너 CLI 자식(=서버 자손)의 요청이 403 → 도구 전멸("Relay rejected tool list").
// 변이 M7(crew-mcp의 PEER_GUARD_EXEMPT 줄 삭제)·M8(browser-mcp의 줄 삭제)이 이 시험에서 빨강이어야 한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { installAgentPeerGuard } from '../src/agent-peer.mjs';
import { createCrewMcpBridge } from '../src/engine/crew-mcp.mjs';
import { createBrowserMcpBridge } from '../src/engine/browser-mcp.mjs';

installAgentPeerGuard(); // 이 테스트 프로세스가 서버 자리 — 아래 execFile 자식이 서버 자손(에이전트 셸 자리)

// 자손 자식 프로세스에서 중계로 POST(토큰 포함) — 가드가 자손을 403으로 막으면 여기서 비정상 응답
const childPost = (url, token, body) => new Promise((resolve) => {
  const code = `fetch(${JSON.stringify(url)},{method:'POST',headers:{authorization:'Bearer '+${JSON.stringify(token)},'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>console.log(r.status, await r.text())).catch(e=>console.log('ERR', e.message))`;
  execFile(process.execPath, ['-e', code], { timeout: 15000 }, (e, out) => resolve(String(out).trim()));
});

test('crew-mcp 다리: 가드 아래에서도 자손 러너의 op:list·op:call이 통과(403 아님)', async () => {
  const bridge = await createCrewMcpBridge([{ name: 'argo__ping', description: 't', input_schema: { type: 'object', properties: {} }, run: async () => 'PONG-CREW' }]);
  after(() => bridge.close());
  const url = bridge.server.env.ARGO_CREW_RELAY_URL; const token = bridge.server.env.ARGO_CREW_RELAY_TOKEN;
  const list = await childPost(url, token, { op: 'list' });
  assert.match(list, /^200 /, `자손의 op:list가 막혔다(M7 회귀): ${list}`);
  assert.match(list, /argo__ping|"tools"/, list);
  const call = await childPost(url, token, { op: 'call', name: 'argo__ping', arguments: {} });
  assert.match(call, /^200 /, call);
  assert.match(call, /PONG-CREW/, call);
});

test('browser-mcp 다리: 가드 아래에서도 자손 러너의 호출이 통과(403 아님)', async () => {
  const bridge = await createBrowserMcpBridge({ wsId: 'w', slug: 'x', canUseTool: async () => ({ behavior: 'deny', message: 'no browser in test' }) });
  after(() => bridge.close());
  const url = bridge.server.env.ARGO_BROWSER_RELAY_URL; const token = bridge.server.env.ARGO_BROWSER_RELAY_TOKEN;
  // 알 수 없는 도구 → 400(Invalid browser tool). 핵심은 403(가드 거절)이 아니라는 것 — 자손이 중계에 닿았다.
  const out = await childPost(url, token, { name: 'argo_browser_open', arguments: {} });
  assert.doesNotMatch(out, /^403 /, `자손의 브라우저 중계 호출이 가드에 막혔다(M8 회귀): ${out}`);
  assert.match(out, /^(200|400) /, out);
});
