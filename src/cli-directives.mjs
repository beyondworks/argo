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
import { addApproval } from './approvals.mjs'; // CLI 결재 경로 — SDK request_approval과 같은 원장
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
export async function runDirectives(wsId, fromSlug, directives, { lang = 'ko', bad = [], hop = 0, chain = [] } = {}) {
  const en = lang === 'en';
  const notes = [];
  const agents = await listAgents(wsId).catch(() => []);
  const fromName = agents.find((a) => a.slug === fromSlug)?.name ?? fromSlug;
  const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().trim();
  // 자기 자신은 수신자 후보에서 뺀다 — SDK 경로의 colleagues는 애초에 자신을 제외하는데(chat.mjs)
  // 이 경로는 listAgents 전체를 뒤져 자기 앞으로 쪽지를 보낼 수 있었다(격리 재현 2026-07-30:
  // from=alpha·to=alpha 배달 성공). 스케줄러가 그걸 배달하면 같은 크루가 또 지시 블록을 내는
  // 자기 왕복이 되고, 아래 hop 상한도 자기 자신에겐 의미가 없어 무한 반복 + 비용 소모가 된다.
  const find = (v) => agents.find((a) => a.slug !== fromSlug && (norm(a.slug) === norm(v) || norm(a.name) === norm(v)));

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
        // SDK 경로는 hop>=2면 쪽지 도구 자체가 등록되지 않는다(chat.mjs colleagues). 러너 패리티 —
        // 같은 지점에서 같은 상한을 건다. 조용히 무시하지 않고 사유 줄로 남긴다(이 파일의 계약).
        if (hop >= 2) throw new Error(en ? 'note relay limit reached (2 hops)' : '쪽지 연쇄 상한(2단계)에 도달했다');
        // 자기수신 사유는 **find 실패 후**에만 — 앞에 두면 동명이인(표시 이름이 같은 다른 크루)에게
        // 보내는 정상 쪽지가 "자기 자신"으로 오차단된다(재검수 MEDIUM: 이름 유일성은 강제되지 않는다).
        // find는 slug로 자신을 제외하므로, 조회 성공 = 자신이 아닌 실재 크루가 확실하다.
        const to = find(d.to);
        if (!to) {
          if (norm(d.to) === norm(fromSlug) || norm(d.to) === norm(fromName)) {
            throw new Error(en ? "you can't send a note to yourself" : '자기 자신에게는 쪽지를 보낼 수 없다');
          }
          throw new Error(en ? `no crew named "${d.to}"` : `"${d.to}"는 크루 명단에 없습니다`);
        }
        const cc = (Array.isArray(d.cc) ? d.cc : []).map(find).filter(Boolean).map((a) => a.slug);
        const msg = String(d.message ?? '').trim();
        if (!msg) throw new Error(en ? 'message is required' : 'message가 필요합니다');
        // hop·chain 전파 필수 — SDK 도구(chat.mjs send_to_crew)는 hop+1을 실어 보내고 hop>=2에서
        // colleagues가 빈 배열이 되어 왕복이 끝난다. 이 경로가 hop을 안 실으면 배달된 크루가 지시
        // 블록 하나로 hop을 0으로 되돌려 그 상한을 통째로 무력화한다(격리 재현 2026-07-30: hop=2로
        // 배달된 턴이 낸 블록의 메시지가 hop=0·chain=[]). 실효 바운드가 hop 단독이라 여기서 샌다.
        await sendCrewMail(wsId, { from: fromSlug, fromName, to: to.slug, cc, message: msg, hop: hop + 1, chain: [...chain, fromSlug] });
        notes.push(en ? `✓ Note sent to ${to.name}${cc.length ? ` (cc ${cc.length})` : ''}` : `✓ ${to.name}에게 쪽지 보냄${cc.length ? ` (참조 ${cc.length}명)` : ''}`);
      } else if (action === 'approval') {
        // CLI 러너의 결재 경로(러너 중립성 — 실사용 스크린샷 2026-07-30: 결재 도구가 없는 크루가
        // "결재가 필요하다"고 보고만 하고 정지 → 결재함이 비어 사용자가 밟을 절차 자체가 없었다).
        // SDK의 request_approval과 같은 원장(addApproval kind:'action')에 등록한다 — 승인되면
        // approval-actions가 후속 턴으로 "이제 실행하라"를 배달한다(경로 동일).
        const request = String(d.request ?? d.action_text ?? '').trim();
        if (!request) throw new Error(en ? 'request is required' : 'request(하려는 행동)가 필요합니다');
        const item = await addApproval(wsId, {
          slug: fromSlug, action: request.replace(/[\r\n\t\x00-\x1f]+/g, ' ').slice(0, 200),
          reason: String(d.reason ?? '').replace(/[\r\n\t\x00-\x1f]+/g, ' ').slice(0, 300),
        });
        notes.push(en
          ? `✓ Approval filed (${item.id}) — waiting for the captain. Do NOT perform the action until approved.`
          : `✓ 결재 올림(${item.id}) — 사장 승인 대기. 승인 전에는 그 행동을 실행하지 마라.`);
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
