// 경쟁 시안 — 크루 1명에게 같은 과제를 모델 2~3개로 동시에 맡기고, 답변을 나란히 비교해 사장이 채택한다
// (유건 지시 2026-07-19: 크루별 경쟁 → 모델별 경쟁 — 더 좋은 답변을 얻기 위한 도구).
// 현실 메타포: 같은 담당자에게 두 번 물어보기. 경쟁 중 산출물은 크루 개인 스레드를 오염시키지 않고(격리),
// 채택된 답변만 크루의 스레드에 편입되며, 그 세션(sessionId)까지 이어져 후속 지시가 맥락을 잇는다.
// 레거시 레코드(크루 N명 경쟁, key 없음)는 그대로 열람·채택 가능(slug 폴백).
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { listAgents } from './hub.mjs';
import { RUNNERS } from './runners.mjs';
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
const wrap = (prompt) => `사장이 같은 과제로 여러 시안을 동시에 받아 비교 중이다(경쟁 시안). 네 답변은 다른 시안과 나란히 비교된다.
너의 전문성이 드러나는 **완성된 시안 1건**을 지금 이 답변 안에 제출하라 — 되묻지 말고, 합리적으로 가정하고 만들어라.
결재가 필요한 행동(외부 발신·설정 변경)은 하지 마라. 시안 자체가 답이다.

## 과제
${prompt}`;

/** 개설 — 기록을 만들고 entrant별 턴을 백그라운드 병렬 실행(개설 API 응답을 막지 않는다).
    spec = [{ slug, runner, model }] — 크루 1명 + 모델 2~3개(모델별 경쟁). 항목별 key(e0,e1..)로 식별
    (같은 slug가 여러 번 나오므로 slug만으로는 entrant를 못 가른다). */
export async function startCompetition(wsId, prompt, spec) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('과제가 필요합니다');
  const items = (spec ?? []).map((x) => (typeof x === 'string' ? { slug: x } : { slug: String(x?.slug ?? ''), runner: x?.runner ? String(x.runner) : null, model: x?.model ? String(x.model) : null }));
  if (items.length < MIN_ENTRANTS || items.length > MAX_ENTRANTS) {
    throw new Error(`경쟁 항목 ${MIN_ENTRANTS}~${MAX_ENTRANTS}개를 선택해 주세요`);
  }
  // 모델 스펙 검증 — runner/model이 오면 카탈로그 소속이어야 한다(오탈자·죽은 id 조기 거절)
  for (const it of items) {
    if (it.runner && !RUNNERS[it.runner]) throw new Error(`알 수 없는 러너: ${it.runner}`);
    if (it.model && it.runner && !RUNNERS[it.runner].models.some((m) => m.id === it.model)) {
      throw new Error(`${RUNNERS[it.runner].name} 러너에 없는 모델: ${it.model}`);
    }
  }
  // 중복 항목(같은 크루+러너+모델 두 번) 제거
  const seen = new Set();
  const uniqItems = items.filter((it) => { const k = `${it.slug}|${it.runner ?? ''}|${it.model ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (uniqItems.length < MIN_ENTRANTS) throw new Error('같은 항목이 중복 선택되었습니다 — 서로 다른 모델을 골라 주세요');
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
  const entrants = uniqItems.map((it, i) => {
    const a = agents.find((x) => x.slug === it.slug);
    if (!a) throw new Error(`크루를 찾을 수 없습니다: ${it.slug}`);
    const modelLabel = it.model ? (RUNNERS[it.runner]?.models.find((m) => m.id === it.model)?.label ?? it.model) : null;
    return { key: `e${i}`, slug: a.slug, name: a.name, role: a.role ?? '', runner: it.runner, model: it.model, modelLabel,
      status: 'running', reply: null, error: null, ms: null, sessionId: null };
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
        // 격리 실행 — 개인 스레드 세션을 잇지 않는다(sessionId null 전달). 대신 이 턴이 만든 SDK 세션을
        // entrant에 보관해, 채택 시 크루 스레드가 그 세션을 이어받게 한다(후속 지시 = 맥락 연속).
        const r = await chat(wsId, e.slug, wrap(text), null, { source: 'compete', runnerOverride: e.runner, modelOverride: e.model });
        await update(wsId, comp.id, (c) => {
          const me = c.entrants.find((x) => (x.key ?? x.slug) === (e.key ?? e.slug));
          if (me) { me.status = 'done'; me.reply = r.reply; me.ms = Date.now() - t0; me.sessionId = r.sessionId ?? null; }
        });
      } catch (err) {
        await update(wsId, comp.id, (c) => {
          const me = c.entrants.find((x) => (x.key ?? x.slug) === (e.key ?? e.slug));
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
      title: c.title ?? null,  // 사장이 붙인 경쟁명(있으면 레일에서 topic 대신 표시) — 세션 레일 규약 공통
      pinned: c.pinned === true,
      topic: String(c.prompt).replace(/\s+/g, ' ').trim().slice(0, 48),
      entrants: c.entrants.map((e) => ({ slug: e.slug, name: e.name, status: e.status, modelLabel: e.modelLabel ?? null })),
    });
  }
  // 고정 먼저, 그 안에서 최신순 — 채팅·회의 레일과 동일 정렬
  return out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, limit);
}

/** 경쟁명 편집 — 레코드에 title 기록(레일 표시는 title 우선, 없으면 topic). 세션 rename 규약 공통. */
export async function renameCompetition(wsId, id, title) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const comp = await update(wsId, id, (c) => { if (clean) c.title = clean; else delete c.title; });
  return { id, title: comp.title ?? null };
}

/** 경쟁 고정/해제 — 레코드에 pinned 기록. 세션 setPinned 규약 공통. */
export async function setCompetitionPinned(wsId, id, pinned) {
  const comp = await update(wsId, id, (c) => { if (pinned) c.pinned = true; else delete c.pinned; });
  return { id, pinned: comp.pinned === true };
}

export async function getCompetition(wsId, id) {
  const comp = await readJson(file(wsId, id), null);
  if (!comp) throw new Error('경쟁을 찾을 수 없습니다');
  return comp;
}

/** 채택 — 승자를 확정하고, 채택된 답변을 크루 스레드에 편입한다(회사 기억이 된다).
    ref = entrant.key(신형 — 모델 경쟁) 또는 slug(레거시 — 크루 경쟁). 신형은 그 턴의 SDK 세션까지
    스레드에 승계해 후속 지시가 채택된 답변의 맥락을 그대로 잇는다(CLI 러너는 세션 개념이 없어 기록만). */
export async function adoptWinner(wsId, id, ref) {
  const comp = await update(wsId, id, (c) => {
    const e = c.entrants.find((x) => (x.key ?? x.slug) === ref);
    if (!e) throw new Error('이 경쟁의 참가 항목이 아닙니다');
    if (e.status !== 'done' || !e.reply) throw new Error('완성된 답변만 채택할 수 있습니다');
    if (c.winner) throw new Error('이미 채택이 끝난 경쟁입니다');
    c.winner = ref;
    c.adoptedAt = new Date().toISOString();
  });
  const w = comp.entrants.find((x) => (x.key ?? x.slug) === ref);
  // 채택본을 크루 스레드에 남긴다 — 후속 지시("이 답변으로 진행해줘")가 자연스럽게 이어지도록.
  // sessionId가 있으면(SDK 러너) 스레드가 그 세션을 이어받아 크루가 채택 답변의 맥락 위에서 계속한다.
  await appendTurn(wsId, w.slug, {
    userMsg: `(경쟁 시안 채택) ${comp.prompt}`,
    reply: w.reply, handover: null, sessionId: w.sessionId ?? null,
  }).catch(() => {});
  return comp;
}
