// 대화 계층 — 페르소나 카드 + 회사 스킬 + vault 사용법을 시스템 프롬프트로, Agent SDK가 루프·도구를 담당.
// 도구는 워크스페이스 안 파일 읽기/쓰기/검색만 — 폴더 전체가 잠재 컨텍스트, 링크가 탐색 경로.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { paths } from './workspace.mjs';
import { readAgentCard } from './persona.mjs';
import { saveHandover } from './memory.mjs';
import { loadMcp } from './market.mjs';
import { appendUsage } from './usage.mjs';

/** 회사 스킬(skills/*.md) — 지시형 md를 시스템 프롬프트에 주입 (기둥 3). 총량 캡으로 폭주 방지. */
async function loadSkills(wsId, cap = 6000) {
  const dir = paths(wsId).skills;
  let names = [];
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort(); } catch { return ''; }
  let out = '';
  for (const n of names) {
    const text = await readFile(join(dir, n), 'utf8');
    if (out.length + text.length > cap) break;
    out += `\n### 스킬: ${n.replace(/\.md$/, '')}\n${text.trim()}\n`;
  }
  return out;
}

function systemPromptFor(cardMd, wsRoot, skills) {
  return `${cardMd}
${skills ? `\n## 회사 스킬 — 해당 작업 시 아래 지침을 따른다\n${skills}` : ''}
## 회사 기억(vault) 사용법 — 반드시 따를 것
- 너의 회사 기억은 ${wsRoot}/vault 폴더 전체다. 새 작업을 시작하면 먼저 vault/_index.md를 읽고,
  관련 [[링크]]를 따라 필요한 문서만 읽어 맥락을 확보하라.
- 과거 맥락을 근거로 답할 때는 어느 기록에서 왔는지 파일명을 짧게 언급하라.
- 작업 중 얻은 재사용 가치가 있는 지식은 vault/notes/에 md로 남겨라(파일명: 주제-슬러그.md).
- vault 밖의 파일은 읽지도 쓰지도 마라.`;
}

/**
 * 한 턴 대화. sessionId를 주면 이어서(resume), 없으면 새 세션.
 * 반환: { reply, sessionId, handover } — handover에 자동링크 결과 포함.
 */
export async function chat(wsId, agentSlug, userMsg, sessionId = null) {
  const p = paths(wsId);
  const { md, meta } = await readAgentCard(wsId, agentSlug);
  const skills = await loadSkills(wsId);
  // 설치된 MCP 도구 — 서버 단위 allow(mcp__<name>)로 해당 서버의 전체 도구 허용
  const { servers } = await loadMcp(wsId);
  const mcpAllow = Object.keys(servers ?? {}).map((n) => `mcp__${n}`);

  let reply = '';
  let sid = sessionId;
  const t0 = Date.now();
  for await (const msg of query({
    prompt: userMsg,
    options: {
      cwd: p.root,
      systemPrompt: systemPromptFor(md, p.root, skills),
      ...(mcpAllow.length ? { mcpServers: servers } : {}),
      allowedTools: ['Read', 'Glob', 'Grep', 'Write', ...mcpAllow],
      permissionMode: 'bypassPermissions', // 스파이크 한정 — 프로덕션은 워크스페이스 샌드박스+훅 게이트
      settingSources: [], // 호스트의 CLAUDE.md/스킬 미주입(테넌트 격리)
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })) {
    if (msg.type === 'system' && msg.subtype === 'init') sid = msg.session_id;
    if (msg.type === 'result') {
      sid = msg.session_id ?? sid;
      // 토큰 사용량 기록 — 대시보드 효율 지표(캐시 적중률·턴당 비용)의 원천
      await appendUsage(wsId, {
        kind: 'chat', slug: agentSlug,
        usage: msg.usage, costUsd: msg.total_cost_usd, ms: Date.now() - t0,
      });
      if (msg.subtype === 'success') reply = msg.result;
      else throw new Error(`턴 실패: ${msg.subtype}`);
    }
  }

  const handover = await saveHandover(wsId, agentSlug, userMsg, reply, meta.name || agentSlug);
  return { reply, sessionId: sid, handover };
}
