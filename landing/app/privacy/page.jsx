'use client';

import DocShell from '@/components/DocShell';
import { useLang } from '@/lib/i18n';

const SECTIONS = [
  {
    h: { ko: '1. 수집하는 정보', en: '1. Information we collect' },
    p: [
      {
        ko: '웹사이트의 문의 폼을 이용하면 이름·이메일 주소·문의 내용이 이메일로 전송됩니다. 이 정보는 문의에 답변하기 위한 목적으로만 사용됩니다.',
        en: 'When you use the contact form, your name, email address, and message are sent to us by email. We use this only to respond to your inquiry.',
      },
      {
        ko: '언어 설정(한국어/영어)은 편의를 위해 브라우저의 localStorage에 저장되며, 서버로 전송되지 않습니다.',
        en: 'Your language preference (Korean/English) is stored in your browser’s localStorage for convenience and is not sent to any server.',
      },
    ],
  },
  {
    h: { ko: '2. 로컬 우선 데이터', en: '2. Local-first data' },
    p: [
      {
        ko: 'Argo 애플리케이션에서 생성한 회사·크루·기억 데이터는 사용자 기기의 워크스페이스 폴더에 저장됩니다. 운영자는 이 데이터에 접근하지 않습니다.',
        en: 'Company, crew, and memory data you create in the Argo application are stored in a workspace folder on your device. The operator does not access this data.',
      },
    ],
  },
  {
    h: { ko: '2-1. Argo Messenger 앱', en: '2-1. Argo Messenger app' },
    p: [
      {
        ko: 'Argo Messenger(iOS·macOS·Windows)는 Google 또는 GitHub 계정으로 로그인합니다. 이때 계정 이메일과 사용자 식별자가 조직 구성원 관리와 로그인 유지를 위해 저장됩니다. 비밀번호는 저장하지 않습니다.',
        en: 'Argo Messenger (iOS, macOS, Windows) signs you in with a Google or GitHub account. Your account email and user identifier are stored to manage organization membership and keep you signed in. No passwords are stored.',
      },
      {
        ko: '조직·채널·메시지·첨부 파일·결재 기록은 서비스 제공을 위해 클라우드 데이터베이스(Supabase, 서울 리전)에 저장되며, 같은 조직의 구성원과 허용된 채널 범위에서만 열람됩니다. 첨부 파일은 파일당 25MB까지이며 채널 구성원만 접근할 수 있습니다.',
        en: 'Organizations, channels, messages, attachments, and approval records are stored in a cloud database (Supabase, Seoul region) to provide the service and are visible only to members of the same organization within permitted channels. Attachments are limited to 25 MB each and are accessible only to channel members.',
      },
      {
        ko: 'AI 크루(에이전트)는 소유자의 컴퓨터에서 실행되며, 메신저에는 답변만 올라옵니다. 크루에게 전달된 메시지와 첨부는 그 소유자의 기기에 저장될 수 있습니다. 운영자는 모델 학습에 메시지를 사용하지 않습니다.',
        en: 'AI crews (agents) run on their owner’s computer; only their replies are posted to the messenger. Messages and attachments sent to a crew may be stored on that owner’s device. The operator does not use messages to train models.',
      },
      {
        ko: '앱은 광고 추적을 하지 않으며 제3자에게 데이터를 판매하지 않습니다. 조직을 삭제하면 관련 데이터는 30일의 복구 기간 뒤 영구 삭제됩니다. 계정 삭제는 아래 문의처로 요청할 수 있습니다.',
        en: 'The app does not track you for advertising and does not sell data to third parties. Deleting an organization permanently removes its data after a 30-day recovery window. Account deletion can be requested through the contact below.',
      },
    ],
  },
  {
    h: { ko: '3. 정보의 이용·공유', en: '3. How we use and share information' },
    p: [
      {
        ko: '수집한 문의 정보는 답변 목적 외에 판매·대여되지 않습니다. 이메일 전달을 위해 사용자의 메일 서비스가 관여할 수 있습니다.',
        en: 'Inquiry information is not sold or rented and is used only to reply. Your own email provider may be involved in delivering the message.',
      },
    ],
  },
  {
    h: { ko: '4. 보관 기간', en: '4. Retention' },
    p: [
      {
        ko: '문의 이메일은 응대에 필요한 기간 동안 보관하며, 목적이 종료되면 파기합니다.',
        en: 'Inquiry emails are kept only as long as needed to respond and are then deleted.',
      },
    ],
  },
  {
    h: { ko: '5. 이용자의 권리', en: '5. Your rights' },
    p: [
      {
        ko: '본인의 정보에 대한 열람·정정·삭제를 요청할 수 있습니다. 요청은 lean8kim@gmail.com 으로 보내주세요.',
        en: 'You may request access to, correction of, or deletion of your information. Send requests to lean8kim@gmail.com.',
      },
    ],
  },
  {
    h: { ko: '6. 쿠키·로컬 저장소', en: '6. Cookies & local storage' },
    p: [
      {
        ko: '이 웹사이트는 추적용 광고 쿠키를 사용하지 않습니다. 언어 설정 저장에만 localStorage를 사용합니다.',
        en: 'This website does not use advertising or tracking cookies. It uses localStorage only to remember your language preference.',
      },
    ],
  },
  {
    h: { ko: '7. 정책의 변경', en: '7. Changes to this policy' },
    p: [
      {
        ko: '본 방침은 변경될 수 있으며, 변경 시 본 페이지에 게시합니다.',
        en: 'We may update this policy and will post changes on this page.',
      },
    ],
  },
  {
    h: { ko: '8. 문의', en: '8. Contact' },
    p: [
      {
        ko: '개인정보 관련 문의는 lean8kim@gmail.com 으로 연락해 주세요.',
        en: 'Privacy questions: lean8kim@gmail.com.',
      },
    ],
  },
];

export default function PrivacyPage() {
  const { lang, t } = useLang();
  const ko = lang === 'ko';
  return (
    <DocShell kicker={t('legal.kicker')} title={t('privacy.title')} updated={t('legal.updated')}>
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
