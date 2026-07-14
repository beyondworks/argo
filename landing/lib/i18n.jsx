'use client';

import { createContext, useContext, useEffect, useState } from 'react';

// key → [ko, en] — 모든 UI 문자열은 반드시 이 사전을 경유한다 (프로젝트 절대 규칙)
const DICT = {
  // nav
  'nav.cta': ['다운로드', 'Download'],
  'nav.lang': ['EN', 'KO'],

  // hero
  'hero.kicker': ['여덟 영웅 · 한 배 · 하나의 목적지', 'Eight heroes · One ship · One destination'],
  'hero.title1': ['한 줄의 말로,', 'With a single line,'],
  'hero.title2': ['회사가 창조된다', 'a company is created'],
  'hero.sub': [
    '프롬프트 한 줄이면 각 분야의 AI 전문가들이 승선합니다. 당신의 아르고호는 오늘 출항합니다.',
    'One prompt, and AI experts of every craft come aboard. Your Argo sets sail today.',
  ],
  'hero.scroll': ['스크롤하여 항해 시작', 'Scroll to set sail'],
  'hero.est': ['자율형 AI 크루', 'Autonomous AI crew'],
  'hero.cover': ['출항하라', 'Set S*ai*l'],
  'hero.statement': ['한 줄의 말로, 회사가 창조된다.', 'With a single line, a company is *created*.'],

  // 색인 행 (Identifont식)
  'ch1.short': ['소집', 'The Crew'],
  'ch1.cap': ['프롬프트 한 줄 채용 · 크루 협업', 'One-line hiring · crew collaboration'],
  'ch2.short': ['기억의 선창', 'The Hold'],
  'ch2.cap': ['풀 패키지 설치 · 폴더 기억 · 지식 복리 · 토큰 절약', 'Full package · folder memory · compounding · token thrift'],
  'ch3.short': ['전령의 바람', 'The Messenger'],
  'ch3.cap': ['텔레그램 원클릭 · 헤르메스의 2배 속도', 'One-click Telegram · 2× Hermes speed'],
  'ch4.short': ['연금술', 'The Forge'],
  'ch4.cap': ['반복 업무 자동 스킬화 · 원클릭 장착', 'Auto-forged skills · one-click install'],
  'ch5.short': ['자동 항해', 'The Silent Voyage'],
  'ch5.cap': ['예약 실행 · 대기 중 토큰 0원', 'Scheduled runs · zero idle tokens'],

  // 챕터 세리프 서브라인 (Shopify H3 문법)
  'ch1.sub': ['영웅들이 배에 오른다', 'Heroes come aboard'],
  'ch2.sub': ['항해는 기록될수록 깊어진다', 'A voyage deepens as it is written'],
  'ch3.sub': ['헤르메스보다 빠르게', 'Swifter than Hermes'],
  'ch4.sub': ['항해술이 스스로 벼려진다', 'Seamanship tempers itself'],
  'ch5.sub': ['잠든 사이에도 배는 나아간다', 'The ship sails while you sleep'],

  // 데모 셀 공통
  'demo.tag': ['데모', 'Demo'],
  'interlude.cap': ['닮은 기억이 이어져 별자리가 된다', 'Kindred memories join into constellations'],

  // chapter 1 — 소집
  'ch1.num': ['제 1 장', 'Chapter I'],
  'ch1.title': ['소집 — 영웅들이 배에 오른다', 'The Crew — heroes come aboard'],
  'ch1.tagline': [
    '황금양털을 향한 항해엔 노 젓는 사람이 아니라, 저마다의 기술을 가진 영웅이 필요합니다.',
    'A voyage for the golden fleece needs not rowers, but heroes — each with a craft of their own.',
  ],
  'feat1.label': ['데모 — 크루 채용', 'Demo — Hiring the crew'],
  'feat1.title': ['직무를 말하면, 전문가가 승선합니다', 'Name the job, and a specialist boards'],
  'feat1.body': [
    '프롬프트 한 줄로 직무에 맞는 에이전트가 만들어집니다. 채용 공고도, 온보딩도 없이 — 말하는 순간 크루가 됩니다.',
    'One line of prompt creates an agent fit for the role. No job posting, no onboarding — spoken, and it is crew.',
  ],
  'feat2.label': ['데모 — 크루 협업', 'Demo — Crew collaboration'],
  'feat2.title': ['크루는 서로 부르고, 함께 끝냅니다', 'The crew calls each other, and finishes together'],
  'feat2.body': [
    '에이전트들이 서로 일을 넘기고 검토하며 협업합니다. 혼자 일하는 AI가 아니라, 손발이 맞는 선원들입니다.',
    'Agents hand off work, review each other, and collaborate. Not a lone AI — a crew that rows in rhythm.',
  ],

  // chapter 2 — 기억의 선창
  'ch2.num': ['제 2 장', 'Chapter II'],
  'ch2.title': ['기억의 선창 — 항해는 기록될수록 깊어진다', 'The Hold — a voyage deepens as it is written'],
  'ch2.tagline': [
    '배 밑창에 쌓이는 항해일지처럼, 당신의 크루는 일할수록 더 많이 기억합니다.',
    'Like logbooks stacked in the hold, your crew remembers more with every voyage.',
  ],
  'feat3.label': ['데모 — 풀 패키지 설치', 'Demo — Full package install'],
  'feat3.title': ['설치 한 번, 완전한 배 한 척', 'One install, a fully rigged ship'],
  'feat3.body': [
    '앱을 설치하면 무한 장기기억, 규칙, 각종 하네스가 담긴 풀 패키지가 로컬에 갖춰집니다. 항해 준비는 그걸로 끝입니다.',
    'Install the app and a full package lands locally — infinite long-term memory, rules, and every harness. The ship is rigged.',
  ],
  'feat4.label': ['데모 — 폴더 단위 기억', 'Demo — Folder-scale memory'],
  'feat4.title': ['한 장이 아니라, 폴더 통째로 기억합니다', 'Not a single page — whole folders remembered'],
  'feat4.body': [
    '마크다운 한 장짜리 메모가 아닙니다. 폴더 전체가 크루의 기억이 되어, 맥락이 통째로 보존됩니다.',
    'Not a one-page markdown note. Entire folders become the crew’s memory, context preserved whole.',
  ],
  'feat5.label': ['데모 — 지식 복리', 'Demo — Compounding knowledge'],
  'feat5.title': ['닮은 기억이 이어져, 지식이 복리로 쌓입니다', 'Kindred memories link, and knowledge compounds'],
  'feat5.body': [
    '유사한 기억끼리 자동으로 링크됩니다. 별과 별이 이어져 별자리가 되듯, 아는 것이 곱해집니다.',
    'Similar memories link themselves. As stars join into constellations, what is known multiplies.',
  ],
  'feat6.label': ['데모 — 토큰 절약 검색', 'Demo — Token-saving recall'],
  'feat6.title': ['필요한 맥락만 골라 읽습니다', 'It reads only the context that matters'],
  'feat6.body': [
    '컨텍스트를 읽을 때 키워드 서칭으로 업무와 관련된 기억만 찾아 씁니다. 기억은 무한, 토큰은 최소.',
    'Keyword search pulls only work-relevant memory into context. Memory unbounded, tokens minimal.',
  ],

  // chapter 3 — 전령의 바람
  'ch3.num': ['제 3 장', 'Chapter III'],
  'ch3.title': ['전령의 바람 — 헤르메스보다 빠르게', 'The Messenger — swifter than Hermes'],
  'ch3.tagline': [
    '배는 바다에 있어도, 전령은 언제나 당신 곁에 있습니다.',
    'The ship may be at sea, but the messenger is always at your side.',
  ],
  'feat7.label': ['데모 — 텔레그램 연결', 'Demo — Telegram connect'],
  'feat7.title': ['텔레그램, 클릭 한 번에 연결', 'Telegram, connected in one click'],
  'feat7.body': [
    '원클릭이면 주머니 속에서 크루에게 일을 시킵니다. 사무실은 이제 당신이 서 있는 곳입니다.',
    'One click, and you command the crew from your pocket. The office is wherever you stand.',
  ],
  'feat8.label': ['데모 — 2배 빠른 송수신', 'Demo — 2× faster messaging'],
  'feat8.title': ['송수신 속도, 전령의 신의 두 배', 'Message speed, twice the god of messengers'],
  'feat8.body': [
    '텔레그램 송수신이 헤르메스보다 2배 빠릅니다. 물음이 닿기 전에, 답이 돌아옵니다.',
    'Telegram round-trips run 2× faster than Hermes. The answer returns before the question lands.',
  ],

  // chapter 4 — 연금술
  'ch4.num': ['제 4 장', 'Chapter IV'],
  'ch4.title': ['연금술 — 항해술이 스스로 벼려진다', 'The Forge — seamanship tempers itself'],
  'ch4.tagline': [
    '같은 파도를 두 번 넘으면, 크루는 그 길을 기술로 만듭니다.',
    'Cross the same wave twice, and the crew forges the crossing into craft.',
  ],
  'feat9.label': ['데모 — 자동 스킬화', 'Demo — Auto-skill forging'],
  'feat9.title': ['두 번 반복된 일은, 스스로 기술이 됩니다', 'Repeat a task twice, and it becomes a skill'],
  'feat9.body': [
    '2번 이상 반복되는 업무를 크루가 알아서 스킬로 만듭니다. 세 번째부터는 시키지 않아도 능숙합니다.',
    'Work repeated twice is forged into a skill on its own. By the third time, mastery needs no orders.',
  ],
  'feat10.label': ['데모 — 스킬 원클릭 장착', 'Demo — One-click skills'],
  'feat10.title': ['세상의 모든 기술, 클릭 한 번에 장착', 'Every craft in the world, equipped in a click'],
  'feat10.body': [
    'Skillsmp에 존재하는 모든 스킬과 MCP를 원클릭으로 설치합니다. 크루의 무기고는 끝없이 넓어집니다.',
    'Install any skill or MCP on Skillsmp with one click. The crew’s armory grows without end.',
  ],

  // chapter 5 — 자동 항해
  'ch5.num': ['제 5 장', 'Chapter V'],
  'ch5.title': ['자동 항해 — 잠든 사이에도 배는 나아간다', 'The Silent Voyage — the ship sails while you sleep'],
  'ch5.tagline': [
    '키를 잡고 있지 않아도 항로는 지켜지고, 바람이 없는 날엔 한 푼도 들지 않습니다.',
    'The course holds without a hand on the helm — and a windless day costs nothing.',
  ],
  'feat11.label': ['데모 — 예약 자동화', 'Demo — Scheduled automation'],
  'feat11.title': ['일은 예약되고, 아침에 완성되어 있습니다', 'Work is scheduled, and done by morning'],
  'feat11.body': [
    '자동화 작업을 예약하면 정해진 시각에 크루가 스스로 움직입니다. 당신은 결과만 확인하면 됩니다.',
    'Schedule a task and the crew moves on its own at the appointed hour. You only review the result.',
  ],
  'feat12.label': ['데모 — 대기 비용 0원', 'Demo — Zero idle cost'],
  'feat12.title': ['대기 중엔, 토큰 0원', 'While waiting: zero tokens'],
  'feat12.body': [
    '크루가 일하지 않는 동안엔 토큰을 전혀 쓰지 않습니다. 정박 중인 배는 바람을 소모하지 않습니다.',
    'When the crew isn’t working, not a single token is spent. A ship at anchor burns no wind.',
  ],

  // download
  'download.kicker': ['출항 준비', 'Ready to sail'],
  'download.title': ['당신의 아르고호를 진수하세요', 'Launch your own Argo'],
  'download.sub': [
    '지금 설치하고, 한 줄의 말로 첫 크루를 승선시키세요.',
    'Install now and bring your first crew aboard with a single line.',
  ],
  'download.mac': ['macOS용 다운로드', 'Download for macOS'],
  'download.win': ['Windows용 다운로드', 'Download for Windows'],
  'download.note': ['macOS 13+ · Windows 10+ · Apple Silicon/Intel', 'macOS 13+ · Windows 10+ · Apple Silicon/Intel'],

  // pricing
  'pricing.kicker': ['가격', 'Pricing'],
  'pricing.title': ['항해의 규모만큼만 지불하세요', 'Pay only for the scale of your voyage'],
  'pricing.p1.name': ['보이저', 'Voyager'],
  'pricing.p1.price': ['무료', 'Free'],
  'pricing.p1.per': ['', ''],
  'pricing.p1.f1': ['크루 3명까지', 'Up to 3 crew members'],
  'pricing.p1.f2': ['로컬 무한 장기기억', 'Unlimited local long-term memory'],
  'pricing.p1.f3': ['텔레그램 연결', 'Telegram connection'],
  'pricing.p2.name': ['내비게이터', 'Navigator'],
  'pricing.p2.price': ['₩29,000', '$19'],
  'pricing.p2.per': ['/월', '/mo'],
  'pricing.p2.f1': ['크루 무제한', 'Unlimited crew'],
  'pricing.p2.f2': ['자동 스킬화 + Skillsmp 원클릭', 'Auto-skills + one-click Skillsmp'],
  'pricing.p2.f3': ['자동화 작업 예약', 'Scheduled automation'],
  'pricing.p2.f4': ['우선 지원', 'Priority support'],
  'pricing.p3.name': ['아르마다', 'Armada'],
  'pricing.p3.price': ['문의', 'Contact'],
  'pricing.p3.per': ['', ''],
  'pricing.p3.f1': ['팀 워크스페이스', 'Team workspaces'],
  'pricing.p3.f2': ['전용 온보딩', 'Dedicated onboarding'],
  'pricing.p3.f3': ['SSO · 감사 로그', 'SSO · Audit logs'],
  'pricing.note': ['가격은 정식 출시 시 확정됩니다.', 'Final pricing will be confirmed at launch.'],
  'pricing.hot': ['가장 인기', 'Most popular'],

  // footer
  'footer.line': [
    'Argo — 서로 다른 전문성의 크루, 한 배, 하나의 목적지.',
    'Argo — crew of different expertise, one ship, one destination.',
  ],
  'footer.copy': ['© 2026 Argo. All rights reserved.', '© 2026 Argo. All rights reserved.'],
};

const LangContext = createContext(null);

export function LanguageProvider({ children }) {
  // 기본 영문, 한국어는 토글 (2026-07-13 유건 지시)
  const [lang, setLang] = useState('en');

  useEffect(() => {
    const saved = typeof window !== 'undefined' && localStorage.getItem('argo-landing-lang');
    if (saved === 'en' || saved === 'ko') setLang(saved);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem('argo-landing-lang', lang);
    } catch {}
  }, [lang]);

  // cmd+/ (mac) · ctrl+/ (win) — 언어 전환
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setLang((l) => (l === 'ko' ? 'en' : 'ko'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const t = (key, vars) => {
    const entry = DICT[key];
    let s = entry ? entry[lang === 'ko' ? 0 : 1] : key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  };

  const toggle = () => setLang((l) => (l === 'ko' ? 'en' : 'ko'));

  return <LangContext.Provider value={{ lang, t, toggle }}>{children}</LangContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LanguageProvider');
  return ctx;
}
