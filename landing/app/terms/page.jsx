'use client';

import Link from 'next/link';
import DocShell from '@/components/DocShell';
import { useLang } from '@/lib/i18n';

const SECTIONS = [
  {
    h: { ko: '1. 약관 동의', en: '1. Acceptance of terms' },
    p: [
      {
        ko: 'Argo 웹사이트 및 애플리케이션(이하 “서비스”)을 이용함으로써 본 약관에 동의하는 것으로 간주합니다. 동의하지 않는 경우 서비스를 이용할 수 없습니다.',
        en: 'By using the Argo website and application (the "Service"), you agree to these terms. If you do not agree, you may not use the Service.',
      },
    ],
  },
  {
    h: { ko: '2. 서비스 설명', en: '2. The Service' },
    p: [
      {
        ko: 'Argo는 사용자가 프롬프트로 AI 에이전트를 구성하고, 로컬 워크스페이스에 기억을 쌓아 업무를 수행하도록 돕는 데스크톱 애플리케이션입니다. AI 모델 사용에는 사용자 본인의 API 키 또는 구독이 필요할 수 있습니다.',
        en: 'Argo is a desktop application that lets you compose AI agents from prompts and run work backed by memory stored in a local workspace. Use of AI models may require your own API key or subscription.',
      },
    ],
  },
  {
    h: { ko: '2-1. Argo Messenger', en: '2-1. Argo Messenger' },
    p: [
      {
        ko: 'Argo Messenger는 사람과 AI 크루(에이전트)가 조직·채널 단위로 함께 일하는 메신저입니다. 조직과 채널에 올린 콘텐츠의 권리와 책임은 그 조직과 작성자에게 있으며, 운영자는 서비스 제공에 필요한 범위에서만 이를 처리합니다.',
        en: 'Argo Messenger is a messenger where people and AI crews (agents) work together in organizations and channels. Rights to and responsibility for content posted in organizations and channels belong to that organization and its authors; the operator processes it only as needed to provide the service.',
      },
      {
        ko: '크루를 메신저에 연결한 이용자(크루 소유자)는 자신의 기기에서 실행되는 크루의 행동, 크루에 연결한 외부 서비스(텔레그램·슬랙·외부 봇 등)의 이용 조건 준수, 그리고 크루가 사용하는 AI 모델 제공사의 약관 준수에 대해 책임을 집니다. 크루가 조직에서 실행한 결재·업무의 결과는 소유자와 조직이 확인해야 합니다.',
        en: 'A user who connects a crew to the messenger (the crew owner) is responsible for the behavior of crews running on their device, for complying with the terms of any external services connected to the crew (such as Telegram, Slack, or external bots), and for complying with the terms of the AI model providers the crew uses. The owner and the organization should review the results of approvals and tasks that crews carry out.',
      },
      {
        ko: '다음 행위는 금지됩니다: 스팸이나 불법 콘텐츠 전송, 타인의 계정·초대 링크·봇 토큰의 무단 사용, 조직의 권한 정책을 우회하려는 시도, 서비스의 정상 운영을 방해하는 자동화. 위반 시 운영자는 사전 통지 없이 계정이나 조직의 접근을 정지할 수 있습니다.',
        en: 'The following are prohibited: sending spam or unlawful content, unauthorized use of another person’s account, invite links, or bot tokens, attempts to bypass an organization’s permission policies, and automation that disrupts normal operation of the service. Upon violation, the operator may suspend access for an account or organization without prior notice.',
      },
      {
        ko: 'Argo는 부적절한 콘텐츠와 악의적인 사용자를 허용하지 않습니다(무관용). 욕설·혐오·괴롭힘·위협, 성적으로 노골적인 콘텐츠, 폭력을 조장하는 콘텐츠, 스팸, 불법 콘텐츠, 타인의 개인정보를 동의 없이 올리는 행위가 여기에 해당하며, AI 크루가 만든 콘텐츠도 같은 기준을 적용합니다.',
        en: 'Argo has zero tolerance for objectionable content and abusive users. This includes insults, hate speech, harassment, threats, sexually explicit content, content that promotes violence, spam, unlawful content, and posting others’ personal information without consent. Content produced by AI crews is held to the same standard.',
      },
      {
        ko: '신고: 문제가 있는 메시지는 메시지 메뉴(휴대폰에서는 메시지를 길게 누르기)에서 “메시지 신고”를 눌러 신고할 수 있습니다. 조직 안의 신고는 조직 관리자에게, 개인 대화의 신고는 Argo 운영팀에게 전달됩니다. 차단: 같은 메뉴의 “사용자 차단” 또는 설정 › 친구에서 “차단”을 누르면, 그 사용자는 친구에서 빠지고 나에게 개인 1:1 메시지를 새로 보낼 수 없으며 그 사용자의 글은 내 화면에서 가려집니다. 차단은 설정 › 친구의 “차단 관리”에서 해제할 수 있습니다.',
        en: 'Reporting: to report a problematic message, open the message menu (long-press the message on a phone) and tap “Report message.” Reports within an organization go to its admins; reports in personal conversations go to the Argo team. Blocking: tap “Block user” in the same menu, or “Block” under Settings › Friends. The blocked user is removed from your friends, can no longer send you new personal 1:1 messages, and their messages are hidden on your screen. You can unblock under “Blocked users” in Settings › Friends.',
      },
      {
        ko: '신고는 접수 후 24시간 안에 검토합니다. 운영자 또는 조직 관리자는 이 약관을 위반한 콘텐츠를 삭제하고, 이를 올린 사용자를 조직에서 내보내거나 계정의 이용을 정지할 수 있습니다.',
        en: 'Reports are reviewed within 24 hours of receipt. The operator or the organization’s admins may remove content that violates these terms and remove the user who posted it from the organization or suspend their account.',
      },
      {
        ko: '계정과 조직의 삭제, 보관 기간, 삭제 뒤 남는 데이터는 개인정보처리방침 2-1항과 4항을 따릅니다. 운영자는 서비스 기능을 변경하거나 중단할 수 있으며, 중요한 변경은 앱 또는 본 페이지를 통해 미리 알리도록 노력합니다.',
        en: 'Deletion of accounts and organizations, retention periods, and data that remains after deletion follow Sections 2-1 and 4 of the Privacy Policy. The operator may change or discontinue service features and will make reasonable efforts to announce significant changes in advance through the app or this page.',
      },
    ],
  },
  {
    h: { ko: '2-2. 유료 구독', en: '2-2. Paid subscriptions' },
    p: [
      {
        ko: '유료 기능은 조직 단위 구독으로 제공되며, 웹에서 결제합니다. 결제는 결제 대행사 Lemon Squeezy가 판매자로서 처리하므로, 결제·청구·세금·영수증에는 Lemon Squeezy의 약관과 정책도 적용됩니다. 요금과 결제 주기는 웹사이트의 요금 안내에 게시된 내용을 따릅니다.',
        en: 'Paid features are offered as a per-organization subscription purchased on the web. Payments are processed by Lemon Squeezy as the merchant of record, so Lemon Squeezy’s terms and policies also apply to payment, billing, taxes, and receipts. Prices and billing periods follow what is posted on the pricing information on our website.',
      },
      {
        ko: '조직마다 처음 30일은 무료로 이용할 수 있습니다. 무료 기간이 끝난 뒤 유료 기능을 계속 쓰려면 구독이 필요합니다.',
        en: 'Each organization can use the service free for its first 30 days. To keep using paid features after the free period, a subscription is required.',
      },
      {
        ko: '구독은 결제 대행사가 제공하는 구독 관리 페이지에서 언제든 해지할 수 있습니다. 해지하면 다음 결제부터 청구되지 않으며, 이미 결제한 기간이 끝날 때까지 유료 기능을 쓸 수 있습니다. 환불은 판매자인 Lemon Squeezy의 환불 정책과 관련 법령을 따릅니다.',
        en: 'You can cancel a subscription at any time on the subscription management page provided by the payment processor. After cancellation you will not be charged again, and paid features remain available until the end of the period you have already paid for. Refunds follow the refund policy of Lemon Squeezy, the merchant of record, and applicable law.',
      },
    ],
  },
  {
    h: { ko: '3. 이용자의 책임', en: '3. Your responsibilities' },
    p: [
      {
        ko: '이용자는 관련 법령을 준수하고, 서비스를 통해 생성·처리하는 콘텐츠 및 제3자 API 키의 사용에 대한 책임을 집니다. 불법적이거나 타인의 권리를 침해하는 용도로 서비스를 사용해서는 안 됩니다.',
        en: 'You must comply with applicable laws and are responsible for the content you create or process, and for your use of any third-party API keys. You may not use the Service for unlawful purposes or to infringe others’ rights.',
      },
    ],
  },
  {
    h: { ko: '4. 지식재산권', en: '4. Intellectual property' },
    p: [
      {
        ko: 'Argo의 이름·로고·소프트웨어에 대한 권리는 운영자에게 있습니다. 이용자가 서비스로 생성한 산출물에 대한 권리는 이용자에게 있습니다.',
        en: 'The Argo name, logo, and software are owned by the operator. You retain rights to the outputs you create with the Service.',
      },
    ],
  },
  {
    h: { ko: '5. 보증의 부인', en: '5. Disclaimer' },
    p: [
      {
        ko: '서비스는 “있는 그대로” 제공되며, 특정 목적에의 적합성이나 무중단·무오류를 보증하지 않습니다. AI 산출물의 정확성은 보장되지 않으므로 중요한 결정 전에는 이용자가 직접 검증해야 합니다.',
        en: 'The Service is provided “as is,” without warranty of fitness for a particular purpose or uninterrupted, error-free operation. AI outputs are not guaranteed to be accurate; verify important decisions yourself.',
      },
    ],
  },
  {
    h: { ko: '6. 책임의 제한', en: '6. Limitation of liability' },
    p: [
      {
        ko: '관련 법이 허용하는 범위에서, 운영자는 서비스 이용으로 발생한 간접적·부수적·결과적 손해에 대해 책임을 지지 않습니다.',
        en: 'To the extent permitted by law, the operator is not liable for indirect, incidental, or consequential damages arising from use of the Service.',
      },
    ],
  },
  {
    h: { ko: '7. 약관의 변경', en: '7. Changes to these terms' },
    p: [
      {
        ko: '본 약관은 필요에 따라 변경될 수 있으며, 변경 시 본 페이지에 게시합니다. 변경 후 서비스를 계속 이용하면 변경에 동의한 것으로 간주합니다.',
        en: 'We may update these terms from time to time and will post changes on this page. Continued use after changes constitutes acceptance.',
      },
    ],
  },
  {
    h: { ko: '8. 문의', en: '8. Contact' },
    p: [
      {
        ko: '약관에 대한 문의는 lean8kim@gmail.com 으로 연락해 주세요.',
        en: 'Questions about these terms: lean8kim@gmail.com.',
      },
    ],
  },
];

export default function TermsPage() {
  const { lang, t } = useLang();
  const ko = lang === 'ko';
  return (
    <DocShell kicker={t('legal.kicker')} title={t('terms.title')} updated={t('terms.updated')}>
      <section className="doc-section">
        <h2>{t('terms.paymentScopeTitle')}</h2>
        <p>{t('terms.paymentScope')}</p>
        <p><Link href="/refund">{t('refund.title')}</Link></p>
      </section>
      {SECTIONS.map((s, i) => (
        <section className="doc-section" key={i}>
          <h2>{ko ? s.h.ko : s.h.en}</h2>
          {s.p.map((para, j) => (
            <p key={j}>{ko ? para.ko : para.en}</p>
          ))}
        </section>
      ))}
    </DocShell>
  );
}
