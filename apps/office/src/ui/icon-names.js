// 앱 아이콘 이름 → Google Material Symbols(Outlined) 이름. 유건 10/2: "아이콘들은 구글에서 제공하는 아이콘팩으로 통일".
// 이 표가 정본이다 — scripts/icon-font.mjs가 이 표로 글꼴(ui/symbols.woff2)을 뽑고 Icon.jsx의 글자표를 다시 쓴다.
// 앱 번들에는 들어가지 않는다(글꼴 생성 스크립트와 테스트만 읽는다). 옛 이름을 그대로 두어 호출부는 바뀌지 않는다.
export const MATERIAL = {
  home: 'home',
  eye: 'visibility',
  eyeOff: 'visibility_off',
  mail: 'mail',
  inbox: 'inbox',
  send: 'send',
  draft: 'edit', // 연필(편집·서명 칸)
  archive: 'archive',
  doc: 'description',
  lock: 'lock',
  stamp: 'approval', // 결재 도장
  run: 'schedule', // 업무(진행 중)
  check: 'check',
  x: 'close',
  file: 'draft', // 빈 문서(접힌 귀)
  book: 'book',
  plus: 'add',
  search: 'search',
  gear: 'settings',
  trash: 'delete',
  dots: 'more_horiz',
  caret: 'expand_more',
  chevron: 'chevron_right',
  back: 'chevron_left',
  grip: 'drag_indicator',
  share: 'ios_share',
  globe: 'language',
  link: 'link',
  copy: 'content_copy',
  reply: 'reply',
  hand: 'assignment_ind', // 에이전트에게 맡기기
  width: 'width',
  sidebar: 'side_navigation',
  menu: 'menu',
  layout: 'dashboard',
  history: 'history',
  template: 'space_dashboard',
  resize: 'resize',
  building: 'domain',
  person: 'person',
  info: 'info',
  refresh: 'refresh',
  chart: 'bar_chart',
  box: 'deployed_code',
  tag: 'sell',
  receipt: 'receipt_long',
  deal: 'swap_horiz',
  megaphone: 'campaign',
  calendar: 'calendar_today',
  star: 'star', // 켜짐은 같은 글자에 FILL 1(.ico.fill)
  sign: 'contract_edit', // 견적·계약(문서+펜)
  folder: 'folder',
  target: 'target',
  // 문서함(files/FIcon.jsx가 이 이름으로 넘긴다 — Google Drive 표시만 상표라 FIcon에 그림으로 남긴다)
  upload: 'upload',
  download: 'download',
  pdf: 'picture_as_pdf',
  image: 'image',
  pin: 'keep',
  // 글 편집기 '/' 블록 메뉴(pages/Editor.jsx)
  text: 'title',
  h1: 'format_h1',
  h2: 'format_h2',
  h3: 'format_h3',
  bullet: 'format_list_bulleted',
  ordered: 'format_list_numbered',
  todo: 'checklist',
  quote: 'format_quote',
  code: 'code',
  divider: 'horizontal_rule',
  attach: 'attach_file',
  // 패널 펼치기·되돌리기(ui/Panel.jsx)
  expand: 'open_in_full',
  collapse: 'close_fullscreen',
};
