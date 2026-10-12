// 오피스 패널 턴의 쓰기 확인 카드(2단계 PR1, 유건 10/11 결정 '쓰기 기본값: 늘 확인 카드, 사용자가 바로 실행을 켤 수 있게').
// 패널에서 보낸 턴(meta.source = office_panel)에서 에이전트가 오피스 쓰기 도구를 부르면 실행하지 않고 제안으로 모은다 → 답 글 meta.office_proposals →
// 패널이 카드로 그린다 → 사용자가 [실행]을 누르면 확인 글(meta.office_confirm {reply, pid})이 오고, 게이트웨이가 그 답 글의 제안을 DB에서 다시 읽어 인자 그대로 실행한다.
// 맡기기 턴(office_mail 등)은 대상이 아니다 — 그 답은 메신저에 보이는데 메신저는 카드를 그리지 못한다.
import { confirmNeeded } from '../office-confirm.mjs';

export const PANEL_SOURCE = 'office_panel';
export const PROPOSAL_MAX = 5;
const ARGS_MAX = 8000; // 제안 하나의 인자 JSON 바이트 상한 — 답 글 meta에 실린다
const ALL_MAX = 16000; // 한 답의 제안 인자 합계 바이트 상한 — meta 열 제약(msgr_messages_meta_size 64KB, 20260909003000)에 한참 못 미치게(검수 M4)
const bytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null));

/** 쓰기 동작 — 나머지(목록·읽기)는 확인 없이 실행한다 */
const WRITES = {
  calendar: ['create', 'update', 'delete'],
  office: ['company_set', 'eval_add'],
  office_files: ['attach', 'drive_import', 'drive_mkdir', 'drive_export'],
  office_work: ['task_add', 'task_set', 'page_add', 'page_edit'],
  office_deals: ['customer_add', 'customer_set', 'deal_add', 'deal_next', 'deal_due'],
  office_mail: ['mail_draft', 'mail_star'],
  office_briefing: ['brief_add'],
};
export const isWrite = (name, a) => !!WRITES[name]?.includes(a?.action);

/** 바로 실행을 켜도 카드를 띄우는 동작 — CLI·MCP 승인 목록(되돌리기 어려움) + 일정 삭제(휴지통 없음) */
export const alwaysConfirm = (name, a) => !!confirmNeeded(name, a)
  || (name === 'calendar' && (a?.action === 'delete' || (a?.action === 'update' && (a.scope === 'all' || a.scope === 'following')))) // 일정 삭제(휴지통 없음), 반복 일정 여러 회차 고치기
  || (name === 'office' && a?.action === 'company_set'); // 회사 정보(계좌·세무 포함) 덮어쓰기 — 검수 L5

export const isPanelSource = (message) => message?.meta?.source === PANEL_SOURCE;

/** 확인 글의 표지 — { reply: 답 글 id, pid } | null. 멤버가 쓸 수 있는 값이라 실행 전에 게이트웨이가 답 글을 DB에서 다시 읽어 맞춰 본다 */
export function confirmOf(message) {
  const c = message?.meta?.office_confirm;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const reply = typeof c.reply === 'string' && /^[1-9]\d{0,17}$/.test(c.reply) ? Number(c.reply) : c.reply;
  if (!Number.isSafeInteger(reply) || reply <= 0) return null;
  if (typeof c.pid !== 'string' || !/^p[1-9]$/.test(c.pid)) return null;
  return { reply, pid: c.pid };
}

const clip = (v, n = 60) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** 카드에 보일 한 줄 — 사용자가 무엇을 승인하는지 알 수 있게 동작과 대상을 적는다 */
export function proposalSummary(name, a = {}, lang = 'ko') {
  const say = (ko, en) => (lang === 'en' ? en : ko);
  const risky = confirmNeeded(name, a, lang);
  if (risky) return risky;
  const t = clip(a.title), id = a.id ? ` (id ${clip(a.id, 40)})` : '';
  switch (`${name}.${a.action}`) {
    case 'calendar.create': return say(`일정 만들기: ${t || '(제목 없음)'}${a.start ? ` · ${clip(a.start, 20)}` : ''}`, `Create event: ${t || '(untitled)'}${a.start ? ` · ${clip(a.start, 20)}` : ''}`);
    case 'calendar.update': return say(`일정 고치기${t ? `: ${t}` : ''}${id}`, `Update event${t ? `: ${t}` : ''}${id}`);
    case 'calendar.delete': return say(`일정 삭제${id} — 되돌릴 수 없습니다`, `Delete event${id} — cannot be undone`);
    case 'office.company_set': return say(`회사 정보 고치기: ${clip(a.label || a.key || a.id, 30)}`, `Update company info: ${clip(a.label || a.key || a.id, 30)}`);
    case 'office_files.attach': return say(`문서함에 올리기: ${clip(a.title || a.path)}`, `Upload to Office files: ${clip(a.title || a.path)}`);
    case 'office_files.drive_import': return say('드라이브 파일을 문서함으로 가져오기', 'Import a Drive file into Office files');
    case 'office_files.drive_mkdir': return say(`드라이브 폴더 만들기: ${clip(a.name)}`, `Create Drive folder: ${clip(a.name)}`);
    case 'office_work.task_add': return say(`할 일 추가: ${t}${a.due_on ? ` · 기한 ${clip(a.due_on, 12)}` : ''}`, `Add task: ${t}${a.due_on ? ` · due ${clip(a.due_on, 12)}` : ''}`);
    case 'office_work.task_set': return say(`할 일 고치기${a.status === 'done' ? '(끝내기)' : ''}${t ? `: ${t}` : ''}${id}`, `Update task${a.status === 'done' ? ' (finish)' : ''}${t ? `: ${t}` : ''}${id}`);
    case 'office_work.page_add': return say(`페이지 만들기: ${t || '(제목 없음)'}`, `Create page: ${t || '(untitled)'}`);
    case 'office_work.page_edit': return say(`페이지에 덧붙이기${id}`, `Append to page${id}`);
    case 'office_deals.customer_add': return say(`거래처 추가: ${clip(a.name)}`, `Add customer: ${clip(a.name)}`);
    case 'office_deals.customer_set': return say(`거래처 고치기${a.name ? `: ${clip(a.name)}` : ''}${id}`, `Update customer${a.name ? `: ${clip(a.name)}` : ''}${id}`);
    case 'office_deals.deal_add': return say(`거래 추가: ${t}`, `Add deal: ${t}`);
    case 'office_deals.deal_next': return say(`거래 단계 넘기기(${clip(a.to, 12)})${id}`, `Move deal stage (${clip(a.to, 12)})${id}`);
    case 'office_deals.deal_due': return say(`입금 예정일 바꾸기: ${clip(a.due_on, 12)}${id}`, `Set payment due date: ${clip(a.due_on, 12)}${id}`);
    case 'office_mail.mail_draft': return say(`메일 초안 쓰기${a.subject ? `: ${clip(a.subject)}` : ''}${a.to ? ` → ${clip(a.to, 40)}` : ''}`, `Write mail draft${a.subject ? `: ${clip(a.subject)}` : ''}${a.to ? ` → ${clip(a.to, 40)}` : ''}`);
    case 'office_mail.mail_star': return say(`메일 별표 ${a.starred === false ? '떼기' : '달기'}${id}`, `${a.starred === false ? 'Unstar' : 'Star'} mail${id}`);
    case 'office_briefing.brief_add': return say(`브리핑 쓰기: ${t || '(제목 없음)'}`, `Write briefing: ${t || '(untitled)'}`);
    default: return say(`오피스 ${name} ${a.action}`, `Office ${name} ${a.action}`);
  }
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/**
 * 패널 턴의 쓰기 관문. 반환: null(그대로 실행) | 에이전트에게 돌려줄 글(제안으로 모았거나 더 못 모음).
 * ctx.officePanel·officeAuto·proposals는 게이트웨이가 서버에서 정한 값이다(msgr.mjs) — 도구 인자에서 오지 않는다.
 */
export function panelWriteGate(ctx, name, args, lang = 'ko') {
  const a = args ?? {};
  if (!isWrite(name, a)) return null;
  // 패널에서 시작한 일이 넘김·예약·긴 작업·결재 후속으로 다른 턴이 된 경우 — 그 답은 패널 카드로 오지 않는다. 쓰기는 하지 않고 패널에서 다시 요청하게 한다(검수 M1)
  if (ctx?.officePanel !== true && ctx?.officePanelChain === true) return (lang === 'en'
    ? 'This work started from the Office agent panel, and Office changes from it run only through a confirmation card there. Nothing was changed — tell the user to ask again in the Office agent panel.'
    : '오피스 에이전트 창에서 시작한 일이라 오피스 데이터 변경은 그 창의 확인 카드로만 한다. 바꾸지 않았다 — 오피스 에이전트 창에서 다시 요청해 달라고 알려라.');
  if (ctx?.officePanel !== true) return null;
  if (ctx.officeAuto === true && !alwaysConfirm(name, a)) return null;
  const say = (ko, en) => (lang === 'en' ? en : ko);
  const list = (ctx.proposals ??= []);
  const hit = list.find((p) => p.tool === name && same(p.args, a));
  if (hit) return say(`이미 확인 카드(${hit.pid})로 올렸다. 다시 부르지 마라.`, `Already posted as confirmation card ${hit.pid}. Do not call it again.`);
  if (list.length >= PROPOSAL_MAX) return say(`한 답에 확인 카드는 ${PROPOSAL_MAX}개까지다 — 이 동작은 올리지 않았다. 나머지는 사용자가 카드를 처리한 뒤 다음 요청에서 하겠다고 알려라.`,
    `At most ${PROPOSAL_MAX} confirmation cards per reply — this one was not posted. Say the rest can follow after the user handles the cards.`);
  if (bytes(a) > ARGS_MAX || list.reduce((n, p) => n + bytes(p.args), bytes(a)) > ALL_MAX) return say('인자가 너무 커서 확인 카드로 올리지 못했다 — 나눠서 다시 제안하라.', 'The arguments are too large for a confirmation card — split it and propose again.');
  const p = { pid: `p${list.length + 1}`, tool: name, args: a, summary: proposalSummary(name, a, lang) };
  list.push(p);
  return say(`실행하지 않고 확인 카드(${p.pid})로 올렸다: ${p.summary}\n사용자가 오피스 에이전트 창에서 [실행]을 누르면 그때 실행된다. 실행했다고 말하지 말고, 확인 카드를 올렸다고 짧게 알려라.`,
    `Not executed — posted as confirmation card ${p.pid}: ${p.summary}\nIt runs when the user presses Run in the Office agent panel. Do not say it was done; briefly say you posted a confirmation card.`);
}

/** 이 턴에 회사 외부 MCP(mcp.json)를 붙이지 않는가(0.1.105, 총괄 정책 결정 2026-10-13 — 패널은 오피스 작업 전용, '쓰기 기본값: 늘 확인 카드'를 러너와 관계없이 지킨다).
    확인 카드 관문은 오피스 도구만 거른다 — 외부 MCP는 SDK에선 권한 게이트 mcp 분기(금지 경로만 막음), codex·gemini에선 CLI 설정으로 바로 붙어 도구별로 가로챌 수 없다.
    패널 턴(바로 실행 꺼짐)·패널 사슬 턴(넘김·예약·결재 후속)·패널 조율자의 동기 위임 동료 턴(panelNoMcp — chat.mjs delegateRulesCtx)이 대상. 일반 메신저·데스크톱 턴은 지금 그대로 */
export const panelNoExternalMcp = (ctx) => (ctx?.officePanel === true && ctx.officeAuto !== true) || ctx?.officePanelChain === true || ctx?.panelNoMcp === true;
export const panelMcpNote = (lang = 'ko') => (lang === 'en'
  ? '\n## Office agent panel\n- External tools (MCP) connected to the company are not available in the Office agent panel. If the user asks for work in another service (e.g. the intranet), do not try it — tell them to ask for it in the 1:1 chat with you in Messenger.'
  : '\n## 오피스 에이전트 창\n- 회사에 연결된 외부 도구(MCP)는 오피스 에이전트 창에서 쓰지 않는다. 다른 서비스(인트라넷 등)의 일을 부탁받으면 시도하지 말고, 외부 도구 작업은 메신저의 이 에이전트 1:1 대화에서 요청해 달라고 알려라.');

/** 오피스 패널 턴에서 예약·긴 작업을 거절하는 문구 — 그 나중 턴은 패널 사슬이라 오피스 쓰기를 못 해(위 관문) 매번 실패할 예약이 생긴다(검수 M-a).
    메신저 1:1에서 요청하면 지금처럼 만든다 */
export const panelLaterNo = (lang = 'ko') => (lang === 'en'
  ? 'Schedules and long tasks are not created from the Office agent panel yet — their later runs cannot show confirmation cards here. Nothing was created; tell the user to ask for it in the 1:1 chat with you in Messenger.'
  : '오피스 에이전트 창에서는 아직 예약·긴 작업을 만들지 않는다 — 나중 실행에는 이 창의 확인 카드를 띄울 수 없다. 만들지 않았다 — 메신저의 이 에이전트 1:1 대화에서 요청해 달라고 알려라.');

/** 답 글 meta에 실을 제안 목록(검증된 모양만) */
export const proposalsMeta = (ctx) => (Array.isArray(ctx?.proposals) && ctx.proposals.length
  ? { office_proposals: ctx.proposals.slice(0, PROPOSAL_MAX).map(({ pid, tool, args, summary }) => ({ pid, tool, args, summary })) } : {});

/** 확인 글이 가리키는 제안을 답 글에서 찾는다 — 같은 방·같은 에이전트의 답이고 그 pid가 있어야 한다. 반환: 제안 | null */
export function findProposal(row, { channelId, crewId, pid }) {
  if (!row || row.deleted_at || row.author_kind !== 'crew' || row.crew_id !== crewId || row.channel_id !== channelId) return null;
  const list = row.meta?.office_proposals;
  if (!Array.isArray(list)) return null;
  const p = list.find((x) => x && x.pid === pid);
  if (!p || typeof p.tool !== 'string' || !WRITES[p.tool] || !p.args || typeof p.args !== 'object' || Array.isArray(p.args) || !isWrite(p.tool, p.args)) return null;
  return p;
}
