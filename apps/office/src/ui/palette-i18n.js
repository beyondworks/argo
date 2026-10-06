// 검색·명령 팔레트 사전 — 그 화면과 함께 지연 로드된다(첫 화면 150KB 상한, 7차 bundle.md ①). 원래 core/i18n.js에 있던 값을 그대로 옮겼다
export const PALETTE_DICT = {
  'palette.ph': ['페이지·메일 검색 또는 명령', 'Search pages and mail, or run a command'], 'palette.pages': ['페이지', 'Pages'], 'palette.commands': ['명령', 'Commands'],
  'palette.mail': ['메일', 'Mail'], 'palette.none': ['결과 없음', 'No results'], 'cmd.newMail': ['새 메일 쓰기', 'Write new mail'],
  // 테마 명령 이름 — ⌘K 명령(core/commands.js globalCommands)에서만 쓴다(첫 화면 150KB 상한, 10/5 core/i18n.js에서 옮김)
  'cmd.theme': ['테마: {name}', 'Theme: {name}'], 'cmd.shell': ['앱 셸: {name}', 'App shell: {name}'],
  'theme.linen': ['린넨 · 시스템', 'Linen · System'], 'theme.linen-light': ['린넨 · 라이트', 'Linen · Light'], 'theme.linen-dark': ['린넨 · 다크', 'Linen · Dark'],
  'theme.graphite': ['그래파이트 · 시스템', 'Graphite · System'], 'theme.graphite-light': ['그래파이트 · 라이트', 'Graphite · Light'], 'theme.graphite-dark': ['그래파이트 · 다크', 'Graphite · Dark'],
  'theme.cream': ['크림 · 시스템', 'Cream · System'], 'theme.cream-light': ['크림 · 라이트', 'Cream · Light'], 'theme.cream-dark': ['크림 · 다크', 'Cream · Dark'],
  'theme.sand': ['샌드 · 시스템', 'Sand · System'], 'theme.sand-light': ['샌드 · 라이트', 'Sand · Light'], 'theme.sand-dark': ['샌드 · 다크', 'Sand · Dark'],
  'theme.peach': ['피치 · 시스템', 'Peach · System'], 'theme.peach-light': ['피치 · 라이트', 'Peach · Light'], 'theme.peach-dark': ['피치 · 다크', 'Peach · Dark'],
  'theme.mist': ['미스트 · 시스템', 'Mist · System'], 'theme.mist-light': ['미스트 · 라이트', 'Mist · Light'], 'theme.mist-dark': ['미스트 · 다크', 'Mist · Dark'],
  'theme.glow': ['글로우 · 시스템', 'Glow · System'], 'theme.glow-light': ['글로우 · 라이트', 'Glow · Light'], 'theme.glow-dark': ['글로우 · 다크', 'Glow · Dark'],
  'theme.sage': ['세이지 · 시스템', 'Sage · System'], 'theme.sage-light': ['세이지 · 라이트', 'Sage · Light'], 'theme.sage-dark': ['세이지 · 다크', 'Sage · Dark'],
  'theme.ocean': ['오션 · 시스템', 'Ocean · System'], 'theme.ocean-light': ['오션 · 라이트', 'Ocean · Light'], 'theme.ocean-dark': ['오션 · 다크', 'Ocean · Dark'],
  'theme.rose': ['로즈 · 시스템', 'Rose · System'], 'theme.rose-light': ['로즈 · 라이트', 'Rose · Light'], 'theme.rose-dark': ['로즈 · 다크', 'Rose · Dark'],
  'theme.lavender': ['라벤더 · 시스템', 'Lavender · System'], 'theme.lavender-light': ['라벤더 · 라이트', 'Lavender · Light'], 'theme.lavender-dark': ['라벤더 · 다크', 'Lavender · Dark'],
  'theme.slate': ['슬레이트 · 시스템', 'Slate · System'], 'theme.slate-light': ['슬레이트 · 라이트', 'Slate · Light'], 'theme.slate-dark': ['슬레이트 · 다크', 'Slate · Dark'],
  'theme.ember': ['엠버 · 시스템', 'Ember · System'], 'theme.ember-light': ['엠버 · 라이트', 'Ember · Light'], 'theme.ember-dark': ['엠버 · 다크', 'Ember · Dark'],
};
