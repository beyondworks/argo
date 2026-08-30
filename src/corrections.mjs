// 크루 길들이기 — "같은 지적 두 번이면 규칙" (리서치 접목 F, docs/ai-coding-harness-research.md 1-5
// 에스컬레이션 표의 A2C 번역). 사장이 크루를 교정하면 후보 대장에 쌓고, 같은 계열이 반복되면
// 크루 화면이 "회사 규칙으로 기억할까요?"를 제안한다. 채택 = skills/사장-지침.md에 불릿 적립 —
// 스킬은 매 턴 전 크루 프롬프트에 자동 주입되므로(chat.mjs loadSkills) 반영 코드가 따로 없다.
// 판단(교정 감지)은 AI가, 결정(규칙 채택)은 사장이 한다 — 자동 적립의 오탐 위험을 사람 결정으로 해소.
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { paths } from './workspace.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { runOneShot } from './oneshot.mjs'; // 러너 독립 — 어떤 러너든 연결만 되면 감지가 돈다
import { monthCost } from './billing.mjs';    // 월 예산 게이트 — chat과 같은 판정(검수 H1)
import { appendUsage } from './usage.mjs';    // 감지 원샷도 원장에 남긴다 — 몰래 나가는 비용 금지
import { loadCompany } from './workspace.mjs';

const FILE = (wsId) => join(paths(wsId).root, 'corrections.json');
const lockKey = (wsId) => `corrections:${wsId}`;
export const RULES_SKILL = 'captain-rules.md'; // 채택 규칙이 쌓이는 회사 스킬(자동 주입 채널 — 파일명은 언어 중립, 검수 M6)
export const SUGGEST_AT = 2;   // 같은 계열 교정 N회째에 제안(에스컬레이션 표: 두 번 틀리면 규칙)
const MAX_ITEMS = 100;         // 대장 상한 — 오래된 dismissed부터 밀려난다
// 감지 원샷 계약 — readOnly 필수(신뢰 불가 원문을 다루는 턴의 전권 차단). 테스트가 이 상수를 핀한다.
export const DETECT_ONESHOT_OPTS = Object.freeze({ readOnly: true, timeoutMs: 60_000 });

/** 교정 신호 프리필터(순수) — 이 어휘가 없으면 LLM 판정을 부르지 않는다(매 턴 원샷 비용 방지).
    미탐은 손실이 작다: 교정은 반복이 전제라 다음 기회에 잡힌다. (export: 테스트 앵커) */
export const CORRECTION_HINT_RE = /([가-힣]{1,6}지\s*(마(?![가-힣])|마요|마세요|말고|말아|말라)|말라고|틀렸|아니야|아니라|다시\s*(해|써|만들)|그렇게\s*하지|왜\s*[^?]{0,20}(했|한)|앞으로는|다음부터|항상\s|절대\s|don'?t|do not|stop\s|instead|wrong|not like|always\s|never\s|from now on)/i;

/** 감지 프롬프트 — 짧게(비용 최소). 기존 후보 목록을 주고 같은 계열이면 그 id를 고르게 한다. */
const DETECT_PROMPT = (userMsg, candidates, lang) => {
  const list = candidates.map((c) => `- ${c.id}: ${c.rule}`).join('\n') || (lang === 'en' ? '(none)' : '(없음)');
  if (lang === 'en') {
    return `A boss just wrote this to an AI crew member. Decide if it is a CORRECTION of the crew's behavior (pointing out a mistake, forbidding something, demanding a different way — not a new task, not a question).
Existing correction candidates:
${list}
Boss message: <<<${userMsg.slice(0, 600)}>>>
Reply with JSON only: {"correction": true|false, "rule": "one imperative sentence the crew should follow from now on (empty if not a correction)", "matches": "<candidate id if this is the same kind of correction, else null>"}`;
  }
  return `사장이 AI 크루에게 방금 보낸 메시지다. 이것이 크루 행동에 대한 **교정**(실수 지적·금지·다른 방식 요구 — 새 업무 지시나 질문이 아님)인지 판정하라.
기존 교정 후보 목록:
${list}
사장 메시지: <<<${userMsg.slice(0, 600)}>>>
JSON으로만 답하라: {"correction": true|false, "rule": "앞으로 크루가 따라야 할 명령형 한 문장(교정이 아니면 빈 문자열)", "matches": "같은 계열 후보가 있으면 그 id, 없으면 null"}`;
};

function extractJson(text) {
  const raw = String(text ?? '');
  const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('판정이 JSON이 아닙니다');
  return JSON.parse(raw.slice(a, b + 1));
}

async function loadLedger(wsId) {
  // 대장 손상·형태 오염 관용 — 교정 추적은 재축적 가능(검수 M1: items가 배열이 아니면 GET 500 + 감지 영구 정지였다)
  const l = await readJson(FILE(wsId), { items: [] }).catch(() => ({ items: [] }));
  return { items: Array.isArray(l?.items) ? l.items : [] };
}

/** 사장 직접 턴 후 감지·적립 — fire-and-forget 전용(실패는 로그만, 턴에 영향 0).
    oneshotFn 주입 = 테스트용(실 러너 불필요). */
export async function detectAndTrack(wsId, { userMsg, lang = 'ko', oneshotFn = null } = {}) {
  const msg = String(userMsg ?? '').trim();
  if (!msg || msg.length > 4000) return null;          // 장문은 지시문이지 교정이 아니다
  if (!CORRECTION_HINT_RE.test(msg)) return null;      // 프리필터 — 원샷 비용 관문
  // 월 예산 게이트 — chat과 같은 판정(검수 H1: 예산 초과로 "지금은 돈을 안 씁니다"라고 답한
  // 그 턴이 몰래 유료 원샷을 부르면 안 된다). 구독(OAuth) 턴만 쓰는 회사는 monthCost 0이라 무영향.
  const { budgetUsd } = await loadCompany(wsId).catch(() => ({}));
  if (budgetUsd > 0 && (await monthCost(wsId).catch(() => ({ costUsd: 0 }))).costUsd >= budgetUsd) return null;
  const ledger = await loadLedger(wsId);
  const candidates = ledger.items.filter((c) => c.status === 'candidate').slice(-20);
  const t0 = Date.now();
  const run = oneshotFn ?? (async (p) => {
    const r = await runOneShot(wsId, p, { lang, ...DETECT_ONESHOT_OPTS });
    // 감지 비용도 원장에 — 기록이 없으면 대시보드·예산이 이 지출을 영원히 못 따라잡는다(검수 H1)
    await appendUsage(wsId, { kind: 'correction', slug: '', runner: r.runner, model: r.runner, usage: r.usage ?? {}, costUsd: r.costUsd ?? null, ms: Date.now() - t0 })
      .catch(() => {});
    return r.text;
  });
  let parsed;
  try {
    parsed = extractJson(await run(DETECT_PROMPT(msg, candidates, lang)));
  } catch {
    return null; // 판정 실패 — 조용히 다음 기회(교정은 반복이 전제)
  }
  if (!parsed?.correction) return null;
  // 한 줄 불변식(검수 H2) — 개행·제어문자가 남으면 채택 시 마크다운 구조가 불릿을 탈출해
  // "칩에 보이는 것 ≠ 적립되는 것"이 된다(사장 승인이 유일한 방어라 이 등식이 성립해야 한다).
  const rule = String(parsed.rule ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!rule) return null;
  return withLock(lockKey(wsId), async () => {
    const cur = await loadLedger(wsId);
    const matched = parsed.matches ? cur.items.find((c) => c.id === String(parsed.matches) && c.status === 'candidate') : null;
    if (matched) {
      matched.count += 1;
      matched.lastAt = new Date().toISOString();
      matched.rule = rule; // 최신 표현으로 갱신 — 사장의 마지막 문구가 가장 정확하다
    } else {
      cur.items.push({ id: `c${Date.now().toString(36)}`, rule, count: 1, status: 'candidate', lastAt: new Date().toISOString() });
      if (cur.items.length > MAX_ITEMS) {
        const drop = cur.items.findIndex((c) => c.status === 'dismissed');
        cur.items.splice(drop >= 0 ? drop : 0, 1);
      }
    }
    await writeJsonAtomic(FILE(wsId), cur);
    return matched ?? cur.items[cur.items.length - 1];
  });
}

/** 제안 목록 — 같은 계열 교정이 SUGGEST_AT회 이상 쌓인 후보(사장 결정 대기). */
export async function listSuggestions(wsId) {
  const { items } = await loadLedger(wsId);
  return items.filter((c) => c.status === 'candidate' && c.count >= SUGGEST_AT)
    .map(({ id, rule, count, lastAt }) => ({ id, rule, count, lastAt }));
}

/** 채택 — skills/사장-지침.md에 불릿 적립(파일 없으면 생성). 스킬 자동 주입 채널이 곧 반영 경로다. */
export async function adoptCorrection(wsId, id, { lang = 'ko' } = {}) {
  return withLock(lockKey(wsId), async () => {
    const cur = await loadLedger(wsId);
    const item = cur.items.find((c) => c.id === id && c.status === 'candidate');
    if (!item) throw new Error('제안을 찾을 수 없습니다');
    const skillsDir = paths(wsId).skills;
    await mkdir(skillsDir, { recursive: true });
    const f = join(skillsDir, RULES_SKILL);
    const head = lang === 'en'
      ? '# Captain rules — adopted from repeated corrections\n\n> Rules the captain approved when the same correction came up twice. Injected to every crew, every turn.\n'
      : '# 사장 지침 — 반복 교정에서 채택된 회사 규칙\n\n> 사장이 같은 지적을 반복했을 때 "규칙으로 기억할까요?" 제안을 승인한 항목들. 전 크루에게 매 턴 주입된다.\n';
    const existing = await readFile(f, 'utf8').catch(() => null);
    // 같은 규칙 재적립 방지(검수 M3) — 채택된 계열이 새 후보로 다시 쌓여 재채택되면 불릿이
    // 중복돼 주입 예산(6000자)을 갉는다. 이미 있으면 상태만 adopted로 넘긴다.
    if (existing !== null && existing.includes(`- ${item.rule} (`)) {
      item.status = 'adopted';
      await writeJsonAtomic(FILE(wsId), cur);
      return { id, rule: item.rule, deduped: true };
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const line = `- ${item.rule} (${lang === 'en' ? `adopted ${stamp}` : `${stamp} 채택`})`;
    await writeFile(f, existing === null ? `${head}\n${line}\n` : `${existing.trimEnd()}\n${line}\n`, 'utf8');
    item.status = 'adopted';
    await writeJsonAtomic(FILE(wsId), cur);
    return { id, rule: item.rule };
  });
}

/** 거절 — 이 후보(계열)는 다시 제안하지 않는다. 단 같은 취지가 **새 후보**로 다시 쌓이면
    문턱 도달 시 다시 물을 수 있다(대장은 문구 유사도를 모른다 — 검수 L2 사실화). */
export async function dismissCorrection(wsId, id) {
  return withLock(lockKey(wsId), async () => {
    const cur = await loadLedger(wsId);
    const item = cur.items.find((c) => c.id === id && c.status === 'candidate');
    if (!item) return;
    item.status = 'dismissed';
    await writeJsonAtomic(FILE(wsId), cur);
  });
}
