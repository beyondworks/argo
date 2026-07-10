import './globals.css';

export const metadata = {
  title: 'Argo — 한 배에 오른 AI 크루',
  description: '프롬프트 한 줄로 전문 AI 크루를 영입하고, 회사가 폴더 단위 기억으로 항해합니다.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
