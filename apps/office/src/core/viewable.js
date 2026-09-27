// 새 탭에서 바로 열어도 되는 첨부 형식 — 서버(api/mail)와 화면이 같은 기준을 쓴다.
// 앱 출처에서 스크립트가 돌 수 있는 html·svg·xml은 빼고 내려받기로 둔다.
export const VIEWABLE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|avif|bmp)|text\/plain|audio\/[\w.+-]+|video\/[\w.+-]+)$/i;
