// 결제 로그인 화면 — 검색에 노출하지 않는다(요금제 버튼에서만 들어온다).
export const metadata = {
  title: 'Argo Pro — Sign in to subscribe',
  robots: { index: false, follow: false },
  alternates: { canonical: '/checkout' },
};

export default function CheckoutLayout({ children }) {
  return children;
}
