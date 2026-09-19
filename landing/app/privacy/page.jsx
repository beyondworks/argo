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
        ko: 'Argo에서 생성한 회사·크루·기억 데이터는 기기의 워크스페이스 폴더에 저장됩니다. 로그인 후 동기화가 활성화되면 동기화 대상 데이터는 클라우드에도 복제됩니다. 데이터 접근 가능 범위는 사용하는 암호화 방식에 따라 달라지며, 서버에 복호화 키가 있는 데이터는 운영자가 기술적으로 접근할 수 있습니다.',
        en: 'Company, crew, and memory data created in Argo are stored in a workspace folder on your device. When synchronization is enabled after sign-in, eligible data is also replicated to the cloud. Access depends on the encryption mode in use; the operator can technically access data whose decryption keys are held on the server.',
      },
    ],
  },
  {
    h: { ko: '2-1. Argo Messenger 앱', en: '2-1. Argo Messenger app' },
    p: [
      {
        ko: 'Argo Messenger는 서비스에서 지원하는 Apple·Google·GitHub 계정으로 로그인합니다. 계정 이메일·사용자 식별자·표시 이름과 제공자가 제공하는 프로필 사진은 로그인 유지와 구성원 관리를 위해 처리됩니다. 소셜 계정의 비밀번호는 앱에서 입력받지 않습니다.',
        en: 'Argo Messenger supports sign-in with Apple, Google, and GitHub where enabled by the service. Your account email, user identifier, display name, and profile photo supplied by the provider are processed to maintain sign-in and manage membership. The app does not ask you to enter your social account password.',
      },
      {
        ko: '서비스 제공을 위해 조직·채널·구성원, 메시지·반응·읽은 위치, 첨부 파일, 결재·참여 요청, 업무·자동화 실행, 초대 링크·알림 설정, 구성원·정책 변경 감사 기록을 Supabase 클라우드에 저장합니다. 조직 데이터는 조직·채널별 권한에 따라 제공되며, 조직 밖 개인 대화는 해당 대화의 참여자가 열람합니다. 메신저 데이터는 종단간 암호화되지 않아 운영자가 기술적으로 접근할 수 있습니다.',
        en: 'To provide the service, we store organizations, channels, membership, messages, reactions, read positions, attachments, approval and join requests, task and automation runs, invite links, notification settings, and audit records of membership and policy changes in the Supabase cloud. Organizational data is available according to organization and channel permissions; personal conversations outside organizations are visible to their participants. Messenger data is not end-to-end encrypted and can technically be accessed by the operator.',
      },
      {
        ko: '첨부 파일은 파일당 25MB까지 업로드할 수 있으며 해당 채널의 접근 권한에 따라 제공됩니다. 계정 삭제만으로 다른 구성원이 이용하는 조직의 첨부 파일이 모두 삭제되지는 않습니다.',
        en: 'Attachments of up to 25 MB each can be uploaded and are made available according to access permissions for the channel. Deleting an account does not automatically delete all attachments in organizations used by other members.',
      },
      {
        ko: '모바일 알림을 허용하면 기기 푸시 토큰·플랫폼·기기 식별용 정보와 알림 발송 기록이 저장됩니다. 알림 표시 권한은 기기의 운영체제 설정에서 변경할 수 있습니다. 로그아웃할 때 해당 기기의 푸시 등록 해제를 시도하며, 계정 삭제 시 계정에 연결된 푸시 토큰 기록이 삭제됩니다.',
        en: 'If you allow mobile notifications, we store the device push token, platform, device-identifying information, and notification delivery records. You can change permission to display notifications in your operating-system settings. On sign-out, the app attempts to unregister the device for push notifications. Account deletion removes its registered push-token records.',
      },
      {
        ko: '정확한 이메일 주소로 나를 찾는 기능은 기본으로 켜져 있으며 프로필 설정에서 끌 수 있습니다. 같은 조직의 활성 구성원은 이 설정을 꺼도 정확한 이메일로 서로를 찾을 수 있습니다. 차단 관계는 검색에서 제외됩니다. 친구는 요청을 상대가 수락하거나 한 사람이 발급한 친구 링크를 다른 사람이 수락하면 연결되며, 친구에게 허용된 프로필 정보가 제공됩니다.',
        en: 'Discovery by exact email address is enabled by default and can be disabled in profile settings. Active members of the same organization can still find one another by exact email. Blocked relationships are excluded from search. A friendship is created when a request is accepted or when someone accepts a friend link issued by the other person. Friends can access permitted profile information.',
      },
      {
        ko: 'AI 크루는 연결한 소유자의 기기에서 실행됩니다. 크루에게 전달된 메시지와 첨부는 그 기기에 저장되거나 소유자가 설정한 AI 모델 제공사(예: Anthropic·OpenAI)에 전달될 수 있습니다. 텔레그램·슬랙 등 외부 서비스 연결 자격은 크루를 실행하는 기기에서 보관될 수 있습니다. Argo Messenger가 발급하는 봇 인증 토큰은 서버에 해시로 저장합니다. 운영자는 메시지를 모델 학습에 사용하지 않습니다.',
        en: 'AI crews run on the device of the owner who connects them. Messages and attachments sent to a crew may be stored on that device or sent to the AI model provider configured by the owner, such as Anthropic or OpenAI. Credentials for external services such as Telegram and Slack may be stored on the device running the crew. Bot authentication tokens issued by Argo Messenger are stored as hashes on the server. The operator does not use messages to train models.',
      },
      {
        ko: '앱은 광고 추적을 하지 않으며 제3자에게 데이터를 판매하지 않습니다. 앱 설정에서 계정을 삭제할 수 있습니다. 다른 활성 구성원이 있는 소유 조직은 먼저 소유권을 이전해야 합니다. 계정·프로필·친구 관계·푸시 등록 등은 삭제되지만, 공유 대화의 메시지 본문과 조직 문서·감사 기록 등은 남을 수 있습니다. 메시지의 계정 참조가 제거되어도 본문 등에 직접 적힌 개인정보까지 자동으로 지워지지는 않습니다.',
        en: 'The app does not track you for advertising or sell data to third parties. You can delete your account in app settings. You must first transfer ownership of organizations with other active members. Account, profile, friendship, and push-registration records are removed, but shared messages and organizational documents or audit records may remain. Removing an account reference does not automatically erase personal information written in that content.',
      },
      {
        ko: '조직은 삭제 후 30일 동안 복구할 수 있고, 이후 정리 작업의 삭제 대상이 됩니다. 계정 삭제 과정에서 다른 활성 구성원이 없는 소유 조직은 복구 유예 없이 삭제됩니다. 현재 정리 절차는 첨부 파일의 접근 정보를 제거하더라도 저장소의 실제 파일이나 백업까지 즉시 완전히 지우는 것을 보장하지 않습니다. 삭제 범위 확인이나 남은 개인정보의 삭제 요청은 아래 문의처로 보내주세요.',
        en: 'Organizations can be restored for 30 days after deletion and then become eligible for removal by a cleanup job. During account deletion, owned organizations without other active members are deleted without a recovery period. The current cleanup process does not guarantee immediate, complete erasure of underlying files or backups when attachment access records are removed. Contact us below to confirm the scope of deletion or request removal of remaining personal information.',
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
