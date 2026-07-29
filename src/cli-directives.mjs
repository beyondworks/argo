// CLI 러너 능력 패리티 — **러너에 따라 크루가 할 수 있는 일이 갈리면 안 된다**(유건 지시 2026-07-28:
// "어떤 러너를 쓰던 같은 환경이여야지").
//
// SDK 러너(Claude)는 turn 중에 도구(schedule_task·send_to_crew)를 호출한다. 외부 CLI 러너
// (codex·gemini·antigravity)는 `externalExec`가 프롬프트를 넣고 **텍스트만 받는** 일회성
// 프로세스라 도구를 되부를 통로가 없다. 그래서 지금까지 CLI 크루는 "사장에게 루틴 화면에서
// 걸어 달라고 안내하라"는 반쪽 능력만 가졌다 — 그 격차가 실사용에서 "루틴이 실행 안 된다 /
// 크루가 예약했다고 말만 한다"로 돌아왔다.
//
// 해법: 도구 호출 대신 **답변 텍스트의 지시 블록을 턴 종료 후 파싱해 실행**한다. 같은 패턴이
// 레포에 이미 있다(gateway의 결재 파서). 실행 결과는 답변에 사실로 덧붙고, 블록 자체는 화면에서
// 지운다 — 사장이 JSON을 볼 이유가 없다.
import { addRoutine, normalizeSchedule } from './routines.mjs';
import { sendCrewMail } from './crewmail.mjs';
import { listAgents } from './hub.mjs';

/** 지시 블록 문법 — ```argo 펜스 안 JSON 1건. 여러 블록 허용.
    스케줄: {"action":"schedule","every":"30m"|"time":"09:00","days":[1,3],"title":"...","prompt":"..."}
    쪽지:   {"action":"mail","to":"슬러그","cc":["..."],"message":"..."} */
const BLOCK_RE = /```argo[ \t]*\r?\n([\s\S]*?)```/g;

/** 답변에서 지시를 걷어낸다(순수 함수 — 단위 테스트용). 반환: { clean, directives, bad }
    파싱 실패 블록은 bad로 돌려 **조용히 삼키지 않는다** — 크루가 형식을 틀렸는데 아무 일도
    안 일어나면 그게 곧 "예약했다고 말만 하는" 할루시네이션이 된다. */
export function parseDirectives(text) {
  const src = String(text ?? '');
  const directives = [];
  const bad = [];
  const clean = src.replace(BLOCK_RE, (_m, body) => {
    try {
      const d = JSON.parse(body.trim());
      if (d && typeof d === 'object' && !Array.isArray(d)) directives.push(d);
      else bad.push('블록이 JSON 오브젝트가 아님');
    } catch (e) { bad.push(String(e.message || e).slice(0, 120)); }
    return '';
  });
  return { clean: clean.replace(/\n{3,}/g, '\n\n').trim(), directives, bad };
}

/** every: "30m" | "2h" | "30분" | "2시간" | 숫자(분) → 분. 못 읽으면 null. */
export function parseEvery(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  const m = String(v ?? '').trim().match(/^(\d+)\s*(분|시간|mins?|hrs?|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return /^(시간|h|hr|hrs)$/i.test(m[2] ?? '') ? n * 60 : n;
}

/** 지시 1건 → 스케줄 오브젝트(normalizeSchedule 입력). 검증은 normalizeSchedule이 한다. */
export function toSchedule(d) {
  const every = d.every != null ? parseEvery(d.every) : null;
  if (every != null) return { type: 'interval', everyMinutes: every };
  const times = Array.isArray(d.times) ? d.times : (d.time ? [d.time] : []);
  if (!times.length) throw new Error('every 또는 time이 필요합니다');
  const dows = Array.isArray(d.days) ? d.days.map(Number) : null;
  return dows?.length ? { type: 'weekly', times, dows } : { type: 'daily', times };
}

/** 지시 실행 — 사람이 읽을 결과 줄 배열을 돌려준다(답변 끝에 붙는다).
    실패도 줄로 남긴다: 조용한 실패는 크루의 거짓말이 된다. */
export async function runDirectives(wsId, fromSlug, directives, { lang = 'ko', bad = [] } = {}) {
  const en = lang === 'en';
  const notes = [];
  const agents = await listAgents(wsId).catch(() => []);
  const fromName = agents.find((a) => a.slug === fromSlug)?.name ?? fromSlug;
  const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().trim();
  const find = (v) => agents.find((a) => norm(a.slug) === norm(v) || norm(a.name) === norm(v));

  for (const b of bad) {
    notes.push(en ? `⚠ Directive block ignored (${b})` : `⚠ 지시 블록을 읽지 못했습니다 (${b})`);
  }
  for (const d of directives) {
    const action = String(d.action ?? '').toLowerCase();
    try {
      if (action === 'schedule') {
        const prompt = String(d.prompt ?? '').trim();
        if (!prompt) throw new Error(en ? 'prompt is required' : 'prompt가 필요합니다');
        const target = d.crew ? find(d.crew) : null;
        const r = await addRoutine(wsId, {
          agentSlug: target?.slug ?? fromSlug,
          title: String(d.title ?? prompt).replace(/\s+/g, ' ').slice(0, 60),
          prompt,
          schedule: normalizeSchedule(toSchedule(d)),
        });
        const when = r.schedule.type === 'interval'
          ? (en ? `every ${r.schedule.everyMinutes} min` : `${r.schedule.everyMinutes}분마다`)
          : (r.schedule.times ?? []).join('·');
        notes.push(en ? `✓ Routine registered — ${r.title} (${when})` : `✓ 루틴 등록됨 — ${r.title} (${when})`);
      } else if (action === 'mail') {
        const to = find(d.to);
        if (!to) throw new Error(en ? `no crew named "${d.to}"` : `"${d.to}"는 크루 명단에 없습니다`);
        const cc = (Array.isArray(d.cc) ? d.cc : []).map(find).filter(Boolean).map((a) => a.slug);
        const msg = String(d.message ?? '').trim();
        if (!msg) throw new Error(en ? 'message is required' : 'message가 필요합니다');
        await sendCrewMail(wsId, { from: fromSlug, fromName, to: to.slug, cc, message: msg });
        notes.push(en ? `✓ Note sent to ${to.name}${cc.length ? ` (cc ${cc.length})` : ''}` : `✓ ${to.name}에게 쪽지 보냄${cc.length ? ` (참조 ${cc.length}명)` : ''}`);
      } else {
        notes.push(en ? `⚠ Unknown directive "${action}"` : `⚠ 알 수 없는 지시 "${action}"`);
      }
    } catch (e) {
      const m = String(e.message || e).slice(0, 160);
      notes.push(en ? `⚠ Directive failed (${action}): ${m}` : `⚠ 지시 실행 실패 (${action}): ${m}`);
    }
  }
  return notes;
}
