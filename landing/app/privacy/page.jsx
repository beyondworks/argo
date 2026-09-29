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
        ko: 'Argo 애플리케이션에서 생성한 회사·크루·기억 데이터는 사용자 기기의 워크스페이스 폴더에 저장됩니다. 로그인하지 않으면 이 데이터는 컴퓨터 밖으로 나가지 않습니다.',
        en: 'Company, crew, and memory data you create in the Argo application are stored in a workspace folder on your device. If you do not sign in, this data does not leave your computer.',
      },
      {
        ko: '로그인해 기기 간 동기화를 쓰면 회사 데이터(기억·대화·크루)가 암호화(AES-256-GCM)되어 Argo 클라우드에 복제됩니다. 이 암호화의 열쇠도 같은 클라우드에 있어 운영자가 기술적으로 복호화할 수 있습니다. AI 제공자의 API 키·로그인 토큰과 텔레그램·슬랙 봇 토큰 같은 자격 증명은 호스티드 동기화에서 제외되어 기기 밖으로 올라가지 않습니다. 자세한 내용은 문서의 “동기화와 자격 증명” 절을 참고하세요.',
        en: 'If you sign in and use cross-device sync, company data (memory, conversations, crews) is encrypted (AES-256-GCM) and replicated to the Argo cloud. The key for this encryption is kept in the same cloud, so the operator can technically decrypt it. Credentials such as AI provider API keys and login tokens and Telegram or Slack bot tokens are excluded from hosted sync and are not uploaded. See the “Sync & credentials” section of the docs for details.',
      },
    ],
  },
  {
    h: { ko: '2-1. Argo Messenger 앱', en: '2-1. Argo Messenger app' },
    p: [
      {
        ko: 'Argo Messenger(iOS·Android·macOS·Windows)는 Apple, Google 또는 GitHub 계정으로 로그인합니다. 이때 계정 이메일, 사용자 식별자, 표시 이름과 프로필 사진(제공자가 주는 경우)이 조직 구성원 관리와 로그인 유지를 위해 저장됩니다. 비밀번호는 저장하지 않습니다.',
        en: 'Argo Messenger (iOS, Android, macOS, and Windows) signs you in with an Apple, Google, or GitHub account. Your account email, user identifier, display name, and profile photo (when the provider supplies one) are stored to manage organization membership and keep you signed in. No passwords are stored.',
      },
      {
        ko: '서비스 제공을 위해 다음 정보가 클라우드 데이터베이스(Supabase, 서울 리전)에 저장됩니다: 조직·채널·구성원 목록, 메시지와 반응, 읽은 위치, 첨부 파일(파일당 25MB까지), 결재·참여 요청 기록, 업무와 자동화 실행 기록, 초대 링크, 알림 설정, 그리고 구성원·정책 변경에 대한 감사 기록(누가 언제 무엇을 바꿨는지). 이 정보는 같은 조직의 구성원에게 허용된 채널 범위에서만 보이며, 첨부 파일은 채널 구성원만 내려받을 수 있습니다.',
        en: 'To provide the service, the following is stored in a cloud database (Supabase, Seoul region): organizations, channels and member lists, messages and reactions, read positions, attachments (up to 25 MB each), approval and join-request records, task and automation run records, invite links, notification settings, and an audit trail of membership and policy changes (who changed what, when). This information is visible only to members of the same organization within permitted channels, and attachments can be downloaded only by channel members.',
      },
      {
        ko: '모바일 앱에서 알림을 허용하면 기기 푸시 토큰, 플랫폼(iOS·Android), 기기 이름이 저장되고 알림 발송 기록이 남습니다. 알림은 앱 설정에서 언제든 끌 수 있으며, 끄면 토큰은 더 이상 사용되지 않습니다.',
        en: 'If you allow notifications in the mobile app, your device push token, platform (iOS or Android), and device name are stored, and a record of sent notifications is kept. You can turn notifications off in the app settings at any time, after which the token is no longer used.',
      },
      {
        ko: '다른 사용자가 내 이메일 주소를 정확히 입력하면 나를 찾을 수 있습니다. 이 설정은 기본으로 켜져 있으며, 설정 › 내 계정 › 프로필에서 끌 수 있습니다. 부분 일치 검색은 되지 않습니다. 같은 조직의 구성원은 설정과 관계없이 서로를 찾을 수 있습니다. 친구 관계는 양쪽이 수락한 뒤에만 만들어집니다.',
        en: 'Other users can find you if they enter your exact email address. This setting is on by default, and you can turn it off in Settings › My account › Profile. Partial matches are not searchable. Members of the same organization can always find each other regardless of this setting. Friend connections are created only after both sides accept.',
      },
      {
        ko: 'AI 크루(에이전트)는 소유자의 컴퓨터에서 실행되며, 메신저에는 답변만 올라옵니다. 크루에게 전달된 메시지와 첨부는 그 소유자의 기기에 저장될 수 있고, 소유자가 설정한 AI 모델 제공사(예: Anthropic, OpenAI 등)에 전달될 수 있습니다. 텔레그램·슬랙 등 외부 연동도 소유자의 기기에서 동작합니다. 외부 봇에 발급한 연결 토큰은 해시 값과 알아보기 위한 앞부분 12자만 저장하며 원문은 보관하지 않습니다. 운영자는 메시지를 모델 학습에 사용하지 않습니다.',
        en: 'AI crews (agents) run on their owner’s computer; only their replies are posted to the messenger. Messages and attachments addressed to a crew may be stored on that owner’s device and may be sent to the AI model provider the owner has configured (for example Anthropic or OpenAI). External integrations such as Telegram and Slack also run on the owner’s device. For connection tokens issued to external bots, only a hash and the first 12 characters (so you can recognize the token) are stored; the full token is never kept. The operator does not use messages to train models.',
      },
      {
        ko: '조직 공간에서 AI 크루와 봇은 대화(채널의 최근 대화 포함)와 첨부를 읽고, 크루 소유자가 설정한 제3자 AI 제공자로 보낼 수 있습니다. 앱이 연결을 지원하는 제공자는 Anthropic(Claude), OpenAI(Codex·GPT), Google(Gemini·Antigravity), Moonshot AI(Kimi), xAI(Grok), Zhipu AI(Z.ai, GLM), OpenRouter(소유자가 고른 모델의 제공사로 중계)입니다. 크루 소유자가 연결한 외부 에이전트(봇)에 보낸 메시지는 그 에이전트를 운영하는 쪽이 설정한 제공자로 전송될 수 있습니다. 앱은 처음 사용할 때(기존 사용자는 업데이트 뒤 처음 실행할 때) 조직 공간에 들어가기 전에 이 처리에 대해 한 번 동의를 받습니다. 동의하지 않으면 조직 공간은 쓸 수 없고, 조직 밖 사람끼리 1:1로 대화하는 개인 공간만 쓸 수 있습니다. 동의는 설정에서 철회할 수 있으며, 철회하면 조직 공간을 쓸 수 없습니다. 동의하지 않은 사람의 글은 크루와 봇에게 전달되지 않습니다. 제공자가 받은 데이터를 어떻게 보관하고 이용하는지는 각 제공자의 개인정보처리방침과 약관, 그리고 크루 소유자의 계정 설정을 따릅니다.',
        en: 'In organization spaces, AI crews and bots can read conversations (including recent conversation in a channel) and attachments and send them to the third-party AI provider configured by the crew’s owner. The providers the app supports are Anthropic (Claude), OpenAI (Codex, GPT), Google (Gemini, Antigravity), Moonshot AI (Kimi), xAI (Grok), Zhipu AI (Z.ai, GLM), and OpenRouter (which relays to the provider of the model the owner selects). Messages sent to an external agent (bot) connected by a crew owner may be transmitted to the provider configured by whoever operates that agent. The app asks for your consent to this processing once, before you enter an organization space, when you first use the app (for existing users, on the first launch after updating). If you decline, you cannot use organization spaces and can use only the personal space for 1:1 conversations between people outside an organization. You can withdraw consent in Settings; after withdrawal you cannot use organization spaces. Messages from people who have not consented are not passed to crews or bots. How a provider stores and uses the data it receives is governed by that provider’s privacy policy and terms and by the crew owner’s account settings.',
      },
      {
        ko: '알림에는 보낸 사람 이름과 메시지 미리보기가 들어가며, Apple 푸시 알림 서비스(iOS)와 Google Firebase Cloud Messaging(Android)을 거쳐 기기로 전달됩니다.',
        en: 'Notifications include the sender’s name and a message preview and are delivered to your device through Apple Push Notification service (iOS) and Google Firebase Cloud Messaging (Android).',
      },
      {
        ko: '부적절한 메시지는 메시지 메뉴(휴대폰에서는 메시지를 길게 누르기)의 “메시지 신고”로 신고할 수 있습니다. 신고에는 검토를 위해 신고 당시 메시지 내용의 사본, 작성자, 신고 이유가 함께 저장되며, 조직 관리자(개인 대화는 Argo 운영팀)가 확인합니다.',
        en: 'You can report an inappropriate message with “Report message” in the message menu (long-press the message on a phone). For review, a report stores a copy of the message as it was when reported, its author, and the reason, and it is reviewed by the organization’s admins (or the Argo team for personal conversations).',
      },
      {
        ko: '앱은 광고 추적을 하지 않으며 제3자에게 데이터를 판매하지 않습니다. 계정은 앱의 설정 › 내 계정 › 계정 삭제에서 직접 삭제할 수 있습니다. 삭제하면 계정 정보와 친구 관계는 즉시 지워지고, 조직에 남긴 글은 작성자 이름 없이 남습니다(조직의 대화 맥락을 유지하기 위함). 조직을 삭제하면 30일 동안 소유자가 복구할 수 있으며, 그 뒤 영구 삭제를 원하면 lean8kim@gmail.com 으로 요청할 수 있습니다.',
        en: 'The app does not track you for advertising and does not sell data to third parties. You can delete your account directly in the app under Settings › My account › Delete account. Deletion immediately removes your account information and friend connections; messages you posted in organizations remain without your name, so the organization’s conversation history stays intact. When an organization is deleted, its owner can restore it for 30 days; after that, you can request permanent deletion by emailing lean8kim@gmail.com.',
      },
      {
        ko: '계정 삭제로 함께 지워지는 것: 프로필과 프로필 사진, 친구·차단 목록, 알림 설정과 기기 푸시 토큰, 읽은 위치, 반응, 조직·채널 멤버십, 내 AI 크루와 그 설정, 아직 쓰지 않은 초대, 내가 한 신고, 그리고 나만 남아 있는 내 소유 조직(첨부 파일 포함). 다른 구성원이 있는 조직을 소유하고 있다면 삭제 전에 소유권을 넘겨야 합니다. 내가 만든 채널·문서·업무 기록은 조직의 기록이므로 그 조직의 소유자에게 넘어가고, 감사 기록에는 삭제된 계정의 내부 식별자가 남을 수 있습니다.',
        en: 'Deleting your account also removes: your profile and profile photo, friend and block lists, notification settings and device push tokens, read positions, reactions, organization and channel memberships, your AI crews and their settings, unused invites, reports you filed, and organizations you own where you are the only member (including attachments). If you own an organization that has other members, you must transfer ownership before deleting. Channels, documents, and task records you created belong to the organization and are transferred to its owner, and audit records may retain the deleted account’s internal identifier.',
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
      {
        ko: '운영자는 서비스를 제공하기 위해 다음 업체에 데이터 처리를 맡깁니다: Supabase(데이터베이스·파일 저장·로그인, 서울 리전), Apple과 Google(푸시 알림 전달, 그리고 Apple·Google·GitHub 계정 로그인), Lemon Squeezy(유료 구독의 결제·청구 정보 처리 — 판매자로서 결제를 처리하며, 카드 정보는 운영자가 받지 않습니다). 이 밖에 이용자가 크루에게 보낸 메시지와 첨부는 2-1항에 적은 대로 크루 소유자가 설정한 AI 제공자로 전송됩니다.',
        en: 'To provide the service, the operator uses the following processors: Supabase (database, file storage, and sign-in; Seoul region); Apple and Google (push notification delivery, and sign-in with Apple, Google, or GitHub accounts); and Lemon Squeezy (payment and billing information for paid subscriptions — it processes payments as the merchant of record, and the operator does not receive your card details). In addition, messages and attachments you send to a crew are transmitted to the AI provider configured by the crew’s owner, as described in Section 2-1.',
      },
      {
        ko: '운영자는 이용자 데이터를 받는 제3자(위의 처리 업체와 앱이 연결을 지원하는 AI 제공자)가 이 방침에서 약속한 것과 같거나 그 이상의 수준으로 데이터를 보호하도록 요구하며, 그런 제3자와만 데이터를 공유합니다. 법령에 따른 요청이 있는 경우를 제외하고, 위에 적지 않은 제3자에게 개인정보를 제공하지 않습니다.',
        en: 'The operator requires every third party that receives user data (the processors above and the AI providers the app supports) to protect that data at a level equal to or greater than the protections described in this policy, and shares data only with such third parties. Except when required by law, we do not provide personal information to any third party not listed above.',
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
      {
        ko: 'Argo Messenger의 계정 정보·프로필·친구 관계·기기 푸시 토큰은 계정을 삭제할 때까지 보관하며, 계정을 삭제하면 즉시 지워집니다(2-1항).',
        en: 'In Argo Messenger, account information, profile, friend connections, and device push tokens are kept until you delete your account and are removed immediately when you do (Section 2-1).',
      },
      {
        ko: '조직의 메시지·첨부·결재·업무 기록·감사 기록은 조직이 존재하는 동안 보관합니다. 내가 보낸 메시지는 직접 삭제할 수 있으며, 삭제하면 본문이 지워지고 “삭제된 메시지”로 표시됩니다. 조직을 삭제하면 30일 동안 소유자가 복구할 수 있습니다. 그 뒤 조직과 그 데이터의 영구 삭제를 원하면 lean8kim@gmail.com 으로 요청할 수 있습니다.',
        en: 'An organization’s messages, attachments, approvals, task records, and audit records are kept while the organization exists. You can delete messages you sent; deleting a message erases its text and shows it as “deleted.” When an organization is deleted, its owner can restore it for 30 days. After that, you can request permanent deletion of the organization and its data by emailing lean8kim@gmail.com.',
      },
      {
        ko: '초대 링크는 기본 7일 뒤 만료됩니다. 신고 기록은 검토와 처리를 위해 보관하며, 신고한 사람이 계정을 삭제하거나 조직이 삭제되면 함께 지워집니다.',
        en: 'Invite links expire after 7 days by default. Reports are kept for review and resolution and are removed when the reporter deletes their account or the organization is deleted.',
      },
    ],
  },
  {
    h: { ko: '5. 이용자의 권리', en: '5. Your rights' },
    p: [
      {
        ko: '본인의 정보에 대한 열람·정정·삭제를 요청할 수 있습니다. Argo Messenger 계정은 앱의 설정 › 내 계정 › 계정 삭제에서 바로 삭제할 수 있고, 프로필·표시 이름·이메일 검색 허용 여부는 설정 › 내 계정에서 직접 고칠 수 있습니다. 그 밖의 요청은 lean8kim@gmail.com 으로 보내주세요.',
        en: 'You may request access to, correction of, or deletion of your information. You can delete your Argo Messenger account directly under Settings › My account › Delete account, and you can edit your profile, display name, and whether others can find you by email under Settings › My account. Send any other requests to lean8kim@gmail.com.',
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
