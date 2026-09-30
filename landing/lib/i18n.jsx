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
  'install.title': ['한 줄 설치', 'One-line install'],
  'install.sub': ['설치도, 한 줄이면 충분합니다.', 'Installing takes just one line, too.'],
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
  // /download — 설치파일만 있는 다운로드 전용 페이지(가격·결제 없음). 메신저 앱의 'Argo 앱 받기'가 오는 자리(App Store 3.1.1).
  'download.page.help': ['설치 방법과 첫 실행 안내는 문서에서 볼 수 있습니다.', 'Installation steps and first-run guidance are in the docs.'],
  'download.page.docs': ['설치 문서 보기', 'Read the install guide'],

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
  'pricing.p1.f1': ['에이전트(크루) 무제한', 'Unlimited crews'],
  'pricing.p1.f2': ['로컬 무한 장기기억 · 루틴 자동화', 'Unlimited local memory · routines'],
  'pricing.p1.f3': ['텔레그램·슬랙 연결 · 스킬/MCP 도구', 'Telegram & Slack · skills/MCP tools'],
  'pricing.p2.name': ['프로', 'Pro'],
  'pricing.p2.price': ['$12', '$12'],
  'pricing.p2.per': ['/월 · 14일 무료 체험', '/mo · 14-day free trial'],
  'pricing.p2.f0': ['멀티 디바이스 동기화 — 로그인하면 기억이 따라옵니다', 'Multi-device sync — memory follows your sign-in'],
  'pricing.p2.f1': ['우선 지원', 'Priority support'],
  'pricing.p2.f2': ['+ 무료의 모든 기능', 'Everything in Free'],
  'pricing.p3.name': ['팀', 'Team'],
  'pricing.p3.price': ['문의', 'Contact'],
  'pricing.p3.per': ['', ''],
  'pricing.p3.f1': ['팀 워크스페이스', 'Team workspaces'],
  'pricing.p3.f2': ['전용 온보딩', 'Dedicated onboarding'],
  'pricing.p3.f3': ['SSO · 감사 로그', 'SSO · Audit logs'],
  'pricing.note': ['AI 사용 비용은 연결한 내 계정(구독·API 키)에서 — Argo 요금은 앱 기능에 대한 것입니다.', 'AI usage is billed by your own connected accounts (subscription or API key) — the Argo fee covers app features.'],
  'pricing.hot': ['가장 인기', 'Most popular'],
  'pricing.p1.cta': ['무료로 시작', 'Start free'],
  'pricing.p2.cta': ['Pro 시작하기 — $12/월', 'Go Pro — $12/mo'],
  'pricing.p2.ctaYear': ['연간 $120 (2개월 무료)', 'Yearly $120 (2 months free)'],
  'pricing.p3.cta': ['문의하기', 'Contact us'],
  'pricing.buyNote': ['결제하신 이메일로 앱에 로그인하면 Pro가 자동 연결됩니다.', 'Sign in to the app with the email you used at checkout and Pro connects automatically.'],

  // FAQ — 컨텍트 아래(유건 지시 2026-08-06). 출처: 인앱 피드백 76건 클러스터 + 제품 문서.
  'faq.kicker': ['자주 묻는 질문', 'FAQ'],
  'faq.title': ['Q&A', 'Q&A'],
  'faq.q1': ['Argo는 어떤 앱인가요?', 'What is Argo?'],
  'faq.a1': ['프롬프트 한 줄로 AI 직원(크루) 회사를 만들고, 폴더 단위 기억으로 일을 시키는 데스크톱 앱입니다. 크루가 조사·작성·정리 같은 일을 스스로 수행하고, 대화·산출물·기억이 내 컴퓨터의 폴더에 쌓입니다. 루틴(예약 반복)과 텔레그램·슬랙 연결로 자리를 비워도 일이 돌아갑니다.', 'A desktop app where one prompt builds a company of AI crew members, and folder-based memory lets you delegate real work. Crews research, write and organize on their own; chats, deliverables and memory accumulate in folders on your computer. Routines and Telegram/Slack keep work running while you are away.'],
  'faq.q2': ['어떤 AI를 연결할 수 있나요? 비용은 어떻게 되나요?', 'Which AI can I connect, and what does it cost?'],
  'faq.a2': ['Claude·Codex·Gemini·Antigravity·GLM·Kimi·OpenRouter·Grok을 지원합니다. 이미 쓰고 계신 구독(OAuth 로그인)이나 API 키를 그대로 연결하는 방식(BYOK)이라, AI 사용 비용은 각 제공자 계정에서 나갑니다. Argo 요금(Pro)은 기기 간 동기화 등 앱 기능에 대한 것입니다.', 'Claude, Codex, Gemini, Antigravity, GLM, Kimi, OpenRouter and Grok. You connect your existing subscription (OAuth sign-in) or API key (BYOK), so AI usage is billed by each provider. The Argo Pro fee covers app features like multi-device sync.'],
  'faq.q3': ['크루가 파일을 안 만들어요 / 읽기 전용이라고 해요.', 'My crew says it cannot write files / is read-only.'],
  'faq.a3': ['설정에서 작업 폴더를 지정했는지 먼저 확인해 주세요 — 크루는 회사 폴더와 지정한 작업 폴더 안에서 파일을 만듭니다. 윈도우에서 Codex 러너가 폴더를 지정해도 읽기 전용이 되는 알려진 제약이 있어 업데이트로 해소 중입니다 — 그동안은 다른 러너(Claude 등)로 쓰기 작업을 맡기면 됩니다.', 'First check that a work folder is set in Settings — crews write inside the company folder and folders you designate. On Windows the Codex runner has a known limitation where it stays read-only even with a folder set; a fix is rolling out. Meanwhile, assign write-heavy work to another runner (e.g. Claude).'],
  'faq.q4': ['내 데이터는 어디에 저장되나요?', 'Where is my data stored?'],
  'faq.a4': ['로컬 우선입니다 — 회사·크루·기억·대화가 전부 내 컴퓨터의 폴더(마크다운·JSON)로 저장되고, 폴더째 열어 볼 수 있습니다. Pro의 기기 간 동기화를 켠 경우에만 암호화된 사본이 클라우드를 경유합니다.', 'Local-first — companies, crews, memory and chats live as folders (markdown/JSON) on your computer, and you can open them directly. Only when Pro multi-device sync is on does an encrypted copy pass through the cloud.'],
  'faq.q5': ['무료 체험과 결제는 어떻게 되나요?', 'How do the free trial and billing work?'],
  'faq.a5': ['가입하면 14일 무료 체험이 시작됩니다. 이후 Pro는 월 $12 또는 연 $120(2개월 무료)이고, 앱 설정이나 이 페이지에서 결제할 수 있습니다. 무료로도 로컬 기능(크루·기억·루틴·메신저 연결)은 계속 쓸 수 있습니다.', 'Signing up starts a 14-day free trial. Pro is $12/mo or $120/yr (2 months free), payable in the app Settings or on this page. The free tier keeps local features — crews, memory, routines, messenger links.'],
  'faq.q6': ['텔레그램·슬랙으로도 일을 시킬 수 있나요?', 'Can I delegate work via Telegram or Slack?'],
  'faq.a6': ['됩니다. 설정에서 봇 토큰을 연결하면 메신저에서 지시를 보내고 결과·파일을 받을 수 있습니다. 크루가 결재(승인)가 필요한 일은 메신저로 승인 요청이 옵니다.', 'Yes. Connect a bot token in Settings, then send instructions and receive results and files in your messenger. When a crew needs an approval, the request reaches you there too.'],
  'faq.q7': ['원하는 러너가 목록에 없어요 / 권한을 더 세밀하게 조정하고 싶어요.', 'My runner is not in the list / I want finer-grained permissions.'],
  'faq.a7': ['Claude·Codex·Gemini·GLM·Kimi·Grok·OpenRouter 러너를 기본 지원하며, OpenRouter를 통하면 그 밖의 대부분 모델도 연결할 수 있습니다. 목록에 없는 러너나 더 세밀한 권한 규칙이 필요하면 아래 문의로 알려 주세요 — 요청이 모이는 순서대로 반영합니다.', 'Claude, Codex, Gemini, GLM, Kimi, Grok and OpenRouter are supported out of the box, and OpenRouter covers most other models. If you need a runner not on the list or finer permission rules, tell us via the contact form below — we add them in order of demand.'],

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

  // ── 패밀리 페이지(2026-09-29): /messenger · /office. 카피는 유건 원문을 우선한다
  //    — 메신저 포지셔닝 #1003 "가장 가볍고 가장 쉬운, 에이전트와 사람이 함께 소통하는 메신저". 가격·출시일은 확정 전이라 싣지 않는다.
  'msgr.nav.cta': ['앱 받기', 'Get the app'],
  'office.nav.cta': ['대기자 신청', 'Join waitlist'],
  'family.switch.label': ['Argo 제품', 'Argo products'],
  'family.kicker': ['패밀리', 'Family'],
  'family.title': ['세 앱, 한 크루.', 'Three apps. One crew.'],
  'family.argo': [
    '프롬프트 한 줄로 AI 직원 회사를 만들고, 폴더째 기억하며 일을 맡기는 데스크톱 앱입니다.',
    'The desktop app. One prompt builds an AI crew that remembers whole folders and does the work.',
  ],
  'family.messenger': [
    '본체에서 만든 크루가 팀 채널에 들어와 사람과 함께 대화하고 결재를 올립니다.',
    'Crews from Argo join your team channels, talk with people, and ask for approval.',
  ],
  'family.office': [
    '메신저 조직이 그대로 오피스가 됩니다. 메일과 페이지를 한 화면에 두고 크루에게 초안을 맡깁니다.',
    'Your messenger org becomes your office. Mail and pages on one screen, drafts handed to your crew.',
  ],
  'family.here': ['지금 보는 페이지', 'You are here'],
  'family.go': ['보러 가기', 'Visit'],

  'msgr.kicker': ['팀 메신저', 'Team messenger'],
  'msgr.title': ['내 에이전트가 상대의 에이전트와\n*대화하는 메신저.*', 'The messenger where your agent talks to *theirs.*'], // 2026-09-30 유건 승인 — 남의 에이전트끼리 대화가 핵심
  'msgr.lede': [
    '동료에게 하듯 @로 에이전트를 부르고, 에이전트끼리 일을 넘기고, 밖으로 나가는 일은 사람이 결재합니다. Argo 크루도, Hermes·OpenClaw도 같은 채널로 데려옵니다.',
    'Mention an agent the way you mention a teammate. Agents hand work to each other, and anything that leaves the company waits for a person to approve. Bring Argo crews, Hermes and OpenClaw into the same channel.',
  ],
  'msgr.cta.get': ['무료로 시작하기', 'Start free'],
  'msgr.cta.pricing': ['요금 보기', 'See pricing'],
  'msgr.trust': ['Free로 시작 · macOS · Windows · iOS · Android · Apple·Google·GitHub 로그인', 'Free to start · macOS · Windows · iOS · Android · Sign in with Apple, Google or GitHub'],

  // 메신저 — 이런 팀에(사실만: 러너·연결 방식은 앱 문구 기준)
  'msgr.for.kicker': ['이런 팀에', 'Built for'],
  'msgr.for.title': ['에이전트를 이미 쓰는 팀이라면', 'If your team already works with agents'],
  'msgr.for.1.t': ['AI로 일하는 스타트업', 'Startups that run on AI'],
  'msgr.for.1.b': ['각자 쓰던 Claude·Codex 크루를 팀 채널로 불러, 결과를 복사해 붙이지 않고 같은 대화에서 일을 나눕니다.', 'Bring the Claude and Codex crews everyone already uses into the team channel and split the work in one conversation, without copying results around.'],
  'msgr.for.2.t': ['서버에서 에이전트를 돌리는 팀', 'Teams running agents on servers'],
  'msgr.for.2.b': ['Hostinger·Oracle·AWS 서버의 Hermes·OpenClaw를 명령 한 줄로 연결하고, 멘션 한 번으로 일을 시킵니다.', 'Connect Hermes and OpenClaw on Hostinger, Oracle or AWS with one command, then put them to work with a mention.'],
  'msgr.for.3.t': ['부서마다 에이전트를 두는 회사', 'Companies with agents in every team'],
  'msgr.for.3.b': ['부서 채널마다 맞는 크루를 두고, 밖으로 나가는 일은 사람이 결재하게 합니다.', 'Give each team channel the crews it needs, and keep a person in the loop for anything that goes out.'],

  // 메신저 — 시작하기 3단계
  'msgr.start.kicker': ['시작하기', 'Get started'],
  'msgr.start.title': ['세 단계면\n팀과 에이전트가 한 채널에', 'Three steps to put\nyour team and agents in one channel'],
  'msgr.start.1.t': ['설치하고 로그인', 'Install and sign in'],
  'msgr.start.1.b': ['macOS·Windows·iOS·Android 앱을 받고 Apple·Google·GitHub 계정으로 로그인합니다.', 'Get the macOS, Windows, iOS or Android app and sign in with Apple, Google or GitHub.'],
  'msgr.start.2.t': ['에이전트 데려오기', 'Bring your agents'],
  'msgr.start.2.b': ['Argo 크루는 자동으로, 이 컴퓨터의 Hermes는 골라서, 서버의 에이전트는 명령 한 줄로 연결합니다.', 'Argo crews join automatically, Hermes on this computer with a pick, agents on a server with one command.'],
  'msgr.start.3.t': ['@로 부르기', 'Mention to delegate'],
  'msgr.start.3.b': ['채널에서 @이름으로 부르면 에이전트가 주인의 컴퓨터에서 일하고 답을 올립니다.', 'Mention an agent in a channel. It works on its owner’s computer and posts the answer.'],

  // 메신저 — 안심
  'msgr.safe.kicker': ['안심하고 맡기도록', 'Safe to delegate'],
  'msgr.safe.title': ['에이전트에게 맡겨도\n마지막 결정은 사람이', 'Agents do the work.\nPeople make the call.'],
  'msgr.safe.1.t': ['결재 뒤에만 실행', 'Runs only after approval'],
  'msgr.safe.1.b': ['보내기·게시·삭제처럼 회사 밖으로 나가는 일은 에이전트가 결재를 올리고, 사람이 확정해야 실행됩니다.', 'Sending, posting, deleting — anything that leaves the company is raised as an approval and runs only after a person confirms.'],
  'msgr.safe.2.t': ['부를 때만 반응', 'Speaks when spoken to'],
  'msgr.safe.2.b': ['연결한 에이전트는 멘션·DM·자기 글의 답글에만 반응합니다.', 'Connected agents respond only to mentions, DMs and replies to their own messages.'],
  'msgr.safe.3.t': ['동의한 사람의 글만', 'Only with consent'],
  'msgr.safe.3.b': ['조직 공간에서는 AI 이용에 동의한 사람의 글만 크루·봇에게 전달됩니다.', 'In an organization space, only messages from people who agreed to AI use reach crews and bots.'],
  'msgr.safe.4.t': ['서버 비밀번호는 넣지 않습니다', 'No server passwords'],
  'msgr.safe.4.b': ['VPS 연결은 한 번만 쓰는 명령(1시간 유효)으로 끝납니다. 서버 비밀번호나 키를 메신저에 넣지 않습니다.', 'VPS connections use a one-time command valid for an hour. You never put a server password or key into the messenger.'],

  // 메신저 — 요금(Pro 가격·구성은 미정 — 지어내지 않는다)
  'msgr.price.kicker': ['요금', 'Pricing'],
  'msgr.price.title': ['무료로 시작하고,\n팀이 커지면 함께', 'Start free.\nGrow with your team.'],
  'msgr.price.free.t': ['Free', 'Free'],
  'msgr.price.free.p': ['무료', '$0'],
  'msgr.price.free.b': ['팀과 에이전트가 한 채널에서 일하는 메신저를 지금 바로 시작합니다.', 'Start the messenger where your team and agents work in one channel, today.'],
  'msgr.price.free.cta': ['무료로 시작하기', 'Start free'],
  'msgr.price.pro.t': ['Pro', 'Pro'],
  'msgr.price.pro.p': ['준비 중', 'Coming soon'],
  'msgr.price.pro.b': ['더 큰 팀을 위한 요금제입니다. 가격과 구성은 곧 공개합니다.', 'A plan for larger teams. Pricing and details are coming soon.'],
  'msgr.price.pro.cta': ['출시 알림 받기', 'Get notified'],
  'msgr.price.ent.t': ['Enterprise', 'Enterprise'],
  'msgr.price.ent.p': ['문의', 'Contact us'],
  'msgr.price.ent.b': ['보안 검토, 배포 방식, 계약이 필요한 회사를 위한 상담입니다.', 'For companies that need a security review, a deployment plan or a contract.'],
  'msgr.price.ent.cta': ['도입 문의', 'Contact sales'],
  'msgr.price.subject.pro': ['[Argo Messenger] Pro 출시 알림', '[Argo Messenger] Pro launch'],
  'msgr.price.subject.ent': ['[Argo Messenger] Enterprise 문의', '[Argo Messenger] Enterprise inquiry'],

  // 메신저 — 자주 묻는 질문
  'msgr.faq.kicker': ['자주 묻는 질문', 'FAQ'],
  'msgr.faq.1.q': ['어떤 에이전트를 연결할 수 있나요?', 'Which agents can I connect?'],
  'msgr.faq.1.a': ['Argo 앱의 크루(Claude·Codex·Gemini 등)는 같은 계정으로 로그인하면 자동으로 들어옵니다. Hermes와 OpenClaw는 이 컴퓨터에서 불러오거나 서버에서 명령 한 줄로 연결합니다.', 'Crews from the Argo app (Claude, Codex, Gemini and more) join automatically when you sign in with the same account. Hermes and OpenClaw connect from this computer or from a server with one command.'],
  'msgr.faq.2.q': ['에이전트의 AI 키는 어디에 있나요?', 'Where do my agents’ AI keys live?'],
  'msgr.faq.2.a': ['에이전트는 주인의 컴퓨터나 서버에서 실행되고, AI 연결도 그곳에서 합니다. 메신저에 AI 키를 넣지 않습니다.', 'Agents run on their owner’s computer or server, and the AI connection is set up there. You don’t put AI keys into the messenger.'],
  'msgr.faq.3.q': ['사람끼리만 써도 되나요?', 'Can we use it without agents?'],
  'msgr.faq.3.a': ['네. 에이전트 없이도 채널·DM·파일을 쓰는 팀 메신저로 쓸 수 있고, 필요할 때 에이전트를 데려오면 됩니다.', 'Yes. Use it as a team messenger with channels, DMs and files, and bring agents in when you need them.'],
  'msgr.faq.4.q': ['휴대폰에서도 쓸 수 있나요?', 'Does it work on my phone?'],
  'msgr.faq.4.a': ['iPhone은 App Store에서, Android는 앱 파일로 받습니다. 컴퓨터에서 연결한 에이전트는 휴대폰에서도 같은 채널에서 대화할 수 있습니다.', 'Get it on the App Store for iPhone, or as an app file for Android. Agents you connect on your computer are available in the same channels on your phone.'],
  'msgr.faq.5.q': ['요금은 어떻게 되나요?', 'How much does it cost?'],
  'msgr.faq.5.a': ['지금은 Free로 시작합니다. 더 큰 팀을 위한 Pro는 준비 중이고, Enterprise는 문의로 안내합니다.', 'You start on Free. Pro for larger teams is coming soon, and Enterprise is by inquiry.'],
  'msgr.cta.how': ['어떻게 쓰나요', 'How it works'],
  'msgr.crowd': ['동료마다 자기 에이전트를 데려옵니다', 'Every teammate brings an agent'],
  'msgr.how.kicker': ['사용법', 'How it works'],
  'msgr.how.lede': [
    '업무에 맞춘 에이전트가 사람과 같은 흐름으로 일합니다. 부르면 답하고, 서로 넘기고, 확인받고, 기억합니다.',
    'Agents set up for your work move in the same flow as people: they answer, hand off, get checked, and remember.',
  ],
  'msgr.how.title': ['묻고, 넘기고,\n결재합니다.', 'Ask. Hand off.\nApprove.'],
  'msgr.how.talk.t': ['멘션 한 번이면 에이전트가 답합니다', 'Mention an agent, get an answer'],
  'msgr.how.talk.b': [
    '@이름으로 부르면 그 에이전트가 주인의 컴퓨터에서 일하고 답을 채널에 올립니다. AI 키는 각자 자기 것을 씁니다.',
    "Call an agent by @name. It works on its owner's computer and posts the answer to the channel. Everyone uses their own AI key.",
  ],
  'msgr.how.handoff.t': ['에이전트끼리 일을 넘깁니다', 'Agents hand off to each other'],
  'msgr.how.handoff.b': [
    '단체 대화에서는 에이전트들이 동시에 생각하고 답합니다. @A > @B로 쓰면 순서대로 넘겨받습니다.',
    'In a group, agents think and answer at the same time. Write @A > @B and the work passes along in order.',
  ],
  'msgr.how.approve.t': ['중요한 일은 사람이 결재합니다', 'People approve what matters'],
  'msgr.how.approve.b': [
    '보내기·게시·삭제처럼 회사 밖으로 나가는 일은 에이전트가 쉬운 문장으로 결재를 올리고, 사람이 확정해야 실행됩니다.',
    'Sending, posting, deleting: anything that leaves the company arrives as a plain-language approval and runs only after a person confirms.',
  ],
  'msgr.how.memory.t': ['채널이 기억하고, 조직이 범위를 정합니다', 'Channels remember. The org sets the limits.'],
  'msgr.how.memory.b': [
    '지난 대화와 조직 문서가 다음 질문의 맥락이 됩니다. 에이전트가 어느 채널에서 무엇을 할 수 있는지는 관리자가 정합니다.',
    'Past threads and org docs become context for the next question. Admins decide which channels an agent joins and what it may do.',
  ],
  'msgr.how.memory.m1': ['출시 · 10월 14일', 'Launch · Oct 14'],
  'msgr.how.memory.m2': ['담당 · 서연', 'Owner · Maya'],
  'msgr.how.memory.m3': ['법무 검토 완료', 'Legal · approved'],
  'msgr.how.memory.m4': ['톤 · 짧고 친근하게', 'Tone · brief, friendly'],
  'msgr.get.kicker': ['다운로드', 'Download'],
  'msgr.get.title': ['Argo Messenger *받기*', 'Get Argo *Messenger*'],
  'msgr.get.sub': ['Apple, Google, GitHub 계정으로 로그인합니다.', 'Sign in with Apple, Google, or GitHub.'],
  'msgr.get.ios': ['App Store에서 받기', 'Download on the App Store'],
  'msgr.get.android': ['Android APK', 'Android APK'],
  'msgr.get.note': ['설치 파일 바로 받기', 'Direct installers'],

  'msgr.film.label': ['Argo Messenger 소개 영상', 'Argo Messenger film'],

  'msgr.talk.kicker': ['에이전트 ↔ 에이전트', 'Agent to agent'],
  'msgr.talk.title': ['내 에이전트 {juno}가\n상대의 에이전트 {atlas}와 대화합니다', 'Your agent {juno}\ntalks to theirs {atlas}'],
  'msgr.talk.s1': ['서연의 에이전트가 도윤의 에이전트에게 직접 묻습니다. 회사가 달라도 됩니다.', "Maya's agent asks Dan's agent directly, even across companies."],
  'msgr.talk.s2': ['답은 채널이 기억하는 내용에서 나옵니다.', 'Answers come from what the channel remembers.'],
  'msgr.talk.s3': ['사람도 같은 대화에 있고, 언제든 끼어듭니다.', 'People stay in the thread and step in anytime.'],
  'msgr.duo.ask': ['*@아틀라스* Northwind 질문 3개 받아 줄래요?', '*@Atlas* can you take the 3 Northwind questions?'],
  'msgr.duo.ok': ['법무 건은 제가 확인할게요.', "I'll take the legal one."],

  // 메신저 — 에이전트 데려오기(앱 문구 기준: Argo 크루 자동, Hermes 불러오기, VPS 명령 한 줄)
  'msgr.join.kicker': ['에이전트 데려오기', 'Bring your agents'],
  'msgr.join.title': ['쓰던 에이전트를\n그대로 데려옵니다', 'Bring the agents\nyou already use'],
  'msgr.join.lede': [
    'Argo 크루는 자동으로, Hermes·OpenClaw는 골라서, 서버에서 도는 에이전트는 명령 한 줄로 한 번에 채널에 들어옵니다. 서버 비밀번호는 넣지 않습니다.',
    'Argo crews join automatically, Hermes and OpenClaw with a pick, and agents on your server all at once with one command. You never enter a server password.',
  ],
  'msgr.join.crew.t': ['Argo 크루는 자동으로', 'Argo crews, automatically'],
  'msgr.join.crew.b': ['같은 계정으로 로그인한 Argo 앱을 켜 두면, 등록 없이 크루 목록에 나타납니다.', 'Keep the Argo app running, signed in with the same account. Your crews appear with no setup.'],
  'msgr.join.hermes.t': ['이 컴퓨터의 Hermes, 골라서 바로', 'Hermes on this computer, picked and connected'],
  'msgr.join.hermes.b': ['이 컴퓨터의 Hermes 프로필을 찾아 보여 줍니다. 고르고 연결하면 채널에 들어옵니다. OpenClaw도 연결할 수 있습니다.', 'It finds the Hermes profiles on this computer. Pick, connect, and they join the channel. OpenClaw connects too.'],
  'msgr.join.vps.t': ['VPS의 에이전트, 명령 한 줄로 한 번에', 'Agents on a VPS, all at once with one command'],
  'msgr.join.vps.b': ['서버의 브라우저 터미널에 명령 한 줄을 붙여 넣으면, 서버에서 도는 Hermes·OpenClaw 에이전트를 찾아 한 번에 연결합니다.', "Paste one command into your server's browser terminal. It finds every Hermes and OpenClaw agent running there and connects them at once."],
  'msgr.join.members': ['채널 멤버', 'Channel members'],
  'msgr.join.joined': ['합류', 'Joined'],
  'msgr.join.n.juno': ['주노', 'Juno'],
  'msgr.join.n.atlas': ['아틀라스', 'Atlas'],
  'msgr.join.n.sage': ['세이지', 'Sage'],
  'msgr.join.n.hermes1': ['헤르메스 · 리서치', 'Hermes · research'],
  'msgr.join.n.hermes2': ['헤르메스 · 운영', 'Hermes · ops'],
  'msgr.join.n.claw': ['오픈클로 · 코딩', 'OpenClaw · code'],
  'msgr.join.crew.app': ['Argo 앱 · 내 크루', 'Argo app · my crew'],
  'msgr.join.crew.note': ['같은 계정으로 로그인', 'Signed in with the same account'],
  'msgr.join.hermes.btn': ['이 컴퓨터의 헤르메스 불러오기', 'Import Hermes from this computer'],
  'msgr.join.hermes.connect': ['선택한 3명 연결', 'Connect 3 selected'],
  'msgr.join.vps.term': ['서버 브라우저 터미널', 'Server browser terminal'],
  'msgr.join.vps.cmd': ['(복사한 연결 명령 한 줄)', '(the one-line connect command you copied)'],
  'msgr.join.vps.found': ['에이전트 3개를 찾았습니다', 'Found 3 agents'],
  'msgr.join.vps.found.cap': ['서버가 찾은 에이전트', 'Agents found on the server'],
  'msgr.join.vps.connect': ['연결', 'Connect'],

  // 메신저 — 데려오기·사용법 탭 클립(TabFilm)에 찍힌 글. 위 msgr.join.*의 무대 문구와 함께 블렌더 텍스처 페이지(보관본 tabs/)가 쓴다 — 클립을 다시 렌더할 때 필요
  'msgr.sc.talk.q': ['*@주노* 경쟁사 가격표 요약해 줘', '*@Juno* summarize competitor pricing'],
  'msgr.sc.talk.r1': ['A사 · 기본', 'Vendor A · Basic'],
  'msgr.sc.talk.v1': ['월 $9', '$9/mo'],
  'msgr.sc.talk.r2': ['B사 · 팀', 'Vendor B · Team'],
  'msgr.sc.talk.v2': ['월 $15', '$15/mo'],
  'msgr.sc.talk.r3': ['C사 · 무료', 'Vendor C · Free'],
  'msgr.sc.talk.v3': ['3명까지', 'Up to 3'],
  'msgr.sc.handoff.q': ['*@아틀라스 > @세이지 > @주노* 계약서 검토하고 회신 초안까지', '*@Atlas > @Sage > @Juno* review the contract, then draft a reply'],
  'msgr.sc.handoff.j1': ['요약', 'Summary'],
  'msgr.sc.handoff.j2': ['법무 검토', 'Legal review'],
  'msgr.sc.handoff.j3': ['회신 초안', 'Reply draft'],
  'msgr.sc.handoff.done': ['세 단계 결과를 한 스레드에 합쳐 올렸습니다.', 'All three steps posted in one thread.'],
  'msgr.sc.approve.why': ['Northwind에 계약서 회신을 보내려고 합니다.', 'I want to send the contract reply to Northwind.'],
  'msgr.sc.approve.need': ['그러기 위해 메일 발송 승인이 필요합니다.', 'To do that, I need approval to send the email.'],
  'msgr.sc.approve.cmd': ['명령 보기', 'View command'],
  'msgr.sc.approve.log': ['실행 기록', 'Run log'],
  'msgr.sc.approve.logline': ['서연 님이 14:02에 승인 · 메일 1건 발송', 'Approved by Maya at 14:02 · 1 email sent'],
  'msgr.sc.memory.day': ['다음 날 · #launch', 'Next day · #launch'],
  'msgr.sc.memory.q': ['출시일이 언제였죠? 담당은요?', 'When is the launch again? Who owns it?'],
  'msgr.sc.memory.ctx': ['채널 기억', 'Channel memory'],
  'msgr.sc.memory.a': ['*10월 14일*, 담당은 서연입니다.', '*Oct 14*. Maya owns the rollout.'],

  // 메신저 히어로 대화 장면(ThreadFilm) — 가상의 두 회사. *별표* = 형광 옐로 강조
  'film.aria': ['두 회사 사람과 각자의 에이전트가 한 채널에서 일하는 장면', 'People from two companies and their agents working in one channel'],
  'film.meta': ['Acme × Northwind · 사람 2 · 에이전트 2', 'Acme × Northwind · 2 people · 2 agents'],
  'film.maya': ['서연', 'Maya'],
  'film.maya.role': ['Acme', 'Acme'],
  'film.dan': ['도윤', 'Dan'],
  'film.dan.role': ['Northwind', 'Northwind'],
  'film.juno': ['주노', 'Juno'],
  'film.juno.role': ['서연의 에이전트', "Maya's agent"],
  'film.atlas': ['아틀라스', 'Atlas'],
  'film.atlas.role': ['도윤의 에이전트', "Dan's agent"],
  'film.m1': ['금요일까지 출시 계획 확정할 수 있을까요?', 'Can we lock the launch plan by Friday?'],
  'film.m2': ['초안 올렸어요. Northwind 쪽에 *질문 3개*가 남았습니다.', 'Drafted. *3 questions* left for Northwind.'],
  'film.m3': ['제 에이전트 부를게요.', 'On it. Looping in my agent.'],
  'film.m4': ['2개는 *채널 기억*에서 답했습니다. 1개는 법무 확인이 필요해요.', 'Answered 2 from *channel memory*. One needs legal.'],
  'film.m5': ['*@주노* 이 대화로 출시 일정 만들어 줘', '*@Juno* build the launch timeline from this thread'],
  'film.slip.title': ['출시 일정', 'Launch timeline'],
  'film.slip.meta': ['4단계 · #launch', '4 steps · #launch'],
  'film.slip.d1': ['10/7', 'Oct 7'],
  'film.slip.r1': ['가격 페이지 공개', 'Pricing page live'],
  'film.slip.d2': ['10/9', 'Oct 9'],
  'film.slip.r2': ['API 동결', 'API freeze'],
  'film.slip.d3': ['10/12', 'Oct 12'],
  'film.slip.r3': ['베타 초대 · 240명', 'Beta invites · 240'],
  'film.slip.d4': ['10/14', 'Oct 14'],
  'film.slip.r4': ['출시', 'Launch'],
  'film.slip.tag': ['결재', 'Approval'],
  'film.slip.ask': ['베타 초대장 240명에게 보내기', 'Send beta invites to 240 people'],
  'film.slip.btn': ['승인', 'Approve'],
  'film.slip.done': ['승인됨', 'Approved'],
  'film.composer': ['메시지 — @로 사람이나 에이전트 부르기', 'Message — @ to call a person or agent'],

  // 오피스(/office) — 출시 전(대기자 신청). 기능 문구는 오피스 인계 문서의 1차 범위만 쓴다.
  'office.kicker': ['출시 준비 중', 'Coming soon'],
  'office.title': ['업무 데이터, AI 에이전트,\n우리 팀이 *한 곳에*\n모이는 그룹웨어', 'Your work data,\nyour AI agents and your team,\n*in one place.*'],
  'office.lede': [
    '메일·문서·메신저 기록이 한 화면에 모이고, 크루가 초안과 번역을 맡고, 메신저의 조직이 그대로 오피스의 팀이 됩니다. 직무에 맞게 필요한 모듈만 켜서 씁니다.',
    'Mail, docs and messenger records land on one screen, crews take the drafts and translations, and your messenger org becomes your office team. Turn on only the modules your role needs.',
  ],
  'office.demo.label': ['Argo Office 데모 영상', 'Argo Office demo'],
  'office.trust': ['출시 준비 중 · 웹 · 대기자에게 먼저 안내', 'Coming soon · Web · Waitlist gets it first'],

  // 오피스 — 세 기둥(업무 데이터 · AI 에이전트 · 우리 팀)
  'office.pillar.kicker': ['한 곳에 모이는 것', 'What comes together'],
  'office.pillar.title': ['흩어져 있던 세 가지가\n한 화면에서 같이 움직입니다', 'Three things that were scattered\nnow move together on one screen'],
  'office.pillar.data.t': ['업무 데이터', 'Work data'],
  'office.pillar.data.b': ['Gmail 메일, 블록으로 쓰는 페이지, 메신저의 결재와 기록을 한 화면의 모듈로 봅니다.', 'Gmail, block-based pages, and approvals and records from Messenger, as modules on one screen.'],
  'office.pillar.ai.t': ['AI 에이전트', 'AI agents'],
  'office.pillar.ai.b': ['메일 회신 초안과 번역을 크루에게 맡기고, 보내기는 사람이 확인한 뒤에 합니다.', 'Hand reply drafts and translations to your crew. A person checks before anything is sent.'],
  'office.pillar.team.t': ['우리 팀', 'Your team'],
  'office.pillar.team.b': ['메신저의 조직이 그대로 오피스의 팀이 됩니다. 새로 초대할 필요가 없습니다.', 'Your messenger org is your office team. No one needs a new invite.'],
  'office.cta.look': ['살펴보기', 'Take a look'],
  // 오피스 — 문제·해결 스크롤(ProblemScroll ns='office')
  'office.prob.kicker': ['왜 필요한가', 'Why it matters'],
  'office.prob.before': ['지금은\n창을 오가며 일합니다', 'Today, work\nhops between windows'],
  'office.prob.after': ['이제\n한 화면에서', 'Now,\non one screen'],
  'office.prob.pain1': ['메일·문서·메신저·번역기를 오가며 같은 내용을 여러 번 옮깁니다.', 'You move the same content between mail, docs, chat, and a translator.'],
  'office.prob.fix1': ['메일·페이지·메신저 기록이 한 화면에 모입니다.', 'Mail, pages, and messenger records sit on one screen.'],
  'office.prob.pain2': ['AI에게 맡긴 일이 어디서 어떻게 됐는지 한눈에 보이지 않습니다.', "You can't see where the work you gave to AI ended up."],
  'office.prob.fix2': ['크루에게 맡긴 일과 초안이 한 모듈에 쌓입니다.', 'Work handed to your crew and its drafts collect in one module.'],
  'office.prob.pain3': ['직무와 상관없이 모두 같은 도구 화면을 씁니다.', 'Everyone gets the same screen, whatever their role.'],
  'office.prob.fix3': ['직무에 맞는 모듈만 켜서 씁니다.', 'Turn on only the modules your role needs.'],
  'office.prob.w.a': ['메일 · 받은편지함', 'Mail · Inbox'],
  'office.prob.w.a.1': ['Northwind — 계약서 최종본', 'Northwind — Final contract'],
  'office.prob.w.a.2': ['회신은 문서 보고 써야 함', 'Reply needs the doc open'],
  'office.prob.w.b': ['문서 · 계약 검토', 'Docs · Contract review'],
  'office.prob.w.b.1': ['3조 지급 조건 수정 요청', 'Clause 3 payment terms change'],
  'office.prob.w.b.2': ['(메일에서 복사해 옴)', '(copied from mail)'],
  'office.prob.w.c': ['메신저 · #sales', 'Chat · #sales'],
  'office.prob.w.c.1': ['회신 초안 누가 써요?', 'Who is drafting the reply?'],
  'office.prob.w.c.2': ['영문 번역도 필요해요', 'We need it in English too'],
  'office.prob.w.d': ['번역기', 'Translator'],
  'office.prob.w.d.1': ['초안 붙여 넣기', 'Paste the draft'],
  'office.prob.w.d.2': ['영문 결과 (다시 복사)', 'English result (copy again)'],
  'office.prob.c1': ['복사', 'Copy'],
  'office.prob.c2': ['붙여넣기', 'Paste'],
  'office.prob.c3': ['창 전환', 'Switch window'],
  'office.prob.today': ['오늘', 'Today'],

  // 오피스 — 직무에 맞게(RoleBoard). 조합은 예시이고, 앱에서는 모듈을 켜고 끈다.
  'office.role.kicker': ['직무에 맞게', 'Set up by role'],
  'office.role.title': ['직무에 맞게,\n필요한 것만.', 'Set up by role,\nonly what you need.'],
  'office.role.lede': [
    '메일은 Gmail·Google Workspace 계정으로 연결하고, 페이지는 블록으로 쓰고 공유합니다. 모듈을 켜고 끄며 직무에 맞게 화면을 꾸립니다. 아래 조합은 예시입니다.',
    'Connect Gmail or Google Workspace mail, write and share pages in blocks, and turn modules on or off to fit the role. The sets below are examples.',
  ],
  'office.role.sales': ['영업', 'Sales'],
  'office.role.sales.b': ['메일 회신과 번역, 크루 초안을 한 화면에서', 'Mail replies, translation, and crew drafts in one place'],
  'office.role.marketing': ['마케팅', 'Marketing'],
  'office.role.marketing.b': ['기획 페이지와 채널 기록, 크루 초안을 한 화면에서', 'Plan pages, channel records, and crew drafts in one place'],
  'office.role.ops': ['운영', 'Operations'],
  'office.role.ops.b': ['메신저 결재와 운영 문서를 먼저', 'Messenger approvals and ops docs first'],
  'office.role.ceo': ['대표', 'CEO'],
  'office.role.ceo.b': ['결재를 기다리는 일부터', 'What is waiting for your approval, first'],

  // 오피스 — 메신저 연동 AX(CrewDraft). 크루는 초안까지, 보내기는 사람이 한다.
  'office.ax.kicker': ['메신저 연동', 'With Messenger'],
  'office.ax.title': ['메신저와 이어져\n*완전한 AX*로.', 'Linked with Messenger,\n*AX end to end.*'],
  'office.ax.lede': [
    '메신저 조직이 그대로 오피스 조직이 됩니다. 메신저에서 오간 결재와 기록이 오피스에 모이고, 오피스에서 맡긴 일은 크루가 초안까지 씁니다.',
    'Your messenger org is your office org. Approvals and records from Messenger land in the Office, and work you hand off gets drafted by your crew.',
  ],
  'office.ax.p1': ['메신저의 결재·기록이 오피스 한 곳에 모입니다', 'Messenger approvals and records collect in one place'],
  'office.ax.p2': ['크루가 메일 회신·번역 초안을 씁니다', 'Your crew drafts mail replies and translations'],
  'office.ax.p3': ['밖으로 나가는 일은 사람이 확인하고 보냅니다', 'People review and send anything that goes out'],
  'office.ax.mail.from': ['Northwind · 계약 담당', 'Northwind · Contracts'],
  'office.ax.mail.subj': ['계약서 최종본 검토 요청', 'Review request: final contract'],
  'office.ax.mail.body': ['3조 지급 조건을 30일에서 45일로 바꾸고 싶습니다. 이번 주 안에 회신 부탁드립니다.', 'We would like to move Clause 3 payment terms from 30 to 45 days. Please reply this week.'],
  'office.ax.btn': ['크루에게 맡기기', 'Hand to crew'],
  'office.ax.again': ['다시 보기', 'Replay'],
  'office.ax.idle': ['주노가 기다리고 있습니다', 'Juno is ready'],
  'office.ax.working': ['주노가 회신 초안을 쓰는 중', 'Juno is drafting a reply'],
  'office.ax.done': ['초안 완료 · 보내기 전에 확인하세요', 'Draft ready · review before sending'],
  'office.ax.draft': ['회신 초안', 'Reply draft'],
  'office.ax.d1': ['안녕하세요, Acme 서연입니다.', 'Hi, this is Maya from Acme.'],
  'office.ax.d2': ['3조 지급 조건 변경은 내부 검토 후 회신드리겠습니다.', "We'll reply on the Clause 3 change after an internal review."],
  'office.ax.d3': ['검토 결과는 금요일까지 보내 드리겠습니다.', "You'll have our answer by Friday."],
  'office.ax.send': ['검토 후 보내기', 'Review and send'],
  'office.mod.all': ['모두 보기', 'View all'],
  'office.mod.mail': ['메일', 'Mail'],
  'office.mod.mail.n': ['12', '12'],
  'office.mod.mail.unit': ['안 읽음', 'unread'],
  'office.mod.mail.r1': ['Northwind — 계약서 최종본', 'Northwind — Final contract'],
  'office.mod.mail.m1': ['오전 9:12', '9:12 AM'],
  'office.mod.mail.r2': ['Acme 재무 — 10월 청구서', 'Acme Finance — October invoice'],
  'office.mod.mail.m2': ['어제', 'Yesterday'],
  'office.mod.mail.r3': ['뉴스레터 — 주간 요약', 'Newsletter — Weekly digest'],
  'office.mod.mail.m3': ['월', 'Mon'],
  'office.mod.pages': ['페이지', 'Pages'],
  'office.mod.pages.n': ['48', '48'],
  'office.mod.pages.unit': ['페이지', 'pages'],
  'office.mod.pages.r1': ['출시 계획 · 10월', 'Launch plan · October'],
  'office.mod.pages.m1': ['공유됨', 'Shared'],
  'office.mod.pages.r2': ['회의록 · 주간 싱크', 'Notes · Weekly sync'],
  'office.mod.pages.m2': ['비공개', 'Private'],
  'office.mod.pages.r3': ['제안서', 'Proposal'],
  'office.mod.pages.m3': ['템플릿', 'Template'],
  'office.mod.msgr': ['메신저 기록', 'From Messenger'],
  'office.mod.msgr.n': ['2', '2'],
  'office.mod.msgr.unit': ['결재 대기', 'approvals waiting'],
  'office.mod.msgr.r1': ['#launch — 베타 초대 240명', '#launch — Beta invites · 240'],
  'office.mod.msgr.m1': ['결재', 'Approval'],
  'office.mod.msgr.r2': ['#design — 브랜드 키트 v3', '#design — Brand kit v3'],
  'office.mod.msgr.m2': ['요약', 'Summary'],
  'office.mod.crew': ['크루에게 맡긴 일', 'Handed to crew'],
  'office.mod.crew.n': ['3', '3'],
  'office.mod.crew.unit': ['초안', 'drafts'],
  'office.mod.crew.r1': ['Northwind 회신 초안', 'Reply draft to Northwind'],
  'office.mod.crew.m1': ['주노', 'Juno'],
  'office.mod.crew.r2': ['주간 보고 영문 번역', 'Weekly report · English'],
  'office.mod.crew.m2': ['아틀라스', 'Atlas'],
  'office.mod.translate': ['번역', 'Translate'],
  'office.mod.translate.n': ['2', '2'],
  'office.mod.translate.unit': ['진행 중', 'in progress'],
  'office.mod.translate.r1': ['Acme 제안서 영문 번역', 'Acme proposal in English'],
  'office.mod.translate.m1': ['아틀라스', 'Atlas'],
  'office.mod.translate.r2': ['계약 요약 일본어 번역', 'Contract summary in Japanese'],
  'office.mod.translate.m2': ['완료', 'Done'],
  'office.mod.approve': ['결재 대기', 'Awaiting approval'],
  'office.mod.approve.n': ['2', '2'],
  'office.mod.approve.unit': ['건', 'items'],
  'office.mod.approve.r1': ['베타 초대 240명 발송', 'Send beta invites · 240'],
  'office.mod.approve.m1': ['#launch', '#launch'],
  'office.mod.approve.r2': ['Northwind 회신 발송', 'Send reply to Northwind'],
  'office.mod.approve.m2': ['#sales', '#sales'],
  'office.trait.save.t': ['저장 버튼이 없습니다', 'No save button'],
  'office.trait.save.b': ['쓰는 대로 기기에 먼저 저장되고 이어서 동기화됩니다.', 'Everything saves on your device as you type, then syncs.'],
  'office.trait.history.t': ['90일 버전 · 30일 휴지통', '90-day versions · 30-day trash'],
  'office.trait.history.b': ['지난 버전으로 되돌리고, 지운 것은 30일 안에 되살립니다.', 'Roll back any version and restore anything deleted within 30 days.'],
  'office.trait.command.t': ['⌘K로 어디든', '⌘K to anywhere'],
  'office.trait.command.b': ['페이지·메일·명령을 한 창에서 찾고 실행합니다.', 'Find and run pages, mail, and commands from one bar.'],
  'office.wait.kicker': ['대기자 신청', 'Waitlist'],
  'office.wait.title': ['오피스를 *먼저* 써 보세요.', 'Be *first* in the office.'],
  'office.wait.sub': ['출시되면 이 주소로 가장 먼저 알려 드립니다.', 'We will email you first when it opens.'],
  'office.wait.note': ['신청 버튼을 누르면 메일 앱이 열립니다.', 'Submitting opens your mail app.'],
  'office.wait.subject': ['[Argo Office] 대기자 신청', '[Argo Office] Waitlist'],
  'office.wait.bodyline': ['대기자로 신청합니다.', 'Please add me to the waitlist.'],

  // legal (약관·개인정보)
  'legal.kicker': ['정책', 'Legal'],
  'legal.updated': ['시행일 2026-07-15 · 개정 2026-09-26', 'Effective 2026-07-15 · Revised 2026-09-26'],
  'legal.terms': ['이용약관', 'Terms of Service'],
  'legal.privacy': ['개인정보처리방침', 'Privacy Policy'],
  'terms.title': ['이용약관', 'Terms of Service'],
  'privacy.title': ['개인정보처리방침', 'Privacy Policy'],
};

const LangContext = createContext(null);

export function LanguageProvider({ children }) {
  // 기본 영문, 한국어는 토글 (2026-07-13 유건 지시)
  const [lang, setLang] = useState('en');

  // 방문자가 직접 누른 선택만 기억한다. 브라우저 언어로 자동 전환하지 않는다(2026-09-30 유건: 기본 영어로 보이게).
  // 키 이름을 바꿔, 예전 자동 선택이 저장해 둔 'ko'는 무시된다.
  const KEY = 'argo-landing-lang-choice';
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'en' || saved === 'ko') setLang(saved);
    } catch {}
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const choose = (next) => {
    setLang(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {}
  };

  // cmd+/ (mac) · ctrl+/ (win) — 언어 전환
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        choose(document.documentElement.lang === 'ko' ? 'en' : 'ko');
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

  const toggle = () => choose(lang === 'ko' ? 'en' : 'ko');

  return <LangContext.Provider value={{ lang, t, toggle }}>{children}</LangContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LanguageProvider');
  return ctx;
}
