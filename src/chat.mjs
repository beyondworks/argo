// 대화 계층 — 페르소나 카드 + 회사 스킬 + vault 사용법을 시스템 프롬프트로, Agent SDK가 루프·도구를 담당.
// 도구는 워크스페이스 안 파일 읽기/쓰기/검색만 — 폴더 전체가 잠재 컨텍스트, 링크가 탐색 경로.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { paths } from './workspace.mjs';
import { readAgentCard } from './persona.mjs';
import { saveHandover } from './memory.mjs';
import { loadMcp } from './market.mjs';
import { appendUsage } from './usage.mjs';
import { listAgents } from './hub.mjs';
import { addApproval } from './approvals.mjs';
import { appendEvent } from './events.mjs';

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

/** 동료 명단 + 위임 규칙 — 위임 도구가 붙는 턴에만 주입한다. */
function rosterPrompt(colleagues) {
  const lines = colleagues.map((a) => `- ${a.name} (slug: ${a.slug})${a.role ? ` — ${a.role}` : ''}${a.team ? ` / ${a.team}팀` : ''}`);
  return `
## 동료 크루 — 위임 규칙
${lines.join('\n')}
- 네 전문 밖이거나 동료가 명백히 더 잘할 하위 작업은 delegate 도구(to=슬러그, task=구체적 지시)로 위임하라.
- 위임 결과는 그대로 붙이지 말고 검토해 네 답에 통합하고, 어느 동료의 작업인지 밝혀라.
- 남발 금지 — 네가 직접 할 수 있으면 직접 한다. 위임은 턴당 최대 2회.`;
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

/** 크루 도구 서버 — delegate(최상위 턴만) + request_approval(항상). */
function makeCrewServer(wsId, fromSlug, fromName, colleagues) {
  const text = async (t) => ({ content: [{ type: 'text', text: t }] });

  const requestApproval = tool(
    'request_approval',
    '되돌리기 어렵거나 회사 밖으로 나가는 행동(발송·게시·구매·삭제·계약 등)을 실행하기 전에 사장의 결재를 요청한다. action은 하려는 행동 한 문장, reason은 왜 필요한지.',
    { action: z.string(), reason: z.string() },
    async ({ action, reason }) => {
      const item = await addApproval(wsId, { slug: fromSlug, action, reason });
      return text(`결재 요청이 등록되었다(${item.id}). 승인 전에는 절대 그 행동을 실행하지 마라. 지금은 "결재를 올렸고 승인되면 진행하겠다"고 사용자에게 알리고 턴을 마무리하라.`);
    },
  );

  let used = 0;
  const delegate = tool(
    'delegate',
    '동료 크루에게 하위 작업을 위임하고 결과를 받는다. to는 동료의 slug, task는 그 동료가 단독으로 수행할 수 있는 구체적 지시.',
    { to: z.string(), task: z.string() },
    async ({ to, task }) => {
      if (used >= 2) return text('위임 한도 초과 — 이번 턴은 남은 작업을 직접 마무리하라.');
      const key = to.trim().toLowerCase();
      const target = colleagues.find((a) => a.slug === key || a.name.toLowerCase() === key);
      if (!target) return text(`"${to}"는 동료 명단에 없다. 가능한 slug: ${colleagues.map((a) => a.slug).join(', ')}`);
      used += 1;
      try {
        const r = await chat(wsId, target.slug, `(동료 ${fromName}의 위임) ${task}`, null, { from: fromSlug });
        return text(`[${target.name}의 작업 결과]\n${r.reply}`);
      } catch (e) {
        return text(`위임 실패(${target.name}): ${String(e.message || e)}`);
      }
    },
  );
  return createSdkMcpServer({
    name: 'crew', version: '1.0.0',
    tools: [requestApproval, ...(colleagues.length ? [delegate] : [])],
  });
}

/**
 * 한 턴 대화. sessionId를 주면 이어서(resume), 없으면 새 세션.
 * opts.from이 있으면 위임받은 하위 턴 — 위임 도구를 붙이지 않는다(연쇄 위임 금지).
 * opts.source: 'routine'|'messenger' — 활동 타임라인에 턴의 출처를 남긴다.
 * 반환: { reply, sessionId, handover } — handover에 자동링크 결과 포함.
 */
export async function chat(wsId, agentSlug, userMsg, sessionId = null, { from = null, source = null } = {}) {
  const p = paths(wsId);
  const { md, meta } = await readAgentCard(wsId, agentSlug);
  const skills = await loadSkills(wsId);
  // 설치된 MCP 도구 — 서버 단위 allow(mcp__<name>)로 해당 서버의 전체 도구 허용
  const { servers } = await loadMcp(wsId);
  const mcpAllow = Object.keys(servers ?? {}).map((n) => `mcp__${n}`);

  // 크루 도구 — 결재 요청은 모든 턴, 위임은 최상위 턴 + 동료가 있을 때만(연쇄 위임 금지)
  const colleagues = from ? [] : (await listAgents(wsId)).filter((a) => a.slug !== agentSlug);
  const crewServer = makeCrewServer(wsId, agentSlug, meta.name || agentSlug, colleagues);

  let reply = '';
  let sid = sessionId;
  const t0 = Date.now();
  const gist = userMsg.replace(/\s+/g, ' ').trim().slice(0, 60);
  const evBase = { type: 'turn', slug: agentSlug, source: from ? 'delegate' : (source ?? 'deck'), ...(from ? { from } : {}), gist };
  try {
  for await (const msg of query({
    prompt: userMsg,
    options: {
      cwd: p.root,
      systemPrompt: systemPromptFor(md, p.root, skills)
        + (colleagues.length ? rosterPrompt(colleagues) : '')
        + `\n## 결재 규칙 — 반드시 따를 것
- 되돌리기 어렵거나 회사 밖으로 나가는 행동(발송·게시·구매·삭제·계약 등)은 실행 전 request_approval 도구로 결재를 올리고, 승인 없이는 실행하지 마라.
- 초안 작성·분석·vault 기록 같은 회사 안 작업은 결재 없이 바로 한다.`,
      mcpServers: { ...(servers ?? {}), crew: crewServer },
      allowedTools: ['Read', 'Glob', 'Grep', 'Write', ...mcpAllow, 'mcp__crew'],
      ...(meta.model ? { model: meta.model } : {}), // 크루별 모델 — 카드 frontmatter가 결정
      permissionMode: 'bypassPermissions', // 스파이크 한정 — 프로덕션은 워크스페이스 샌드박스+훅 게이트
      settingSources: [], // 호스트의 CLAUDE.md/스킬 미주입(테넌트 격리)
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })) {
    if (msg.type === 'system' && msg.subtype === 'init') sid = msg.session_id;
    if (msg.type === 'result') {
      sid = msg.session_id ?? sid;
      // 토큰 사용량 기록 — 대시보드 효율 지표(캐시 적중률·턴당 비용)의 원천.
      // 위임받은 턴은 kind:delegate + from — 그래프 크루↔크루 엣지·활동 피드의 원천이 된다.
      await appendUsage(wsId, {
        kind: from ? 'delegate' : (source ?? 'chat'), slug: agentSlug, from, model: meta.model,
        usage: msg.usage, costUsd: msg.total_cost_usd, ms: Date.now() - t0,
      });
      if (msg.subtype === 'success') reply = msg.result;
      else throw new Error(`턴 실패: ${msg.subtype}`);
    }
  }
  } catch (e) {
    // 실패도 회사의 사건이다 — 활동 화면의 "오류" 필터가 이 기록을 먹는다
    await appendEvent(wsId, { ...evBase, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) });
    throw e;
  }

  const handover = await saveHandover(wsId, agentSlug, userMsg, reply, meta.name || agentSlug);
  await appendEvent(wsId, {
    ...evBase, ok: true, ms: Date.now() - t0,
    journalRel: relative(p.vault, handover.file), // 산출물 — 활동 행에서 일지 원문으로 드릴다운
  });
  return { reply, sessionId: sid, handover };
}
