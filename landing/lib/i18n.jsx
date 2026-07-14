'use client';

import { createContext, useContext, useEffect, useState } from 'react';

// key → [ko, en] — 모든 UI 문자열은 반드시 이 사전을 경유한다 (프로젝트 절대 규칙)
// 카피 원칙 (2026-07-14 개정): 은유는 비주얼이 담당한다. 텍스트는
// "자율형 AI 에이전트"라는 정체와 구체적 기능·이득을 직설로 말한다.
const DICT = {
  // nav
  'nav.cta': ['다운로드', 'Download'],
  'nav.lang': ['EN', 'KO'],

  // hero — 표지
  'hero.kicker': ['자율형 AI 에이전트', 'The autonomous AI agent'],
  'hero.cover': ['출항하라', 'Set S*ai*l'],
  'hero.statement': [
    '프롬프트 한 줄이면 AI 에이전트 팀이 만들어지고, 스스로 협업해 일을 끝냅니다.',
    'One prompt builds a team of AI agents — they collaborate and finish the work *on their own*.',
  ],
  'hero.scroll': ['스크롤로 기능 보기', 'Scroll to explore'],

  // 1장 — 에이전트 생성
  'ch1.num': ['제 1 장', 'Chapter I'],
  'ch1.short': ['에이전트 생성', 'Create Agents'],
  'ch1.sub': ['프롬프트 한 줄로 AI 직원을 만듭니다', 'AI teammates from a single prompt'],
  'ch1.tagline': [
    '채용 공고도 온보딩도 없습니다. 직무를 말하면 그 일의 전문 에이전트가 즉시 만들어집니다.',
    'No job posts, no onboarding. Describe a role and a specialist agent is ready in seconds.',
  ],
  'ch1.cap': ['프롬프트 한 줄 생성 · 에이전트 간 협업', 'One-prompt creation · agent collaboration'],
  'feat1.label': ['데모 — 에이전트 생성', 'Demo — Creating an agent'],
  'feat1.title': ['직무를 말하면, 에이전트가 만들어집니다', 'Describe the job, get the agent'],
  'feat1.body': [
    '"마케팅 카피 쓰는 직원 뽑아줘" — 한 줄이면 역할·규칙·도구까지 갖춘 전문 에이전트가 즉시 합류합니다.',
    '"Hire me a marketing copywriter" — one line, and a specialist agent joins with its role, rules, and tools already set.',
  ],
  'feat2.label': ['데모 — 에이전트 협업', 'Demo — Agents collaborating'],
  'feat2.title': ['에이전트들이 서로 협업합니다', 'Agents work together'],
  'feat2.body': [
    '에이전트끼리 일을 나누고, 넘기고, 서로 검토합니다. 사람이 중간에서 전달할 필요가 없습니다.',
    'They split tasks, hand off work, and review each other — no human relay in the middle.',
  ],

  // 2장 — 무한 기억
  'ch2.num': ['제 2 장', 'Chapter II'],
  'ch2.short': ['무한 기억', 'Memory'],
  'ch2.sub': ['폴더째 기억하는 로컬 장기기억', 'Folder-scale local memory'],
  'ch2.tagline': [
    '설치하면 무한 장기기억·규칙·하네스가 로컬에 갖춰집니다. 일할수록 아는 것이 쌓이고 연결됩니다.',
    'Install once and unlimited long-term memory, rules, and harnesses live locally — knowledge stacks and links as agents work.',
  ],
  'ch2.cap': ['풀 패키지 설치 · 폴더 기억 · 지식 복리 · 토큰 절약', 'Full package · folder memory · compounding · token thrift'],
  'feat3.label': ['데모 — 풀 패키지 설치', 'Demo — Full package install'],
  'feat3.title': ['설치 한 번에 풀 패키지', 'One install, everything included'],
  'feat3.body': [
    '앱 설치만으로 무한 장기기억, 규칙, 각종 하네스가 로컬에 세팅됩니다. 별도 구축 작업이 없습니다.',
    'Installing the app sets up unlimited long-term memory, rules, and harnesses locally. Nothing else to build.',
  ],
  'feat4.label': ['데모 — 폴더 단위 기억', 'Demo — Folder-scale memory'],
  'feat4.title': ['마크다운 한 장이 아니라, 폴더째 기억합니다', 'Not one note — whole folders'],
  'feat4.body': [
    '메모 한 장 수준이 아닙니다. 폴더 전체가 에이전트의 기억이 되어 프로젝트 맥락이 통째로 보존됩니다.',
    'Not a single markdown note: entire folders become the agent’s memory, preserving full project context.',
  ],
  'feat5.label': ['데모 — 지식 복리', 'Demo — Compounding knowledge'],
  'feat5.title': ['기억이 서로 연결되어, 지식이 복리로 쌓입니다', 'Memories link — knowledge compounds'],
  'feat5.body': [
    '유사한 기억끼리 자동으로 링크됩니다. 쓰면 쓸수록 에이전트가 아는 것이 곱해집니다.',
    'Similar memories link automatically. The more you use it, the more your agents know.',
  ],
  'feat6.label': ['데모 — 토큰 절약 검색', 'Demo — Token-saving recall'],
  'feat6.title': ['필요한 기억만 읽어 토큰을 아낍니다', 'Reads only what the task needs'],
  'feat6.body': [
    '컨텍스트를 읽을 때 키워드 검색으로 업무와 관련된 기억만 골라 씁니다. 기억은 무한, 토큰 비용은 최소.',
    'Keyword search pulls only task-relevant memory into context. Unlimited memory, minimal token cost.',
  ],

  // 3장 — 텔레그램 연동
  'ch3.num': ['제 3 장', 'Chapter III'],
  'ch3.short': ['텔레그램 연동', 'Telegram'],
  'ch3.sub': ['주머니 속에서 에이전트에게 지시', 'Command your agents from your pocket'],
  'ch3.tagline': [
    '클릭 한 번으로 텔레그램과 연결됩니다. 어디서든 메시지로 일을 시키고 결과를 받아보세요.',
    'One click connects Telegram. Assign work and get results by message, wherever you are.',
  ],
  'ch3.cap': ['원클릭 연결 · 헤르메스 대비 2배 속도', 'One-click connect · 2× Hermes speed'],
  'feat7.label': ['데모 — 텔레그램 연결', 'Demo — Telegram connect'],
  'feat7.title': ['텔레그램, 클릭 한 번에 연결', 'One-click Telegram'],
  'feat7.body': [
    '복잡한 설정 없이 클릭 한 번이면 연결됩니다. 메시지로 지시하고, 메시지로 보고받습니다.',
    'No setup maze — one click and you’re connected. Assign by message, get reports by message.',
  ],
  'feat8.label': ['데모 — 2배 빠른 송수신', 'Demo — 2× faster messaging'],
  'feat8.title': ['송수신 속도, 헤르메스의 2배', '2× faster than Hermes'],
  'feat8.body': [
    '텔레그램 송수신이 헤르메스 대비 2배 빠릅니다. 지시와 응답의 왕복이 즉각적입니다.',
    'Telegram round-trips run twice as fast as Hermes. Ask and answer, instantly.',
  ],

  // 4장 — 스킬 자동화
  'ch4.num': ['제 4 장', 'Chapter IV'],
  'ch4.short': ['스킬 자동화', 'Skills'],
  'ch4.sub': ['반복 업무는 자동으로 기술이 됩니다', 'Repeated work becomes a skill'],
  'ch4.tagline': [
    '같은 일을 두 번 하면 에이전트가 스스로 스킬로 저장합니다. 필요한 능력은 마켓에서 원클릭 설치.',
    'Do something twice and the agent saves it as a skill. Anything else installs from the marketplace in one click.',
  ],
  'ch4.cap': ['반복 업무 자동 스킬화 · 원클릭 설치', 'Auto-forged skills · one-click install'],
  'feat9.label': ['데모 — 자동 스킬화', 'Demo — Auto-skill creation'],
  'feat9.title': ['2번 반복되면, 자동으로 스킬이 됩니다', 'Repeat it twice — it becomes a skill'],
  'feat9.body': [
    '두 번 이상 반복된 업무를 에이전트가 알아서 스킬로 만들어 저장합니다. 세 번째부터는 지시 없이도 능숙합니다.',
    'Any task repeated twice is saved as a skill automatically. By the third time, no instructions needed.',
  ],
  'feat10.label': ['데모 — 스킬 원클릭 설치', 'Demo — One-click skills'],
  'feat10.title': ['스킬·MCP 전부 원클릭 설치', 'Every skill & MCP, one click'],
  'feat10.body': [
    'Skillsmp에 있는 모든 스킬과 MCP를 클릭 한 번에 설치합니다. 에이전트의 능력이 끝없이 확장됩니다.',
    'Install any skill or MCP on Skillsmp with a single click. Your agents’ abilities keep expanding.',
  ],

  // 5장 — 자동 실행
  'ch5.num': ['제 5 장', 'Chapter V'],
  'ch5.short': ['자동 실행', 'Automation'],
  'ch5.sub': ['자는 동안 일하고, 쉴 땐 0원', 'Works while you sleep, free while idle'],
  'ch5.tagline': [
    '작업을 예약하면 정해진 시각에 스스로 실행하고 결과를 보고합니다. 대기 중에는 토큰을 전혀 쓰지 않습니다.',
    'Schedule tasks and they run on their own, reporting back when done. While idle, not a single token is spent.',
  ],
  'ch5.cap': ['예약 실행 · 대기 중 토큰 0원', 'Scheduled runs · zero idle tokens'],
  'feat11.label': ['데모 — 예약 자동화', 'Demo — Scheduled automation'],
  'feat11.title': ['예약해두면, 아침에 완성되어 있습니다', 'Schedule it — done by morning'],
  'feat11.body': [
    '반복 작업을 예약하면 정해진 시각에 에이전트가 실행하고 결과만 보고합니다. 확인만 하면 됩니다.',
    'Schedule recurring work and agents run it on time, reporting the results. You just review.',
  ],
  'feat12.label': ['데모 — 대기 비용 0원', 'Demo — Zero idle cost'],
  'feat12.title': ['대기 중엔 토큰 0원', 'Zero tokens while idle'],
  'feat12.body': [
    '에이전트가 일하지 않는 동안엔 토큰을 전혀 쓰지 않습니다. 항상 켜두어도 비용 걱정이 없습니다.',
    'When agents aren’t working, they cost nothing. Leave Argo on without worrying about the bill.',
  ],

  // 데모 셀 공통
  'demo.tag': ['데모', 'Demo'],
  'interlude.cap': [
    '유사한 기억이 자동으로 연결됩니다 — 지식이 복리로 쌓입니다',
    'Similar memories link automatically — knowledge compounds',
  ],

  // download
  'download.kicker': ['다운로드', 'Download'],
  'download.title': ['지금 Argo를 설치하세요', 'Get Argo now'],
  'download.sub': [
    '설치하고 프롬프트 한 줄로 첫 에이전트를 만들어 보세요. macOS와 Windows를 지원합니다.',
    'Install and create your first agent with a single prompt. Available for macOS and Windows.',
  ],
  'download.mac': ['macOS용 다운로드', 'Download for macOS'],
  'download.win': ['Windows용 다운로드', 'Download for Windows'],
  'download.note': ['macOS 13+ · Windows 10+ · Apple Silicon/Intel', 'macOS 13+ · Windows 10+ · Apple Silicon/Intel'],

  // pricing
  'pricing.kicker': ['가격', 'Pricing'],
  'pricing.title': ['쓰는 만큼만, 단순하게', 'Simple, usage-based pricing'],
  'pricing.p1.name': ['무료', 'Free'],
  'pricing.p1.price': ['₩0', '$0'],
  'pricing.p1.per': ['', ''],
  'pricing.p1.f1': ['에이전트 3개까지', 'Up to 3 agents'],
  'pricing.p1.f2': ['로컬 무한 장기기억', 'Unlimited local memory'],
  'pricing.p1.f3': ['텔레그램 연동', 'Telegram integration'],
  'pricing.p2.name': ['프로', 'Pro'],
  'pricing.p2.price': ['₩29,000', '$19'],
  'pricing.p2.per': ['/월', '/mo'],
  'pricing.p2.f1': ['에이전트 무제한', 'Unlimited agents'],
  'pricing.p2.f2': ['자동 스킬화 + 원클릭 스킬 설치', 'Auto-skills + one-click installs'],
  'pricing.p2.f3': ['작업 예약 자동화', 'Scheduled automation'],
  'pricing.p2.f4': ['우선 지원', 'Priority support'],
  'pricing.p3.name': ['팀', 'Team'],
  'pricing.p3.price': ['문의', 'Contact'],
  'pricing.p3.per': ['', ''],
  'pricing.p3.f1': ['팀 워크스페이스', 'Team workspaces'],
  'pricing.p3.f2': ['전용 온보딩', 'Dedicated onboarding'],
  'pricing.p3.f3': ['SSO · 감사 로그', 'SSO · Audit logs'],
  'pricing.note': ['가격은 정식 출시 시 확정됩니다.', 'Final pricing will be confirmed at launch.'],
  'pricing.hot': ['가장 인기', 'Most popular'],

  // footer
  'footer.line': [
    'Argo — 스스로 일하는 자율형 AI 에이전트.',
    'Argo — autonomous AI agents that work on their own.',
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
