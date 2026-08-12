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
import { callConnectorTool } from './connectors.mjs'; // 커넥터 단일 실행 경로 — SDK 표면과 같은 함수

/** 지시 블록 문법 — ```argo 펜스 안 JSON 1건. 여러 블록 허용.
    스케줄: {"action":"schedule","every":"30m"|"time":"09:00","days":[1,3],"title":"...","prompt":"..."}
    쪽지:   {"action":"mail","to":"슬러그","cc":["..."],"message":"..."}
    커넥터: {"action":"tool","server":"gmail","tool":"search_threads","args":{…}} */
const BLOCK_RE = /```argo[ \t]*\r?\n([\s\S]*?)```/g;
/* 펜스 없는 변종 — 일부 CLI 러너는 답변을 **렌더해서** 내보내며 그 과정에서 코드펜스가 사라진다
   (kiro-cli 실측 2026-08-12: 백틱 0개, JSON은 한 줄로 렌더). 그러면 위 정규식이 영원히 매치되지 않아
   지시가 **조용히 무동작**하고, 원시 JSON이 사장 화면에 그대로 남는다 — 이 파일이 없애려고 만들어진
   바로 그 증상("크루가 예약했다고 말만 한다")이 러너만 바꿔 재발한다(러너 중립성 위반).

   정규식이 아니라 스캔인 이유: 커넥터 지시는 `args`가 중첩 오브젝트라, 게으른 매치는 안쪽 `}`에서
   멈추고 탐욕 매치는 뒤 문장까지 삼킨다. 첫 `{`부터 각 `}` 후보까지를 차례로 JSON.parse 해
   **처음 성공한 지점**을 취하면 중첩 깊이와 무관하게 정확하다(블록은 작아 비용 무시).
   오탐 방지: 파싱된 오브젝트에 `action` 키가 있을 때만 지시로 취급하고, 아니면 원문을 그대로 남긴다.
   산문에 이 형태가 우연히 나올 확률은 사실상 0이고, 나와도 텍스트가 보존되므로 손실이 없다. */
const BARE_HEAD_RE = /^argo[ \t]*\r?\n[ \t]*(?=\{)/gm;
/** 스캔 상한 — `}` 후보마다 JSON.parse를 시도하므로 이론상 O(n²)다. 지시 블록은 실무상 1KB 미만이고
    커넥터 인자를 넉넉히 봐도 이 상한이면 충분하다(분리 검수 4라운드 LOW: 266KB 답변에서 2.6초 블로킹). */
const BARE_SCAN_LIMIT = 8 * 1024;

/** 펜스 없는 블록 하나를 읽는다 — 반환 { obj, end } 또는 null(파싱 실패). start는 `{` 위치. */
function readBareObject(src, start) {
  const stop = Math.min(src.length, start + BARE_SCAN_LIMIT);
  for (let i = src.indexOf('}', start); i !== -1 && i < stop; i = src.indexOf('}', i + 1)) {
    const body = src.slice(start, i + 1);
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { obj, end: i + 1, body };
    } catch { /* 아직 닫히지 않았다 — 다음 `}` 후보로 */ }
  }
  return null;
}

/** 코드펜스 구간 [시작, 끝) 목록 — 펜스 **안**의 지시 형태는 지시가 아니라 예시다(설명·문서 작성).
    이걸 실행하면 크루가 "이렇게 쓰면 됩니다"라고 보여준 예시가 실제 쪽지·예약이 된다
    (분리 검수 4라운드 MEDIUM). BLOCK_RE가 이미 소비한 ```argo는 이 시점에 없으므로, 남은 펜스는
    전부 일반 코드블록이다. */
function fencedRanges(src) {
  const out = [];
  const re = /```[\s\S]*?```/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** 커넥터 결과 주입 상한(바이트) — **한 턴 전체 예산**이다(블록이 여럿이면 앞에서부터 나눠 쓴다).
    근거: 후속 턴 프롬프트는 러너 CLI에 argv로 실린다. Windows CreateProcess의 32,767자가 3플랫폼
    공통 최소 바운드라(macOS ARG_MAX ~1MB·Linux ~2MB) 페르소나·규율·대화 맥락이 함께 실리는 몫을
    빼고 24KB로 잡는다. 넘치면 자르되 **잘랐다는 사실을 표기**한다 — 조용한 절단은 크루가 부분
    결과를 전체로 착각해 답하게 만든다. */
export const TOOL_RESULT_BUDGET_BYTES = 24 * 1024;
/** 자동 후속 턴은 1회. 결과를 본 크루가 또 도구를 부르면 그 자리에서 막는다(무한 왕복·비용 폭주 차단). */
export const TOOL_FOLLOWUP_MAX = 1;

/** UTF-8 바이트 상한으로 자른다 — 멀티바이트 문자를 반토막 내지 않는다.
    (상한이 바이트인 이유는 argv 바운드가 바이트/코드유닛이지 문자 수가 아니기 때문이다.)
    반환 { text, kept, bytes } — bytes는 원본 크기(잘림 표기에 쓴다). */
export function capBytes(s, maxBytes) {
  const src = String(s ?? '');
  const buf = Buffer.from(src, 'utf8');
  if (buf.length <= maxBytes) return { text: src, kept: buf.length, bytes: buf.length };
  if (maxBytes <= 0) return { text: '', kept: 0, bytes: buf.length };
  // 끝을 UTF-8 문자 경계까지 되감는다: 0b10xxxxxx는 연속 바이트라 그 앞 문자가 잘렸다는 뜻.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), kept: end, bytes: buf.length };
}

/** MCP content 배열 → 사람이 읽는 텍스트. 텍스트 아닌 파트는 종류만 남긴다 — 바이너리를 프롬프트에
    쏟아붓지 않는다(주입 예산은 본문 몫이다). */
export function connectorContentText(content) {
  return (Array.isArray(content) ? content : [])
    .map((c) => (c?.type === 'text' ? String(c.text ?? '') : `[${String(c?.type ?? 'unknown')}]`))
    .filter(Boolean)
    .join('\n');
}

/** 답변에서 지시를 걷어낸다(순수 함수 — 단위 테스트용). 반환: { clean, directives, bad }
    파싱 실패 블록은 bad로 돌려 **조용히 삼키지 않는다** — 크루가 형식을 틀렸는데 아무 일도
    안 일어나면 그게 곧 "예약했다고 말만 하는" 할루시네이션이 된다.
    ⚠ 펜스 없는 변종(아래)은 bad를 쓰지 않는다: 펜스라는 명시 표지가 없어 "지시하려다 틀린 것"과
    "그냥 산문"을 구분할 수 없다. 그래서 파싱 실패·action 부재는 **원문을 그대로 남기는 쪽**으로
    처리한다(사장이 원시 JSON을 보면 형식 오류를 알 수 있다 — 조용한 소실보다 낫다). */
export function parseDirectives(text) {
  const src = String(text ?? '');
  const directives = [];
  const bad = [];
  const take = (body) => {
    try {
      const d = JSON.parse(body.trim());
      if (d && typeof d === 'object' && !Array.isArray(d)) directives.push(d);
      else bad.push('블록이 JSON 오브젝트가 아님');
    } catch (e) { bad.push(String(e.message || e).slice(0, 120)); }
    return '';
  };
  let clean = src.replace(BLOCK_RE, (_m, body) => take(body));
  // 펜스 없는 변종 — 잘라내기는 **뒤에서 앞으로**(앞에서 자르면 인덱스가 밀린다) 하되,
  // 수집한 지시는 **원문 순서로** 되돌려 붙인다. 지시는 순차 실행되므로 순서가 뒤집히면
  // "쪽지 보낸 뒤 예약"이 "예약한 뒤 쪽지"가 된다.
  const bareFound = [];
  const fences = fencedRanges(clean);
  const inFence = (i) => fences.some(([a, b]) => i >= a && i < b);
  const heads = [...clean.matchAll(BARE_HEAD_RE)].reverse();
  for (const h of heads) {
    if (inFence(h.index)) continue; // 펜스 안 = 예시. 실행하지 않고 원문 그대로 둔다
    const braceAt = clean.indexOf('{', h.index);
    if (braceAt === -1) continue;
    const found = readBareObject(clean, braceAt);
    if (!found || typeof found.obj.action !== 'string') continue; // action 없으면 지시로 보지 않는다(원문 보존)
    bareFound.push(found.obj);
    clean = clean.slice(0, h.index) + clean.slice(found.end);
  }
  directives.push(...bareFound.reverse());
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
    실패도 줄로 남긴다: 조용한 실패는 크루의 거짓말이 된다.
    `results`는 호출측이 건네는 수집함이다(커넥터 도구에 실제로 닿은 호출만 담긴다) — 채워지면
    호출측이 runToolFollowUp으로 후속 턴 1회를 돌린다. `toolHop`은 그 후속 턴 카운터. */
export async function runDirectives(wsId, fromSlug, directives, { lang = 'ko', bad = [], hop = 0, chain = [], toolHop = 0, results = [] } = {}) {
  const en = lang === 'en';
  const notes = [];
  let budget = TOOL_RESULT_BUDGET_BYTES; // 턴 전체 주입 예산 — 블록이 여럿이면 앞에서부터 소진된다
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
      } else if (action === 'tool') {
        // 커넥터 도구 호출 — SDK 표면(use_connector)과 **같은 코어 함수**로 수렴한다(설계서 §1 단일 실행 경로).
        // 러너가 다르다고 능력이 갈리면 안 된다는 절대 조건이 이 한 줄로 담보된다.
        const server = String(d.server ?? '').trim();
        const tool = String(d.tool ?? '').trim();
        if (!server) throw new Error(en ? 'server is required' : 'server(커넥터 id)가 필요합니다');
        if (!tool) throw new Error(en ? 'tool is required' : 'tool(도구 이름)이 필요합니다');
        const args = d.args ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) throw new Error(en ? 'args must be an object' : 'args는 오브젝트여야 합니다');
        // 후속 턴 상한 — 결과를 보고 재턴한 턴이 또 도구를 부르면 여기서 막는다. 쪽지 hop 가드와 같은
        // 자리·같은 형태이고, **호출 자체를 막는다**: 상한이 지키려는 것은 외부 왕복 횟수와 비용이다.
        if (toolHop >= TOOL_FOLLOWUP_MAX) {
          throw new Error(en
            ? `connector follow-up limit reached (${TOOL_FOLLOWUP_MAX} per turn) — answer with the results you already have`
            : `커넥터 후속 턴 상한(턴당 ${TOOL_FOLLOWUP_MAX}회)에 도달했다 — 이미 받은 결과로 답하라`);
        }
        const r = await callConnectorTool(wsId, server, tool, args, { lang, slug: fromSlug });
        const text = connectorContentText(r.content);
        if (r.error) {
          // 미연결·재인증 필요·전송 실패 — 도구에 닿지 못했다. 정직한 줄만 남기고 후속 턴 재료로 삼지
          // 않는다(보여줄 결과가 없는데 턴 비용만 쓰는 재턴을 막는다 — 사용자는 이 줄로 이미 사실을 안다).
          notes.push(en ? `⚠ Connector call failed (${server}/${tool}): ${text}` : `⚠ 커넥터 호출 실패 (${server}/${tool}): ${text}`);
        } else {
          const { text: capped, kept, bytes } = capBytes(text, budget);
          budget -= kept;
          const head = r.isError
            ? (en ? `⚠ Connector tool returned an error — ${server}/${tool}` : `⚠ 커넥터 도구가 오류를 반환했다 — ${server}/${tool}`)
            : (en ? `✓ Connector call — ${server}/${tool}` : `✓ 커넥터 호출 — ${server}/${tool}`);
          const cut = kept < bytes
            ? (en
              ? `\n… (truncated by the injection budget — kept ${kept} of ${bytes} bytes; turn budget ${TOOL_RESULT_BUDGET_BYTES})`
              : `\n… (주입 예산으로 잘림 — 원본 ${bytes}바이트 중 ${kept}바이트만 전달, 턴 예산 ${TOOL_RESULT_BUDGET_BYTES}바이트)`)
            : '';
          notes.push(`${head}\n${capped}${cut}`);
          // 후속 턴이 보는 것과 사용자가 보는 것이 **같은 절단본**이다(원본을 따로 들고 있지 않는다) —
          // 화면과 주입이 갈라지면 "크루가 본 것"을 사용자가 검증할 수 없다.
          results.push({ server, tool, ok: r.ok, text: capped, truncated: kept < bytes });
        }
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

/** 후속 턴에 주입할 시스템 메시지(순수 — 단위 테스트용). 크루의 원래 답변은 **결과를 보기 전에**
    쓰인 것이라 그 자체로는 반쪽이다. 결과 + 사장의 원 지시를 함께 실어 이어서 답하게 한다. */
export function toolFollowUpMessage(results, { lang = 'ko', userMsg = '' } = {}) {
  const en = lang === 'en';
  const fence = '```argo';
  // 절단·오류는 **크루에게도** 표시한다. 사용자 줄에만 붙이던 때는, 정작 이 결과로 답을 쓰는 크루가
  // 부분 결과를 전체로 착각해 "메일은 이게 전부입니다"라고 단정할 수 있었다 — 조용한 절단의 본체는
  // 여기다(사용자는 나중에 답을 읽을 뿐이고, 판단은 크루가 이 텍스트만 보고 내린다).
  const blocks = results.map((r) => {
    const flags = [
      r.ok === false ? (en ? 'the tool reported an error' : '도구가 오류를 반환함') : '',
      r.truncated ? (en ? 'TRUNCATED — this is the beginning of the result, not all of it' : '잘림 — 결과의 앞부분일 뿐 전부가 아니다') : '',
    ].filter(Boolean);
    return `### ${r.server}/${r.tool}${flags.length ? ` [${flags.join(' / ')}]` : ''}\n${r.text}`;
  }).join('\n\n');
  const caution = results.some((r) => r.truncated || r.ok === false)
    ? (en
      ? `\n\nSome results are truncated or failed (see the tags above) — do not present them as complete, and say what is missing.`
      : `\n\n일부 결과는 잘렸거나 실패했다(위 표시 참고) — 그걸 전부인 것처럼 말하지 말고, 무엇이 빠졌는지 밝혀라.`)
    : '';
  const ask = String(userMsg ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return en
    ? `(System) The connector calls you asked for have run. Their real results are below.\n\n${blocks}\n\n`
      + `${ask ? `The captain's instruction was: ${ask}\n\n` : ''}`
      + `Answer the captain using these results — never invent or guess what they contain. `
      + `Do NOT emit another ${fence} tool block: the automatic follow-up is one turn per turn, and a second block will be refused.${caution}`
    : `(시스템) 네가 요청한 커넥터 호출이 실행됐다. 실제 결과는 아래와 같다.\n\n${blocks}\n\n`
      + `${ask ? `사장의 지시는 이것이었다: ${ask}\n\n` : ''}`
      + `이 결과를 근거로 사장에게 답하라 — 내용을 지어내거나 추측하지 마라. `
      + `${fence} tool 블록을 다시 내지 마라: 자동 후속 턴은 턴당 1회뿐이라 두 번째 블록은 거부된다.${caution}`;
}

/**
 * 자동 후속 턴 1회 — 커넥터 결과를 시스템 주입으로 재턴한다(설계서 §2-2).
 * 상한 초과·결과 없음이면 아무것도 하지 않고 null(호출측이 분기할 필요 없게).
 *
 * `chatFn` 주입인 이유: chat.mjs가 이 모듈을 **동적 import**로 부른다(순환 차단). 여기서 chat을
 * 정적으로 되부르면 그 순환이 되살아난다. 겸해서 상한·증가(toolHop+1)를 러너 없이 잠글 수 있는
 * 유일한 seam이 된다 — 가드는 읽는 자리와 **쓰는 자리**를 함께 잠가야 한다.
 * 후속 턴이 실패해도 원 턴을 죽이지 않는다: 도구는 이미 실행됐고 결과는 답변에 붙어 있다.
 */
export async function runToolFollowUp(chatFn, wsId, slug, { results = [], toolHop = 0, lang = 'ko', userMsg = '', sessionId = null, chatOpts = {} } = {}) {
  if (!results.length || toolHop >= TOOL_FOLLOWUP_MAX) return null;
  const msg = toolFollowUpMessage(results, { lang, userMsg });
  try {
    const r = await chatFn(wsId, slug, msg, sessionId, { ...chatOpts, toolHop: toolHop + 1 });
    return { reply: String(r?.reply ?? '').trim(), note: '' };
  } catch (e) {
    const m = String(e?.message ?? e).slice(0, 160);
    return { reply: '', note: lang === 'en' ? `⚠ Follow-up turn failed: ${m}` : `⚠ 후속 턴 실패: ${m}` };
  }
}
