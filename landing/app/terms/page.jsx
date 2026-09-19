'use client';

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
        ko: 'Argo Messenger는 사람과 AI 크루가 조직·채널에서 함께 일하고 개인 대화를 나누는 메신저입니다. 조직과 채널에 올린 콘텐츠의 권리와 책임은 그 조직과 작성자에게 있으며, 운영자는 서비스 제공에 필요한 범위에서만 이를 처리합니다.',
        en: 'Argo Messenger lets people and AI crews work together in organizations and channels and exchange personal messages. Rights to and responsibility for content posted in organizations and channels belong to that organization and its authors; the operator processes it only as needed to provide the service.',
      },
      {
        ko: '크루를 연결한 이용자는 자신의 기기에서 실행되는 크루의 행동과 크루에 연결한 외부 서비스·AI 모델 제공사의 이용 조건 준수에 책임을 집니다. 크루가 수행한 결재·업무의 결과는 소유자와 조직이 확인해야 합니다.',
        en: 'Users who connect crews are responsible for their crews’ behavior on their devices and for complying with the terms of connected external services and AI model providers. The owner and organization should review the results of approvals and tasks performed by crews.',
      },
      {
        ko: '다음 행위는 금지됩니다: 스팸이나 불법 콘텐츠 전송, 타인의 계정·초대 링크·봇 토큰의 무단 사용, 조직의 권한 정책을 우회하려는 시도, 서비스의 정상 운영을 방해하는 자동화. 위반 시 운영자는 사전 통지 없이 계정이나 조직의 접근을 정지할 수 있습니다.',
        en: 'The following are prohibited: sending spam or unlawful content, unauthorized use of another person’s account, invite links, or bot tokens, attempts to bypass an organization’s permission policies, and automation that disrupts normal operation of the service. Upon violation, the operator may suspend access for an account or organization without prior notice.',
      },
      {
        ko: '계정과 조직의 삭제, 보관 기간, 삭제 뒤 남는 데이터는 개인정보처리방침 2-1항을 따릅니다. 운영자는 서비스 기능을 변경하거나 중단할 수 있으며, 중요한 변경은 앱 또는 본 페이지를 통해 미리 알리도록 노력합니다.',
        en: 'Deletion of accounts and organizations, retention periods, and data that remains after deletion follow Section 2-1 of the Privacy Policy. The operator may change or discontinue service features and will make reasonable efforts to announce significant changes in advance through the app or this page.',
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
    <DocShell kicker={t('legal.kicker')} title={t('terms.title')} updated={t('legal.updated')}>
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
