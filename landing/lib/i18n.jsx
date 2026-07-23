'use client';

import { createContext, useContext, useEffect, useState } from 'react';

// key → [ko, en] — 모든 UI 문자열은 반드시 이 사전을 경유한다 (프로젝트 절대 규칙)
// 카피 원칙 (2026-07-14 개정): 은유는 비주얼이 담당한다. 텍스트는
// "자율형 AI 에이전트"라는 정체와 구체적 기능·이득을 직설로 말한다.
const DICT = {
  // nav
  'nav.cta': ['다운로드', 'Download'],
  'nav.lang': ['EN', 'KO'],
  'nav.docs': ['문서', 'Docs'],
  'nav.install': ['설치', 'Install'],
  'nav.contact': ['문의', 'Contact'],
  'nav.githubSoon': ['GitHub — 공개 예정', 'GitHub — coming soon'],

  // hero — 표지
  'hero.kicker': ['자율형 AI 에이전트', 'The autonomous AI agent'],
  'hero.cover': ['출항하라', 'Set S*ai*l'],
  'hero.statement': [
    '프롬프트 한 줄이면 AI 에이전트 팀이 만들어지고, 스스로 협업해 일을 끝냅니다.',
    'One prompt builds a team of AI agents — they collaborate and finish the work *on their own*.',
  ],
  'hero.scroll': ['스크롤로 기능 보기', 'Scroll to explore'],

  // install — 히어로와 1장 사이 터미널 한 줄 인터루드 (2026-07-23)
  'install.kicker': ['터미널 설치', 'Install via terminal'],
  'install.line': ['설치도, *한 줄*이면 충분합니다.', 'Installing takes just *one line*, too.'],
  'install.copy': ['복사', 'Copy'],
  'install.copied': ['복사됨', 'Copied'],
  'install.note.mac': [
    '최신 Apple Silicon 앱을 받아 바로 엽니다. 버튼이 편하시면 아래 다운로드 섹션을 이용하세요.',
    'Downloads the latest Apple Silicon app and opens it. Prefer a button? Use the download section below.',
  ],
  'install.note.win': [
    'PowerShell에 붙여넣으면 설치 프로그램을 받아 실행합니다.',
    'Paste into PowerShell — downloads and runs the installer.',
  ],
  'install.note.linux': [
    '리눅스(x86_64) 서버에 상주 서비스로 설치됩니다. 업데이트는 같은 명령 재실행.',
    'Installs as a self-healing service on Linux (x86_64). Re-run the same line to update.',
  ],

  // Core Four — Argo만의 후킹 포인트 (2026-07-14 유건 지정: 최우선 강조 4개)
  'core.kicker': ['Argo가 다른 이유', 'Why Argo is different'],
  'core1.title': ['무한 장기 기억', 'Infinite memory'],
  'core1.body': [
    '대화가 끝나도 잊지 않습니다. 한계 없는 로컬 장기기억이 계속 쌓입니다.',
    'Nothing is forgotten when the chat ends — unlimited local long-term memory keeps growing.',
  ],
  'core2.title': ['LLM 위키 내장', 'Built-in LLM wiki'],
  'core2.body': [
    '기억이 위키처럼 서로 연결되고 에이전트끼리 공유됩니다. 맥락이 자산이 됩니다.',
    'Memories link like a wiki and are shared across agents — context becomes an asset.',
  ],
  'core3.title': ['로그인 = 맥락 동기화', 'Log in, context follows'],
  'core3.body': [
    '기기가 바뀌어도 로그인 한 번이면 모든 맥락이 그대로 따라옵니다.',
    'Switch devices and just sign in — every bit of context follows you.',
  ],
  'core4.title': ['PC 대화를 텔레그램으로', 'Continue on Telegram'],
  'core4.body': [
    '책상에서 하던 대화를 이동 중에 텔레그램에서 그대로 이어갑니다.',
    'The conversation you started at your desk continues on Telegram, seamlessly.',
  ],

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
  'feat5.label': ['데모 — LLM 위키', 'Demo — LLM wiki'],
  'feat5.title': ['LLM 위키 — 기억이 서로 연결됩니다', 'A built-in LLM wiki'],
  'feat5.body': [
    '유사한 기억이 위키 문서처럼 자동으로 링크되고 에이전트들이 함께 씁니다. 지식이 복리로 쌓입니다.',
    'Memories link like wiki pages and every agent shares them. Knowledge compounds.',
  ],
  'feat6.label': ['데모 — 토큰 절약 검색', 'Demo — Token-saving recall'],
  'feat6.title': ['필요한 기억만 읽어 토큰을 아낍니다', 'Reads only what the task needs'],
  'feat6.body': [
    '컨텍스트를 읽을 때 키워드 검색으로 업무와 관련된 기억만 골라 씁니다. 기억은 무한, 토큰 비용은 최소.',
    'Keyword search pulls only task-relevant memory into context. Unlimited memory, minimal token cost.',
  ],

  // 3장 — 이어지는 맥락 (텔레그램 이어가기 · 기기 동기화)
  'ch3.num': ['제 3 장', 'Chapter III'],
  'ch3.short': ['이어지는 맥락', 'Continuity'],
  'ch3.sub': ['어디서든, 어떤 기기서든 이어집니다', 'Pick up anywhere, on any device'],
  'ch3.tagline': [
    'PC에서 하던 대화를 텔레그램으로, 기기가 바뀌면 로그인 한 번으로 — 일과 맥락이 당신을 따라다닙니다.',
    'Hand off desktop conversations to Telegram, or sign in on a new device — your work and context follow you.',
  ],
  'ch3.cap': ['텔레그램 이어가기 · 기기 간 맥락 동기화', 'Telegram hand-off · device context sync'],
  'feat7.label': ['데모 — 텔레그램 연결', 'Demo — Telegram connect'],
  'feat7.title': ['텔레그램, 클릭 한 번에 연결', 'One-click Telegram'],
  'feat7.body': [
    '복잡한 설정 없이 클릭 한 번이면 연결됩니다. 송수신 속도는 헤르메스의 2배 — 지시와 보고가 즉각적입니다.',
    'One click and you’re connected — with round-trips 2× faster than Hermes. Assign and get reports instantly.',
  ],
  'feat8.label': ['데모 — 대화 이어가기', 'Demo — Conversation hand-off'],
  'feat8.title': ['PC에서 하던 대화, 텔레그램으로 이어서', 'Start on desktop, continue on Telegram'],
  'feat8.body': [
    '책상에서 시작한 대화를 이동 중에 그대로 이어갑니다. 맥락도 기억도 끊기지 않습니다.',
    'Pick up the exact conversation you left at your desk — context and memory intact.',
  ],
  'feat13.label': ['데모 — 기기 간 동기화', 'Demo — Device sync'],
  'feat13.title': ['기기가 바뀌어도, 로그인하면 그대로', 'New device? Just log in'],
  'feat13.body': [
    '새 컴퓨터든 다른 작업실이든 로그인 한 번이면 기억·규칙·진행 중인 일이 전부 동기화됩니다.',
    'On any new machine, one sign-in restores your memory, rules, and work in progress.',
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

  // star modal (다운로드 전 깃헙 스타 요청)
  'star.title': ['잠깐 — 스타 하나가 큰 힘이 됩니다', 'One star goes a long way'],
  'star.desc': [
    'Argo가 쓸 만해 보인다면 깃헙 스타로 응원해 주세요. 아래 버튼을 누르면 깃헙 승인 창이 뜨고, 승인하는 순간 스타가 자동으로 눌린 뒤 다운로드 페이지로 이동합니다.',
    'If Argo looks useful, a GitHub star helps a lot. Approve on GitHub and the star is added automatically — then you land right on the download page.',
  ],
  'star.yes': ['스타 누르고 다운로드', 'Star & download'],
  'star.no': ['그냥 다운로드', 'Just download'],
  'star.hint': ['깃헙 계정의 별점(star) 권한만 요청하며, 그 외 어떤 것도 접근하지 않습니다.', 'We only request starring permission — nothing else.'],

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
  'footer.nav': ['푸터 내비게이션', 'Footer navigation'],

  // side nav (데스크톱 좌측)
  'side.top': ['표지', 'Cover'],
  'side.core': ['핵심', 'Why Argo'],

  // contact
  'contact.kicker': ['문의', 'Contact'],
  'contact.title': ['무엇이든 물어보세요', 'Tell us what you need'],
  'contact.sub': [
    '도입·협업·기술 문의 무엇이든 좋습니다. 보내주시면 빠르게 답변드립니다.',
    'Adoption, partnership, or technical questions — send a note and we’ll reply promptly.',
  ],
  'contact.subject': ['문의', 'Inquiry'],
  'contact.f.name': ['이름', 'Name'],
  'contact.f.email': ['이메일', 'Email'],
  'contact.f.msg': ['내용', 'Message'],
  'contact.send': ['문의 보내기', 'Send message'],
  'contact.note': [
    '보내기를 누르면 메일 앱이 열리며 내용이 채워집니다.',
    'Sending opens your mail app with the message prefilled.',
  ],

  // docs
  'docs.kicker': ['문서', 'Docs'],
  'docs.title': ['Argo 사용 설명서', 'Argo documentation'],
  'docs.updated': ['업데이트 2026-07-15', 'Updated 2026-07-15'],
  'docs.lede': [
    '프롬프트 한 줄로 AI 직원 회사를 만들고, 폴더 단위 기억으로 일을 시키는 방법을 안내합니다.',
    'How to build a company of AI employees from a single prompt and put them to work with folder-scale memory.',
  ],
  'docs.sp.h': ['시스템 프롬프트', 'System prompt'],
  'docs.sp.p': [
    '각 크루는 하나의 시스템 프롬프트 카드로 정의됩니다. runner·model·역할·팀 메타와 전문성·규칙으로 구성되며, 대화 중 축적된 회사 기억이 함께 주입됩니다. 아래는 예시 카드입니다.',
    'Each crew is defined by one system-prompt card: runner/model/role/team metadata plus expertise and rules, with the company memory accumulated over conversations injected alongside. Example card below.',
  ],
  'docs.sp.note': [
    '실제 카드는 앱의 크루 상세(Card)에서 확인·편집할 수 있습니다.',
    'The live card can be viewed and edited from the crew detail (Card) inside the app.',
  ],

  // legal (약관·개인정보)
  'legal.kicker': ['정책', 'Legal'],
  'legal.updated': ['시행일 2026-07-15', 'Effective 2026-07-15'],
  'legal.terms': ['이용약관', 'Terms of Service'],
  'legal.privacy': ['개인정보처리방침', 'Privacy Policy'],
  'terms.title': ['이용약관', 'Terms of Service'],
  'privacy.title': ['개인정보처리방침', 'Privacy Policy'],
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
