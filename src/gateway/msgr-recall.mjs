// 에이전트 기억 회수(유건 결정 2026-10-03) — 에이전트는 한 사람이다. 채널·조직에서 빠지면 그 채널 기억을 이 PC에서 지운다.
// 판정은 서버가 **명시적으로** "이 에이전트는 이 채널에 없다"(msgr_crew_presence → false)고 답한 채널만. 조회 실패·옛 서버·답에 없는 채널은 아무것도 지우지 않는다.
// 지우는 것: 대화 파일(활성·보관·보관함)의 그 채널 줄과 채널 세션(+ 각인), 그 세션의 모델 전사 파일, 옛 채널 일지(.msgr-journal).
// 서버 기억(msgr_crew_memory)은 채널 소속일 때만 실리므로 따로 지울 것이 없다.
import { readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../workspace.mjs';
import { readJson } from '../jsonstore.mjs';
import { threadChannelIds, forgetThreadChannels, takeChannelSessions, channelSessionIds } from '../thread.mjs';
import { sessionFile } from '../engine/session.mjs';
import { appendEvent } from '../events.mjs';
import { CHANNEL_ID } from '../departed.mjs';

const HOME_DIR = () => process.env.HOME || process.env.USERPROFILE || ''; // homedir() 금지 — Next 파일 추적이 홈 전체를 훑는다(nft-homedir-guard)
const JOURNAL = /^\d{4}-\d{2}-\d{2}-(.+)\.org-[0-9a-f-]{36}-ch-([0-9a-f-]{36})\.md$/i;

/** SDK 세션 전사가 놓이는 설정 폴더 후보 — 호스트(CLAUDE_CONFIG_DIR 또는 ~/.claude)와 호환 러너 격리 폴더(~/.argo/claude-config-*). */
export async function sdkConfigDirs() {
  const out = new Set();
  if (process.env.CLAUDE_CONFIG_DIR) out.add(process.env.CLAUDE_CONFIG_DIR);
  const h = HOME_DIR();
  if (h) {
    out.add(join(h, '.claude'));
    try { for (const n of await readdir(join(h, '.argo'))) if (n.startsWith('claude-config-')) out.add(join(h, '.argo', n)); } catch { /* 없음 */ }
  }
  return [...out];
}

/** 지운 세션의 전사 파일 — 네이티브 엔진(크루당 한 파일, 그 id일 때만)과 SDK(<설정>/projects/<작업 폴더>/<세션 uuid>.jsonl·같은 이름 폴더). 정확한 uuid 이름만 지운다. */
export async function dropTranscripts(wsId, slug, sessionIds, { configDirs } = {}) {
  if (!sessionIds?.length) return 0;
  let n = 0;
  const nf = sessionFile(wsId, slug);
  const saved = await readJson(nf, null).catch(() => null);
  if (saved?.id && sessionIds.includes(saved.id)) { await rm(nf, { force: true }); n++; }
  const uuids = sessionIds.filter((id) => CHANNEL_ID.test(String(id)));
  if (!uuids.length) return n;
  for (const dir of configDirs ?? await sdkConfigDirs()) {
    let projects = [];
    try { projects = await readdir(join(dir, 'projects')); } catch { continue; }
    for (const p of projects) for (const id of uuids) {
      for (const f of [join(dir, 'projects', p, `${id}.jsonl`), join(dir, 'projects', p, id)]) if (existsSync(f)) { await rm(f, { recursive: true, force: true }); n++; }
    }
  }
  return n;
}

async function journalNames(wsId) {
  try { return await readdir(join(paths(wsId).root, '.msgr-journal')); } catch { return []; }
}
const journalOf = (name, slug) => { const m = name.match(JOURNAL); return m && m[1] === slug ? m[2].toLowerCase() : null; };

/** 회수 한 바퀴 — slugs = 이 회사에서 메신저에 나간 에이전트. presence(pairs[{slug, id}]) → Map(`slug:channelId` → 소속 여부) | null.
    회사당 한 번에 묻는다(설계 검수 M8). 로컬에 채널 기록이 없으면 묻지 않는다(호출 0). */
export async function recallDeparted(wsId, slugs, presence, { configDirs } = {}) {
  const sum = { removed: 0, transcripts: 0, journals: 0, channels: 0 };
  const names = await journalNames(wsId);
  const want = new Map(); // slug → Set(channelId)
  for (const slug of new Set(slugs)) {
    const ids = new Set(await threadChannelIds(wsId, slug).catch(() => []));
    for (const c of await channelSessionIds(wsId, slug)) if (CHANNEL_ID.test(c)) ids.add(c);
    for (const n of names) { const c = journalOf(n, slug); if (c) ids.add(c); }
    if (ids.size) want.set(slug, ids);
  }
  const pairs = [...want].flatMap(([slug, ids]) => [...ids].map((id) => ({ slug, id })));
  if (!pairs.length) return sum;
  const ans = await presence(pairs).catch(() => null);
  if (!(ans instanceof Map)) return sum; // 조회 실패·옛 서버 — 아무것도 지우지 않는다
  for (const [slug, ids] of want) {
    const gone = [...ids].filter((id) => ans.get(`${slug}:${id}`) === false);
    if (!gone.length) continue;
    const r = await forgetThreadChannels(wsId, slug, gone);
    const sids = [...new Set([...r.sessionIds, ...await takeChannelSessions(wsId, slug, gone)])];
    const transcripts = await dropTranscripts(wsId, slug, sids, { configDirs });
    let journals = 0;
    const goneSet = new Set(gone);
    for (const n of names) if (goneSet.has(journalOf(n, slug))) { await rm(join(paths(wsId).root, '.msgr-journal', n), { force: true }); journals++; }
    sum.removed += r.removed; sum.transcripts += transcripts; sum.journals += journals; sum.channels += gone.length;
    await appendEvent(wsId, { type: 'memory', op: 'recall', agent: slug, channels: gone.length, removed: r.removed, transcripts, journals }); // 본문 없이 개수만
  }
  return sum;
}
