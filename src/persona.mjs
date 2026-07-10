// 한 줄 프롬프트 → 페르소나 카드(md frontmatter + 본문) 자동 생성 — 기둥 2.
// 카드가 곧 시스템 프롬프트: 사용자가 파일을 열어 언제든 고칠 수 있다(투명성).
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { paths } from './workspace.mjs';

const CARD_PROMPT = (oneLiner) => `다음 한 줄 요청으로 AI 직원의 페르소나 카드를 작성해줘.

요청: "${oneLiner}"

정확히 아래 형식의 마크다운만 출력해(설명·코드펜스 금지):

---
name: <한글 이름 2-3자, 사람 이름처럼>
slug: <영문 소문자 슬러그>
role: <직함 한 줄>
---

# <이름> — <직함>

## 전문성
(이 직원이 깊게 아는 영역 3-5개, 불릿)

## 일하는 방식
(산출물 형식·품질 기준·확인 습관, 불릿 3-4개)

## 톤
(사용자와 대화할 때의 말투 한 줄)`;

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return meta;
}

/** Agent SDK 단일 턴으로 카드 생성 → agents/<slug>.md 저장. */
export async function createAgentFromPrompt(wsId, oneLiner) {
  let out = '';
  for await (const msg of query({
    prompt: CARD_PROMPT(oneLiner),
    options: {
      cwd: paths(wsId).root,
      allowedTools: [], // 순수 생성 — 도구 불필요
      settingSources: [], // 호스트 머신의 CLAUDE.md 등 미주입(테넌트 격리)
      maxTurns: 1,
    },
  })) {
    if (msg.type === 'result' && msg.subtype === 'success') out = msg.result;
  }
  const md = out.trim().replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '');
  const meta = parseFrontmatter(md);
  if (!meta.slug || !meta.name) throw new Error(`카드 생성 실패 — frontmatter 누락:\n${md.slice(0, 200)}`);
  const slug = meta.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const file = join(paths(wsId).agents, `${slug}.md`);
  await writeFile(file, md.endsWith('\n') ? md : `${md}\n`);
  return { slug, name: meta.name, role: meta.role || '', file };
}

export async function readAgentCard(wsId, slug) {
  const md = await readFile(join(paths(wsId).agents, `${slug}.md`), 'utf8');
  return { md, meta: parseFrontmatter(md) };
}
