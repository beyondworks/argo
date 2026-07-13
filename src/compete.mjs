// 경쟁 시안 — 같은 지시를 크루 2~3명에게 동시에 맡기고, 시안을 나란히 비교해 사장이 채택한다.
// 현실 메타포: 경쟁 PT. 경쟁 중 산출물은 각 크루의 개인 스레드를 오염시키지 않고(격리),
// 채택된 시안만 승자 크루의 스레드에 기록으로 편입된다(기억이 되는 건 채택본뿐).
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { listAgents } from './hub.mjs';
import { chat } from './chat.mjs';
import { monthCost } from './usage.mjs';
import { appendTurn } from './thread.mjs';
import { withLock } from './mutex.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';

const ID_RE = /^[a-z0-9]{6,20}$/;
const MAX_ENTRANTS = 3; // 폭주 통제 — 비용 N배가 눈에 보이는 선에서
const MIN_ENTRANTS = 2;

const dir = (wsId) => paths(wsId).competitions;
const file = (wsId, id) => {
  if (!ID_RE.test(id)) throw new Error('잘못된 경쟁 id');
  return join(dir(wsId), `${id}.json`);
};
const lkey = (wsId, id) => `compete:${wsId}:${id}`;

async function save(wsId, comp) {
  await mkdir(dir(wsId), { recursive: true });
  await writeJsonAtomic(file(wsId, comp.id), comp);
}

/** 락 안에서 읽기-수정-쓰기 — 병렬 entrant 완료가 서로의 기록을 지우지 않게(lost update 방지). */
async function update(wsId, id, mutate) {
  return withLock(lkey(wsId, id), async () => {
    const comp = await readJson(file(wsId, id), null);
    if (!comp) throw new Error('경쟁을 찾을 수 없습니다');
    mutate(comp);
    // 전원 종료 시 경쟁 자체를 완료로
    if (comp.status === 'running' && comp.entrants.every((e) => e.status !== 'running')) comp.status = 'done';
    await save(wsId, comp);
    return comp;
  });
}

/** 경쟁 프롬프트 래핑 — 결재/외부 발신 없이 "완성된 시안 1건"으로 답하게 한다(비교 가능해야 하므로). */
const wrap = (prompt) => `사장이 같은 과제를 여러 크루에게 동시에 맡겼다(경쟁 시안). 네 시안은 동료의 시안과 나란히 비교된다.
너의 전문성이 드러나는 **완성된 시안 1건**을 지금 이 답변 안에 제출하라 — 되묻지 말고, 합리적으로 가정하고 만들어라.
결재가 필요한 행동(외부 발신·설정 변경)은 하지 마라. 시안 자체가 답이다.

## 과제
${prompt}`;

/** 개설 — 기록을 만들고 entrant별 턴을 백그라운드 병렬 실행(개설 API 응답을 막지 않는다). */
export async function startCompetition(wsId, prompt, slugs) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('과제가 필요합니다');
  const uniq = [...new Set((slugs ?? []).map(String))];
  if (uniq.length < MIN_ENTRANTS || uniq.length > MAX_ENTRANTS) {
    throw new Error(`크루 ${MIN_ENTRANTS}~${MAX_ENTRANTS}명을 선택해 주세요`);
  }
  // 예산 사전 게이트 — N명이 동시에 발화하면 chat()의 개별 게이트는 같은 지출액을 읽어
  // 전원 통과할 수 있다(TOCTOU). 개설 시점에 1회 점검해 임계 초과 폭을 줄인다(폭주 통제).
  const { budgetUsd } = await loadCompany(wsId).catch(() => ({}));
  if (budgetUsd > 0) {
    const spent = await monthCost(wsId);
    if (spent >= budgetUsd) {
      throw new Error(`월 예산 초과: $${spent.toFixed(2)} / $${budgetUsd} — 설정에서 예산을 올리거나 다음 달을 기다려 주세요`);
    }
  }
  const agents = await listAgents(wsId);
  const entrants = uniq.map((slug) => {
    const a = agents.find((x) => x.slug === slug);
    if (!a) throw new Error(`크루를 찾을 수 없습니다: ${slug}`);
    return { slug: a.slug, name: a.name, role: a.role ?? '', status: 'running', reply: null, error: null, ms: null };
  });
  const comp = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    prompt: text,
    status: 'running',
    createdAt: new Date().toISOString(),
    entrants,
    winner: null,
    adoptedAt: null,
  };
  await save(wsId, comp);

  for (const e of entrants) {
    (async () => {
      const t0 = Date.now();
      try {
        // 격리 실행 — 개인 스레드 세션을 잇지 않는다(sessionId null). usage에는 kind:'compete'로 남는다.
        const r = await chat(wsId, e.slug, wrap(text), null, { source: 'compete' });
        await update(wsId, comp.id, (c) => {
          const me = c.entrants.find((x) => x.slug === e.slug);
          if (me) { me.status = 'done'; me.reply = r.reply; me.ms = Date.now() - t0; }
        });
      } catch (err) {
        await update(wsId, comp.id, (c) => {
          const me = c.entrants.find((x) => x.slug === e.slug);
          if (me) { me.status = 'error'; me.error = String(err.message || err); me.ms = Date.now() - t0; }
        }).catch(() => {});
        console.error(`[argo] 경쟁 시안 실패(${wsId}/${e.slug}):`, err.message);
      }
    })();
  }
  return comp;
}

/** 목록 — 최신순 요약(레일용). 본문은 상세에서. */
export async function listCompetitions(wsId, limit = 30) {
  let names = [];
  try {
    names = (await readdir(dir(wsId))).filter((n) => n.endsWith('.json'));
  } catch { return []; }
  const out = [];
  for (const n of names) {
    const c = await readJson(join(dir(wsId), n), null).catch(() => null);
    if (!c?.id) continue;
    out.push({
      id: c.id, status: c.status, createdAt: c.createdAt, winner: c.winner,
      topic: String(c.prompt).replace(/\s+/g, ' ').trim().slice(0, 48),
      entrants: c.entrants.map((e) => ({ slug: e.slug, name: e.name, status: e.status })),
    });
  }
  return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, limit);
}

export async function getCompetition(wsId, id) {
  const comp = await readJson(file(wsId, id), null);
  if (!comp) throw new Error('경쟁을 찾을 수 없습니다');
  return comp;
}

/** 채택 — 승자를 확정하고, 채택된 시안만 승자 크루의 스레드에 기록으로 편입한다(회사 기억이 된다). */
export async function adoptWinner(wsId, id, slug) {
  const comp = await update(wsId, id, (c) => {
    const e = c.entrants.find((x) => x.slug === slug);
    if (!e) throw new Error('해당 크루는 이 경쟁의 참가자가 아닙니다');
    if (e.status !== 'done' || !e.reply) throw new Error('완성된 시안만 채택할 수 있습니다');
    if (c.winner) throw new Error('이미 채택이 끝난 경쟁입니다');
    c.winner = slug;
    c.adoptedAt = new Date().toISOString();
  });
  const w = comp.entrants.find((x) => x.slug === slug);
  // 채택본을 승자 스레드에 남긴다 — 후속 지시("이 시안으로 진행해줘")가 자연스럽게 이어지도록
  await appendTurn(wsId, slug, {
    userMsg: `(경쟁 시안 채택) ${comp.prompt}`,
    reply: w.reply, handover: null, sessionId: null,
  }).catch(() => {});
  return comp;
}
