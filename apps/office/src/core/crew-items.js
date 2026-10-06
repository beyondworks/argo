// 맡기기 항목 글자 뽑기(17차 A-5) — 거래·거래처·일정·견적·계약·회사 정보를 크루에게 보낼 글자로. 순수 함수(테스트: test/crew-items.test.mjs).
// 화면이 메뉴를 누른 순간 자기 데이터로 부른다(그 화면 사전이 이미 올라와 있어 이름표는 화면 사전 키를 쓴다). 글자는 맡기기 창이 "지시 아님" 표지로 감싼다.
// 사용자가 직접 고른 항목만 보내지만, 계좌·사업자번호는 업무에 필요한 칸이 아니라 싣지 않는다(유건 10/4).

import { guessKey, IMAGE_KEYS } from './company-model.js';
import { ACCOUNT_LABEL_WORDS } from './match-i18n.js';

const clean = (v) => (v == null ? '' : String(v).trim());
/** [이름표, 값] → "이름표: 값" 줄 — 빈 값은 뺀다 */
export const fieldLines = (pairs) => pairs.filter(([, v]) => clean(v)).map(([k, v]) => `${k}: ${clean(v)}`).join('\n');
const blocks = (...parts) => parts.filter((p) => clean(p)).join('\n\n');
const listBlock = (head, rows) => (rows.length ? `${head}:\n${rows.map((r) => `- ${r}`).join('\n')}` : '');

/** 거래처에서 싣는 칸 — 계좌(account)·사업자번호(biz_no)는 넣지 않는다. 이 목록 밖의 칸은 글자에 들어가지 않는다 */
export const CUSTOMER_FIELDS = ['category', 'customerStatus', 'ceo', 'manager', 'phone', 'email', 'address'];
export function customerText(c, data, t) {
  const value = { category: t(`bizui.category.${c.category ?? 'customer'}`), customerStatus: t(`bizui.status.${c.status ?? 'active'}`), ceo: c.ceo, manager: c.manager, phone: c.phone, email: c.email, address: c.address };
  const deals = (data?.orders ?? []).filter((o) => o.customer_id === c.id && o.status !== 'cancelled').map((o) => clean(o.title)).filter(Boolean);
  return blocks(fieldLines(CUSTOMER_FIELDS.map((k) => [t(`bizui.${k}`), value[k]])), clean(c.notes) && `${t('bizui.notes')}:\n${clean(c.notes)}`, listBlock(t('bizui.card.deals'), deals));
}

/** 거래 — 거래처·단계·입금 예정일·금액(공급가액·세액·합계·받은 돈·받을 돈)·품목·메모. amounts·stage는 화면이 deal-model로 계산해 넘긴다(장부 계산을 두 벌 두지 않게) */
export function dealText(o, data, { t, money, amounts, stage }) {
  const customer = data.customers.find((c) => c.id === o.customer_id)?.name;
  const lines = data.lines.filter((l) => l.order_id === o.id).map((l) => `${clean(l.name)} × ${l.quantity} (${money(l.unit_price)})`);
  const notes = (data.links ?? []).filter((l) => l.order_id === o.id && l.kind === 'note').map((l) => clean(l.body)).filter(Boolean);
  return blocks(fieldLines([[t('bizui.customer'), customer], [t('bizui.status'), stage && t(stage === 'cancelled' ? 'bizui.cancelled' : `bizui.stage.${stage}`)], [t('bizui.dueOn'), o.due_on],
    ...(amounts ? ['supply', 'vat', 'total', 'paid', 'receivable'].map((k) => [t(`bizui.${k}`), money(amounts[k])]) : [])]),
  listBlock(t('bizui.line'), lines), listBlock(t('bizui.notes'), notes));
}

/** 일정 회차의 시작·끝 글자 — 종일이면 날짜만(하루면 끝은 비움), 시간 일정은 날짜 + 시각(같은 날이면 끝은 시각만). day·time은 화면 형식 함수 */
export function spanText(it, { day, time, allDay }) {
  if (it.allDay) return { start: `${day(it.day)} (${allDay})`, end: it.last && it.last !== it.day ? day(it.last) : '' };
  return { start: `${day(it.day)} ${time(it.start)}`, end: it.last && it.last !== it.day ? `${day(it.last)} ${time(it.end)}` : time(it.end) };
}
/** 일정 — 시작·끝·장소·분류·거래처·메모. 참석자는 이름표가 화면마다 달라 싣지 않는다 */
export function eventText(ev, { t, start, end }) {
  return blocks(fieldLines([[t('cal.f.start'), start], [t('cal.f.end'), end], [t('cal.f.location'), ev.location], [t('cal.f.category'), ev.category], [t('cal.f.customer'), ev.customer_name]]),
    clean(ev.note) && `${t('cal.f.note')}:\n${clean(ev.note)}`);
}

/** 일정 맡기기 공간 — 일정마다 그 조직의 공간(개인 일정 = 내 공간). 조직이 섞이거나 모르는 조직이면 null(맡기지 않는다 — 기록 맡기기 assignMany와 같은 규칙).
 *  지금 보는 공간(내 공간·홈 캘린더)으로 맡기면 A 조직 일정이 B 조직 크루의 대화로 갈 수 있었다(17차 A 검수 MEDIUM-1) */
export function assignSpace(orgIds, spaceOf) {
  const set = new Set(orgIds.map((o) => (o ? spaceOf(o)?.key ?? null : 'me')));
  return set.size === 1 && !set.has(null) ? [...set][0] : null;
}

/** 견적서·계약서(목록 한 줄) — 종류·거래처·거래·합계·만든 날. 입력값(품목·조항)은 목록에 없어 싣지 않는다(새 읽기를 만들지 않는다) */
export function quoteText(d, { t, money, deal, day }) {
  return fieldLines([[t('docs.col.kind'), t(`docs.kind.${d.kind}`)], [t('docs.col.customer'), d.customer_name], [t('docs.col.deal'), deal], [t('docs.col.total'), d.total != null ? money(d.total) : ''], [t('docs.col.created'), d.created_at ? day(d.created_at) : '']]);
}

/** 회사 정보 중 값을 싣지 않는 항목 — 계좌(은행 분류·이름표에 계좌·예금주)·사업자번호·법인등록번호·그림(도장·로고). 거래처와 같은 기준이고, 그림은 글자가 아니다.
 *  key가 없는 항목은 이름표로 짐작한다(화면·서식과 같은 guessKey) — key 없는 사업자번호·https 도장·'기타'의 입금 계좌가 새어 나갔다(17차 A 검수 MEDIUM-2) */
const WITHHELD_KEYS = ['biz_no', 'corp_no', ...IMAGE_KEYS];
const ACCOUNT_LABEL = new RegExp(ACCOUNT_LABEL_WORDS.join('|'), 'i');
export const companyWithheld = (x) => {
  const key = x.key || guessKey(x.label);
  return x.category === 'bank' || WITHHELD_KEYS.includes(key) || ACCOUNT_LABEL.test(clean(x.label)) || /^data:image\//i.test(clean(x.value));
};
/** 회사 정보 항목들 — "이름: 값", 메모는 다음 줄. 값을 싣지 않는 항목은 이름과 안내만(메모에도 계좌가 적혀 있을 수 있어 메모도 뺀다) */
export function companyText(items, t) {
  return items.map((x) => {
    const held = companyWithheld(x);
    return [`${clean(x.label)}: ${held ? t('company.crewWithheld') : clean(x.value)}`, !held && clean(x.notes) && `  ${clean(x.notes)}`].filter(Boolean).join('\n');
  }).join('\n');
}
