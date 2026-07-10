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
import { appendUsage, monthCost } from './usage.mjs';
import { loadCompany } from './workspace.mjs';
import { listAgents } from './hub.mjs';
import { addApproval } from './approvals.mjs';
import { appendEvent } from './events.mjs';
import { loadCapabilities } from './capabilities.mjs';
import { makePermissionGate } from './permission-gate.mjs';
import { setTurnStatus, clearTurnStatus, stageForTool, detailForTool } from './turn-status.mjs';
import { externalExec, glmEnv, GLM_DEFAULT_MODEL, RUNNERS } from './runners.mjs';
import { loadThread } from './thread.mjs';

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
        const delegated = `(동료 ${fromName}의 위임) ${task}`;
        const r = await chat(wsId, target.slug, delegated, null, { from: fromSlug });
        // 위임 트레이스 — 대상 크루의 대화에도 남긴다(세션은 건드리지 않음). 웹에서 양쪽 다 보인다.
        const { appendTurn } = await import('./thread.mjs');
        await appendTurn(wsId, target.slug, { userMsg: delegated, reply: r.reply, handover: r.handover, sessionId: null })
          .catch(() => {});
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
 * opts.attachments: [{ rel, name, mime, isImage }] — vault/files/ 아래 저장된 첨부.
 *   이미지는 SDK content 블록으로 크루가 직접 보고, 그 외 파일은 경로를 알려 Read로 열게 한다.
 * 반환: { reply, sessionId, handover } — handover에 자동링크 결과 포함.
 */
export async function chat(wsId, agentSlug, userMsg, sessionId = null, { from = null, source = null, attachments = [] } = {}) {
  const p = paths(wsId);
  // 월 예산 상한 — 초과하면 턴 자체를 시작하지 않는다(오픈클로 "자는 동안 $20" 방지)
  const { budgetUsd } = await loadCompany(wsId).catch(() => ({}));
  if (budgetUsd > 0) {
    const spent = await monthCost(wsId);
    if (spent >= budgetUsd) {
      throw new Error(`월 예산 초과: $${spent.toFixed(2)} / $${budgetUsd} — 설정에서 예산을 올리거나 다음 달을 기다려 주세요`);
    }
  }
  const { md, meta } = await readAgentCard(wsId, agentSlug);
  const skills = await loadSkills(wsId);
  const runner = (meta.runner || 'claude').toLowerCase();

  // 외부 CLI 러너(Codex/Gemini) — 로컬 OAuth 로그인(구독)을 빌려 1턴 실행. 세션은 스레드 맥락으로 잇는다.
  if (runner === 'codex' || runner === 'gemini') {
    const t0 = Date.now();
    const gist = userMsg.replace(/\s+/g, ' ').trim().slice(0, 60);
    const evBase = { type: 'turn', slug: agentSlug, source: from ? 'delegate' : (source ?? 'deck'), ...(from ? { from } : {}), gist, runner };
    await setTurnStatus(wsId, agentSlug, `${RUNNERS[runner].name} 러너 실행 중`, meta.model || '');
    try {
      const { messages } = await loadThread(wsId, agentSlug);
      const ctx = (messages ?? []).slice(-6)
        .map((m) => `${m.who === 'user' ? '사장' : (meta.name || agentSlug)}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 500)}`)
        .join('\n');
      const attNote = attachments.length
        ? `\n\n(사장이 첨부한 파일 — 직접 읽어 참고하라: ${attachments.map((a) => `vault/${a.rel}`).join(', ')})` : '';
      // 안내 문장으로 시작 — 카드 frontmatter('---')가 맨 앞이면 CLI 인자 파서가 플래그로 오해한다
      const prompt = `다음은 너의 페르소나 카드와 운영 규칙이다.

${systemPromptFor(md, p.root, skills)}
${ctx ? `\n## 최근 대화\n${ctx}\n` : ''}
## 사장의 새 지시
${userMsg}${attNote}

(너는 위 페르소나의 크루로서 한국어로 답하라. 되돌리기 어렵거나 회사 밖으로 나가는 행동은 실행하지 말고 "결재가 필요하다"고 보고만 하라.)`;
      const reply = await externalExec({ runner, model: meta.model || '', cwd: p.root, prompt });
      if (!reply) throw new Error(`${RUNNERS[runner].name} 러너가 빈 응답을 반환했습니다`);
      await appendUsage(wsId, {
        kind: from ? 'delegate' : (source ?? 'chat'), slug: agentSlug, from,
        model: `${runner}${meta.model ? `:${meta.model}` : ''}`, usage: {}, costUsd: null, ms: Date.now() - t0,
      });
      await clearTurnStatus(wsId, agentSlug);
      const handover = await saveHandover(wsId, agentSlug, userMsg, reply, meta.name || agentSlug);
      await appendEvent(wsId, { ...evBase, ok: true, ms: Date.now() - t0, journalRel: relative(p.vault, handover.file) });
      return { reply, sessionId: null, handover };
    } catch (e) {
      await appendEvent(wsId, { ...evBase, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) });
      await clearTurnStatus(wsId, agentSlug);
      throw e;
    }
  }
  // 설치된 MCP 도구 — 서버 단위 allow(mcp__<name>)로 해당 서버의 전체 도구 허용
  const { servers } = await loadMcp(wsId);
  const mcpAllow = Object.keys(servers ?? {}).map((n) => `mcp__${n}`);

  // 크루 도구 — 결재 요청은 모든 턴, 위임은 최상위 턴 + 동료가 있을 때만(연쇄 위임 금지)
  const colleagues = from ? [] : (await listAgents(wsId)).filter((a) => a.slug !== agentSlug);
  const crewServer = makeCrewServer(wsId, agentSlug, meta.name || agentSlug, colleagues);

  // 로컬 능력 — 전부 opt-in. bypass가 꺼져 있으면 부작용 도구는 allowedTools에서 빼고
  // canUseTool 게이트가 전권 판정한다(사전 승인 목록에 든 도구는 게이트를 타지 않으므로).
  const caps = await loadCapabilities(wsId);
  const readTools = ['Read', 'Glob', 'Grep', ...(caps.browser ? ['WebFetch', 'WebSearch'] : []), ...mcpAllow, 'mcp__crew'];
  const sideTools = ['Write', ...(caps.fs ? ['Edit'] : []), ...(caps.shell ? ['Bash'] : [])];
  const capPrompt = `\n## 로컬 능력 — 회사 설정이 허용한 범위
- 파일 시스템(워크스페이스 밖): ${caps.fs ? '허용 — 신중하게, 파괴적 변경은 결재를 먼저 올려라' : '꺼짐 — vault 밖의 파일은 읽지도 쓰지도 마라'}
- 웹 브라우징: ${caps.browser ? '허용(WebFetch/WebSearch)' : '꺼짐'}
- 셸 명령(Bash): ${caps.shell ? '허용' : '꺼짐'}
${caps.bypass ? '- 권한 우회 모드: 켜짐 — 결재 없이 실행되니 되돌릴 수 없는 명령은 스스로 한 번 더 확인하라' : '- 부작용 있는 실행은 결재 승인 후 이어진다 — 승인 대기는 정상 흐름이다'}`;

  // 첨부 — 이미지는 base64 블록으로, 문서·데이터 파일은 vault 경로로 안내(Read 열람)
  const imgAtt = attachments.filter((a) => a.isImage);
  const fileAtt = attachments.filter((a) => !a.isImage);
  let promptText = userMsg;
  if (fileAtt.length) {
    promptText += `\n\n(사장이 첨부한 파일 — Read 도구로 열람하라: ${fileAtt.map((a) => `vault/${a.rel}`).join(', ')})`;
  }
  let promptInput = promptText;
  if (imgAtt.length) {
    const blocks = [{ type: 'text', text: promptText }];
    for (const a of imgAtt) {
      const buf = await readFile(join(p.vault, a.rel));
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: buf.toString('base64') } });
    }
    promptInput = (async function* () {
      yield { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null, session_id: sessionId ?? '' };
    })();
  }

  let reply = '';
  let sid = sessionId;
  const t0 = Date.now();
  const gist = userMsg.replace(/\s+/g, ' ').trim().slice(0, 60);
  const evBase = { type: 'turn', slug: agentSlug, source: from ? 'delegate' : (source ?? 'deck'), ...(from ? { from } : {}), gist };
  await setTurnStatus(wsId, agentSlug, '시동 거는 중'); // 즉시 — SDK 부팅 전에도 살아있음을 보인다
  try {
  for await (const msg of query({
    prompt: promptInput,
    options: {
      cwd: p.root,
      systemPrompt: systemPromptFor(md, p.root, skills)
        + (colleagues.length ? rosterPrompt(colleagues) : '')
        + `\n## 결재 규칙 — 반드시 따를 것
- 되돌리기 어렵거나 회사 밖으로 나가는 행동(발송·게시·구매·삭제·계약 등)은 실행 전 request_approval 도구로 결재를 올리고, 승인 없이는 실행하지 마라.
- 초안 작성·분석·vault 기록 같은 회사 안 작업은 결재 없이 바로 한다.`
        + capPrompt,
      mcpServers: { ...(servers ?? {}), crew: crewServer },
      // GLM 러너 — Anthropic 호환 엔드포인트로 SDK를 그대로 태운다(도구·기억 파이프라인 완전 유지)
      ...(runner === 'glm' ? { env: glmEnv(), model: meta.model || GLM_DEFAULT_MODEL } : (meta.model ? { model: meta.model } : {})), // 크루별 모델 — 카드 frontmatter가 결정
      ...(caps.bypass
        ? { permissionMode: 'bypassPermissions', allowedTools: [...readTools, ...sideTools] }
        : {
            // 부작용 도구는 사전 승인 목록에서 제외 — canUseTool 게이트가 전권 판정(승인 대기 = interrupt-resume)
            permissionMode: 'default',
            allowedTools: readTools,
            canUseTool: makePermissionGate(wsId, agentSlug, caps, p.root),
          }),
      disallowedTools: [
        ...(caps.shell ? [] : ['Bash']),
        ...(caps.browser ? [] : ['WebFetch', 'WebSearch']),
      ],
      settingSources: [], // 호스트의 CLAUDE.md/스킬 미주입(테넌트 격리)
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sid = msg.session_id;
      await setTurnStatus(wsId, agentSlug, '기억을 살피는 중');
    }
    if (msg.type === 'assistant') {
      const tu = (msg.message?.content ?? []).find((b) => b.type === 'tool_use');
      await setTurnStatus(
        wsId, agentSlug,
        tu ? stageForTool(tu.name) : '생각을 정리하는 중',
        tu ? detailForTool(tu.name, tu.input) : '',
      );
    }
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
    await clearTurnStatus(wsId, agentSlug);
    throw e;
  }
  await clearTurnStatus(wsId, agentSlug);

  const handover = await saveHandover(wsId, agentSlug, userMsg, reply, meta.name || agentSlug);
  await appendEvent(wsId, {
    ...evBase, ok: true, ms: Date.now() - t0,
    journalRel: relative(p.vault, handover.file), // 산출물 — 활동 행에서 일지 원문으로 드릴다운
  });
  return { reply, sessionId: sid, handover };
}
