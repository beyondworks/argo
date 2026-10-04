// 화면 전체 가리기(18차)가 덮는 값과 그동안의 가리기 메뉴 — 순수 함수(test/hide-all.test.mjs, test/r18-review.test.mjs). 켜고 끄는 상태는 core/hide-all.js.
// 값 가리기(Redact)에는 무엇의 값인지(kind)를 붙인다: amount(금액) · contact(담당자·대표자·전화·이메일·주소) · account(계좌) · bizno(사업자번호) · mail(메일 제목·요약·본문)
// · memo(자유 메모 — 계좌·전화가 적히는 일이 있다) · name(거래처·회사·직원 이름) · title(거래 건명·할 일 제목). kind를 붙이지 않은 값은 가린다 — 가림 칸이 있는 값은 원래 민감한 값이라, 빠뜨려도 새지 않게.

/** 전체 가리기에서도 그대로 보이는 값 — 무엇에 관한 화면인지는 알아야 회의를 이어 갈 수 있다(유건 결정 4: 거래처 이름·할 일 제목은 그대로) */
export const HIDE_ALL_KEEP = ['name', 'title'];

/** 이 값이 지금 가려지는가 — 값마다 가리기(on)와 전체 가리기(all) 중 하나라도 가리면 가린다. 이유: 전체 가리기를 꺼도 따로 가린 값은 그대로 가려져 있어야 한다 */
export const isMasked = ({ on, all, kind }) => !!on || (!!all && !HIDE_ALL_KEEP.includes(kind));

/** 전체 가리기 중 가리기 메뉴 자리의 안내(사전 키, redact-i18n.js) */
export const HIDE_ALL_NOTE = 'bizui.hideAllNote';
/** 가리기·가리기 해제 메뉴(값 하나·고른 칸·고른 줄) — 전체 가리기 중에는 쓰기 항목 대신 누를 수 없는 안내 한 줄. tr = 이미 번역한 메뉴에 넣을 때 번역 함수.
 *  이유: 화면이 이미 가려져 있어 눌러도 변화가 안 보이는데, 거래처 가림처럼 조직 공용 칸은 서버에서 바뀐다 — 전체 가리기를 끄면 계좌가 조직 모두에게 보이는 사고 경로 */
// 메뉴·선택 막대를 그린 뒤 ⌘⇧H로 켜는 경우 — 누르는 순간 다시 본다(2차 검수 LOW-A). 기본은 <html data-hide-all>(core/hide-all.js가 켜고 끈다)
const domAll = () => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-hide-all');
export const redactMenu = (items, all, tr = (k) => k, now = domAll) => (all ? [{ heading: tr(HIDE_ALL_NOTE) }]
  : items.map((it) => (it && it.run ? { ...it, run: (...a) => (now() ? undefined : it.run(...a)) } : it)));
