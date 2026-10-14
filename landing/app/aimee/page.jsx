'use client';

// Argo landing — 새 경로 /aimee (Aimee 소개 한 페이지). privacy·refund 페이지와 같은 DocShell 틀.
// 나중에 Aimee 전용 도메인이 생기면 이 페이지에서 새 도메인으로 영구 이동(308)시킵니다.
import DocShell from '@/components/DocShell';
import { useLang } from '@/lib/i18n';

const COPY = {
  kicker: { ko: 'Aimee', en: 'Aimee' },
  title: { ko: '내 AI 에이전트를, 한 앱에서.', en: 'Your AI agents, in one app.' },
  updated: { ko: 'macOS 다운로드 — 곧 공개', en: 'macOS download — coming soon' },
  body: [
    {
      ko: 'Aimee는 내 구독과 내 API 키로 여러 AI 에이전트를 한 앱에서 같은 도구·같은 규칙으로 쓰게 해 주는 맥용 작업 비서입니다. 몇 달 전 일까지 이어서 기억합니다.',
      en: 'Aimee is a macOS desktop assistant that lets you run multiple AI agents with your own subscriptions and API keys, using the same tools and rules in one app — and it remembers your work across months.',
    },
    {
      ko: 'Aimee는 사용자의 맥에서만 동작합니다. 서비스 로그인으로 받은 토큰은 사용자 기기에 암호화해 저장하고, 운영자 서버로 보내지 않습니다.',
      en: 'Aimee runs entirely on your Mac. Sign-in tokens are stored encrypted on your device and never sent to our servers.',
    },
  ],
};

export default function AimeePage() {
  const { lang } = useLang();
  const pick = (v) => (lang === 'ko' ? v.ko : v.en);
  return (
    <DocShell kicker={pick(COPY.kicker)} title={pick(COPY.title)} updated={pick(COPY.updated)}>
      {COPY.body.map((para, i) => (
        <p key={i}>{pick(para)}</p>
      ))}
      <p>
        {lang === 'ko' ? '문의' : 'Support'}: <a href="mailto:yg@leankim.xyz">yg@leankim.xyz</a>
        {' · '}
        <a href="/privacy">{lang === 'ko' ? '개인정보처리방침' : 'Privacy Policy'}</a>
      </p>
    </DocShell>
  );
}
