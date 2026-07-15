'use client';

import DocShell from '@/components/DocShell';
import { useLang } from '@/lib/i18n';

// 시스템 프롬프트 — "틀(구조)"만 공개. 내부 크루 코드네임·회사 맥락·실제 키·경로는 제외,
// 예시는 가짜 플레이스홀더(Crew A / Researcher)로.
const PROMPT_TEMPLATE = `---
runner: <engine>        # claude · codex · gemini · glm
model:  <model id>
name:   Crew A          # display name (placeholder)
role:   Researcher      # title (placeholder)
team:   <team>
---

## 1. Identity  (신원)
One line: the role, what it's good at, and its scope.

## 2. Accuracy rules  (정확성)
- Say "I don't know" when unsure; assert only from evidence.
- Re-check the result against the goal before finishing.

## 3. Working rules  (운영 규율)
- Request -> goal & success criteria -> break into steps -> execute.
- State assumptions and risks, and offer alternatives.

## 4. Using memory  (기억 사용법)
- Save reusable decisions and preferences as vault notes.
- Search and read only the memory the task needs.

## 5. Company context  (auto-injected)
Your recorded preferences, decisions, and no-gos are injected here.`;

// 그룹 → 섹션. body: 문단[{ko,en}]. insight/verified/caveat: 콜아웃. code: 코드블록.
const GROUPS = [
  {
    g: { ko: 'A. 시작하기', en: 'A. Getting started' },
    sections: [
      {
        id: 'what',
        h: { ko: '1. Argo란?', en: '1. What is Argo?' },
        body: [
          {
            ko: 'Argo는 프롬프트 한 줄로 “AI 직원 회사”를 만드는 데스크톱 앱입니다. 역할을 말하면 전문 에이전트(크루)가 채용되고, 폴더 단위 기억을 쌓으며 스스로 협업해 일을 끝냅니다.',
            en: 'Argo is a desktop app that builds a “company of AI employees” from a single prompt. Describe a role and a specialist agent (crew) is hired; they accumulate folder-scale memory and collaborate to finish the work.',
          },
        ],
        insight: {
          ko: '설계 의도 — SaaS가 아니라 로컬 앱으로 둔 이유는, 기억과 규칙이 내 기기에 남아 클라우드에 종속되지 않게 하기 위함입니다.',
          en: 'Design intent — It is a local app, not a hosted SaaS, so memory and rules stay on your machine with no cloud lock-in.',
        },
      },
      {
        id: 'quickstart',
        h: { ko: '2. 5분 시작', en: '2. Five-minute start' },
        body: [
          {
            ko: '① 앱 설치 → ② 회사 생성 → ③ 첫 크루 채용(“시니어 리서처 — 시장조사, 요약”처럼 한 줄) → ④ 첫 대화. 이 네 단계면 바로 일을 시킬 수 있습니다.',
            en: '(1) Install the app -> (2) create a company -> (3) hire your first crew (one line, e.g. “A senior researcher — market research, summaries”) -> (4) start chatting. Four steps and you are working.',
          },
        ],
      },
      {
        id: 'concepts',
        h: { ko: '3. 핵심 개념', en: '3. Core concepts' },
        body: [
          {
            ko: '회사 = 작업 공간. 크루 = AI 직원(각자 역할·카드). 기억(vault) = 폴더 트리로 쌓이는 노트·일지·인덱스. 위임 = 모더레이터가 담당 크루에 일을 넘김. 결재 = 위험·중요 행동은 사용자 승인 후 실행.',
            en: 'Company = your workspace. Crew = an AI employee (each with a role and card). Memory (vault) = a folder tree of notes, journals, and an index. Delegation = a moderator hands work to the right crew. Approval = risky or important actions run only after you sign off.',
          },
        ],
      },
    ],
  },
  {
    g: { ko: 'B. 크루 다루기', en: 'B. Working with crew' },
    sections: [
      {
        id: 'hire',
        h: { ko: '4. 크루 채용 · 역할 · 카드', en: '4. Hire, role, and card' },
        body: [
          {
            ko: '필요한 전문가를 한 문장으로 설명하면 Argo가 페르소나 카드를 작성해 크루로 합류시킵니다. 카드에서 이름·직함·팀·규칙을 언제든 수정할 수 있습니다.',
            en: 'Describe the expert you need in one sentence; Argo writes a persona card and the crew joins. You can edit the name, title, team, and rules from the card at any time.',
          },
        ],
      },
      {
        id: 'memory',
        h: { ko: '5. 기억 시키기', en: '5. Teaching it to remember' },
        body: [
          {
            ko: '대화 중 재사용 가치가 있는 결정·취향은 vault에 노트로 쌓입니다. 키워드로 검색하면 관련 기억만 로드되어 토큰을 아낍니다 — 매번 전부 읽지 않습니다.',
            en: 'Reusable decisions and preferences accumulate as vault notes as you talk. Searching a keyword loads only the relevant memory, saving tokens — it does not re-read everything each time.',
          },
        ],
        insight: {
          ko: '설계 의도 — 기억을 한 파일이 아니라 폴더 트리로 둔 이유는, 회사가 커질수록 노트가 서로 링크되며 지식이 복리로 쌓이게 하기 위함입니다.',
          en: 'Design intent — Memory is a folder tree, not one file, so that as the company grows, notes link to each other and knowledge compounds.',
        },
      },
      {
        id: 'delegate',
        h: { ko: '6. 위임과 협업', en: '6. Delegation & collaboration' },
        body: [
          {
            ko: '모더레이터가 작업을 담당 크루에 위임하고, 다른 크루가 검토합니다. 한 명이 하고 → 다른 명이 검토 → 당신은 승인만 하면 됩니다.',
            en: 'A moderator delegates work to the right crew, and another reviews it. One does the work, another reviews, and you just approve.',
          },
        ],
      },
    ],
  },
  {
    g: { ko: 'C. 시스템 프롬프트 & 스타일', en: 'C. System prompt & style' },
    sections: [
      {
        id: 'prompt-structure',
        h: { ko: '7. 크루는 어떤 지침으로 움직이나', en: '7. How crews are instructed' },
        body: [
          {
            ko: '각 크루는 하나의 시스템 프롬프트 카드로 정의됩니다. 여기서는 실제 내부 문구가 아니라 “틀(구조)”만 공개합니다 — ① 신원 ② 정확성 규칙 ③ 운영 규율 ④ 기억 사용법 ⑤ 회사 맥락(자동 주입). 내부 크루 코드네임·회사 맥락·키·경로는 담지 않습니다.',
            en: 'Each crew is defined by one system-prompt card. Here we publish only the structure, not the actual internal text — (1) identity (2) accuracy rules (3) working rules (4) memory usage (5) company context (auto-injected). Internal crew codenames, company context, keys, and paths are omitted.',
          },
        ],
        code: PROMPT_TEMPLATE,
        caveat: {
          ko: '주의 — 위 예시의 이름(Crew A)·직함(Researcher)은 가짜 플레이스홀더입니다. 실제 배합(내부 페르소나·회사 규칙)은 공개하지 않습니다. 요리책에 “육수 → 면 → 고명” 순서는 적되 비밀 레시피는 빼는 것과 같습니다.',
          en: 'Caveat — The name (Crew A) and title (Researcher) above are placeholders. The real recipe (internal personas, company rules) is not published — like a cookbook that lists “stock -> noodles -> garnish” but withholds the secret blend.',
        },
      },
      {
        id: 'customize',
        h: { ko: '8. 내 회사 색 입히기', en: '8. Make it your own' },
        body: [
          {
            ko: '크루의 지침은 세 가지 방식으로 바꿉니다. ① 프리셋 — 준비된 역할 틀 선택. ② 커스텀 — 카드를 직접 편집. ③ 덧붙이기(append) — 회사 공통 규칙을 모든 크루에 얹기(예: “결과는 항상 결론부터”).',
            en: 'You shape a crew’s instructions three ways. (1) Preset — pick a ready-made role template. (2) Custom — edit the card directly. (3) Append — layer company-wide rules onto every crew (e.g. “always lead with the conclusion”).',
          },
        ],
        insight: {
          ko: '설계 의도 — 회사 규칙을 크루마다 복붙하지 않고 “덧붙이기”로 한 곳에서 관리하게 한 이유는, 규칙이 바뀌어도 전 직원에게 일관되게 반영되게 하기 위함입니다.',
          en: 'Design intent — Company rules are managed once via “append” rather than copied into each crew, so a rule change propagates consistently to every employee.',
        },
      },
    ],
  },
  {
    g: { ko: 'D. 엔진(러너) & 설정', en: 'D. Engine (runner) & settings' },
    sections: [
      {
        id: 'runners',
        h: { ko: '9. 러너 선택', en: '9. Choose a runner' },
        body: [
          {
            ko: 'Argo는 여러 엔진(러너) 위에서 돕니다 — Claude · Codex · Gemini · GLM. 내 API 키나 구독을 연결(BYOK)해 사용합니다. 엔진이 무엇이든 위임·기억·결재 같은 “Argo 스타일” 동작은 동일하게 유지됩니다.',
            en: 'Argo runs on multiple engines (runners) — Claude, Codex, Gemini, GLM. Connect your own API key or subscription (BYOK). Whatever the engine, the “Argo style” — delegation, memory, approvals — stays the same.',
          },
        ],
        caveat: {
          ko: '주의 — 엔진에 따라 벤더 특유의 말투나 제약이 일부 남을 수 있습니다(예: 일부 러너는 응답 톤이 다르게 느껴질 수 있음).',
          en: 'Caveat — Some vendor-specific tone or limits can remain depending on the engine (e.g. some runners may read with a slightly different voice).',
        },
      },
      {
        id: 'settings',
        h: { ko: '10. 설정 · 환경변수 · 요금 한도', en: '10. Settings, env, budget' },
        body: [
          {
            ko: '워크스페이스 경로, 러너 키, 통합은 설정에서 관리합니다. 월 예산(요금 한도)을 정해두면 초과 전에 통제할 수 있습니다. 키·비밀은 이름과 위치로만 관리하고 화면·기록에 평문으로 남기지 않습니다.',
            en: 'Workspace path, runner keys, and integrations are managed in settings. Set a monthly budget (spend cap) to stay in control before you go over. Keys and secrets are handled by name and location, never shown or logged in plain text.',
          },
        ],
      },
    ],
  },
  {
    g: { ko: 'E. 안전 & 권한', en: 'E. Safety & permissions' },
    sections: [
      {
        id: 'permissions',
        h: { ko: '11. 권한 · 능력과 승인 게이트', en: '11. Capabilities & approval gates' },
        body: [
          {
            ko: '크루가 쓸 수 있는 능력(파일 접근 · 브라우저 · 셸 실행 등)은 켜고 끌 수 있습니다. 민감한 능력은 실행 전 승인 게이트를 거치게 해, 무엇을 허용/차단할지 당신이 정합니다.',
            en: 'You can turn each capability a crew may use — file access, browser, shell — on or off. Sensitive ones pass an approval gate before running, so you decide what is allowed or blocked.',
          },
        ],
      },
      {
        id: 'risky',
        h: { ko: '12. 위험 행동 처리', en: '12. Handling risky actions' },
        body: [
          {
            ko: '삭제 · 외부 발송 · 비용 발생 같은 되돌리기 어려운 행동은 “결재 후 실행”이 원칙입니다. 크루는 계획을 먼저 제시하고, 당신의 승인 뒤에만 실제로 실행합니다.',
            en: 'Hard-to-undo actions — deleting, sending externally, spending — follow an “approve, then act” rule. The crew proposes a plan first and only executes after you sign off.',
          },
        ],
        verified: {
          ko: '확인됨 — 승인 게이트는 되돌리기 어려운 행동에서 실제로 실행을 막고 사용자 확인을 요구하도록 동작합니다.',
          en: 'Verified — The approval gate does block execution on hard-to-undo actions and require your confirmation.',
        },
      },
      {
        id: 'security',
        h: { ko: '13. 보안', en: '13. Security' },
        body: [
          {
            ko: 'API 키·비밀번호·접속 문자열 같은 비밀은 값이 아니라 이름·위치로만 다룹니다. 외부에서 들어오는 지시(웹 페이지·문서 내용)는 “데이터”로 취급해 프롬프트 주입을 방어합니다.',
            en: 'Secrets — API keys, passwords, connection strings — are handled by name and location, never by value. Instructions arriving from outside (web pages, document contents) are treated as data, defending against prompt injection.',
          },
        ],
      },
    ],
  },
  {
    g: { ko: 'F. 통합', en: 'F. Integrations' },
    sections: [
      {
        id: 'integrations',
        h: { ko: '14. 텔레그램 · 슬랙 · MCP · 동기화', en: '14. Telegram, Slack, MCP, sync' },
        body: [
          {
            ko: '크루를 텔레그램·슬랙 게이트웨이에 연결하면 폰에서도 같은 맥락으로 이어 대화할 수 있습니다. MCP로 외부 도구·서버를 원클릭 연결하고, 로그인하면 웹↔앱 사이 맥락이 동기화됩니다.',
            en: 'Connect a crew to a Telegram or Slack gateway to continue with the same context on your phone. Add external tools and servers via MCP in one click, and sign in to sync context between web and app.',
          },
        ],
      },
    ],
  },
  {
    g: { ko: 'G. 레퍼런스 & 운영', en: 'G. Reference & operations' },
    sections: [
      {
        id: 'reference',
        h: { ko: '15. API · 도구 레퍼런스', en: '15. API & tool reference' },
        body: [
          {
            ko: '크루가 쓰는 도구와 명령의 정확한 명세는 레퍼런스에서 “찾아보는 사전”처럼 확인합니다. (상세 표는 제품 릴리스와 함께 확장됩니다.)',
            en: 'Precise specs for the tools and commands crews use live in the reference — a dictionary you look things up in. (The detailed tables expand alongside product releases.)',
          },
        ],
      },
      {
        id: 'faq',
        h: { ko: '16. 문제해결 & FAQ', en: '16. Troubleshooting & FAQ' },
        body: [
          {
            ko: '자주 막히는 지점과 해결책을 모읍니다 — 러너 키 인식 안 됨, 권한 차단, 기억이 안 쌓이는 것처럼 보일 때 등. 막히면 먼저 여기부터 확인하세요.',
            en: 'Common snags and fixes — a runner key not recognized, a capability blocked, memory that looks like it is not accumulating. Check here first when you get stuck.',
          },
        ],
      },
      {
        id: 'changelog',
        h: { ko: '17. 변경 이력', en: '17. Changelog' },
        body: [
          {
            ko: '버전별 변화와 마이그레이션 안내를 기록합니다. 무엇이 바뀌었고 무엇을 확인했는지 솔직하게 남깁니다.',
            en: 'Version-by-version changes and migration notes. We record what changed and what we verified, honestly.',
          },
        ],
      },
    ],
  },
];

function Callout({ kind, ko, text }) {
  const label =
    kind === 'insight'
      ? ko
        ? '설계 의도'
        : 'DESIGN INTENT'
      : kind === 'verified'
      ? ko
        ? '확인됨'
        : 'VERIFIED'
      : ko
      ? '주의'
      : 'CAVEAT';
  return (
    <aside className={`doc-callout doc-callout-${kind}`}>
      <span className="mono-label doc-callout-label">{label}</span>
      <p>{text}</p>
    </aside>
  );
}

export default function DocsPage() {
  const { lang, t } = useLang();
  const ko = lang === 'ko';
  const pick = (o) => (ko ? o.ko : o.en);

  return (
    <DocShell kicker={t('docs.kicker')} title={t('docs.title')} updated={t('docs.updated')}>
      <p className="doc-lede">{t('docs.lede')}</p>
      <p className="doc-audience">
        {ko
          ? '이 문서는 두 독자를 위한 것입니다 — ① 회사를 만드는 일반 사용자, ② 러너·MCP를 확장하는 파워유저/개발자. 앞쪽은 쉽게, 뒤쪽은 기술적으로.'
          : 'Written for two readers — (1) everyday users building a company, and (2) power users/developers extending runners and MCP. Earlier sections are gentle; later ones are technical.'}
      </p>

      <nav className="doc-toc" aria-label={ko ? '목차' : 'Contents'}>
        <span className="mono-label mono-dim">{ko ? '목차' : 'Contents'}</span>
        {GROUPS.map((grp) => (
          <div className="doc-toc-group" key={grp.g.en}>
            <span className="doc-toc-gtitle">{pick(grp.g)}</span>
            <ul>
              {grp.sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{pick(s.h)}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {GROUPS.map((grp) => (
        <div className="doc-group" key={grp.g.en}>
          <h2 className="doc-group-title">{pick(grp.g)}</h2>
          {grp.sections.map((s) => (
            <section className="doc-section" id={s.id} key={s.id}>
              <h3>{pick(s.h)}</h3>
              {s.body.map((p, i) => (
                <p key={i}>{pick(p)}</p>
              ))}
              {s.code && (
                <pre className="doc-code">
                  <code>{s.code}</code>
                </pre>
              )}
              {s.insight && <Callout kind="insight" ko={ko} text={pick(s.insight)} />}
              {s.verified && <Callout kind="verified" ko={ko} text={pick(s.verified)} />}
              {s.caveat && <Callout kind="caveat" ko={ko} text={pick(s.caveat)} />}
            </section>
          ))}
        </div>
      ))}
    </DocShell>
  );
}
