// 메신저 시작 순서(순수 배선) — main.jsx(진입 청크)가 부른다. React·CSS 없이 돌아가서 test/splash.test.mjs가 그대로 실행한다.
// 1) 스플래시를 먼저 띄운다. 모바일(iOS·Android)은 창 설정이 스플래시 색으로 웹뷰 바탕을 칠해 두므로, 스플래시가 닫히면(또는 아예
//    안 떴으면 바로) 지금 테마 바탕으로 바꾼다(webview-bg.js).
// 2) 앱 본체 청크를 불러온다. 실패하면 빈 화면 대신 짧은 안내와 [다시 열기]를 그린다 — 이때는 메신저 사전(i18n.js, 큰 청크 쪽)이
//    아직 없으므로 두 언어 고정 문구를 쓰고, 언어는 Argo 공통 키(argo-lang, 기본 한국어)를 따른다.
export const CHUNK_ERROR_TEXT = {
  ko: { title: '앱을 불러오지 못했습니다', hint: '네트워크나 저장 공간 상태를 확인한 뒤 다시 열어 주세요.', reload: '다시 열기' },
  en: { title: "Couldn't load the app", hint: 'Check your network or storage, then reopen.', reload: 'Reopen' },
};

export function pickLang(win = globalThis.window) {
  try { return win.localStorage.getItem('argo-lang') === 'en' ? 'en' : 'ko'; } catch { return 'ko'; }
}

export function bootMessenger({ platform, startSplash, followThemeBackground, loadApp, onChunkError, diag }) {
  const mobile = platform === 'ios' || platform === 'android';
  const splash = startSplash({ onClosed: mobile ? () => followThemeBackground() : undefined });
  if (mobile && !splash) followThemeBackground(); // 스플래시가 안 떴으면 닫힘을 기다리지 않는다
  const loaded = Promise.resolve().then(loadApp).catch((e) => {
    diag?.(e);
    splash?.ready?.(); // 가리고 있던 스플래시를 걷고 안내를 보인다
    onChunkError?.(e);
  });
  return { mobile, splash, loaded };
}

/** 앱 청크 실패 안내 — style 속성 없이(설치본 CSP) 클래스만, 모양은 splash.css. */
export function renderChunkError({ doc = globalThis.document, win = globalThis.window, lang = pickLang(win) } = {}) {
  const tx = CHUNK_ERROR_TEXT[lang] || CHUNK_ERROR_TEXT.ko;
  const box = doc.createElement('div');
  box.className = 'argo-chunk-error';
  box.setAttribute('role', 'alert');
  const title = doc.createElement('p'); title.className = 'argo-chunk-error-title'; title.textContent = tx.title;
  const hint = doc.createElement('p'); hint.className = 'argo-chunk-error-hint'; hint.textContent = tx.hint;
  const btn = doc.createElement('button'); btn.type = 'button'; btn.textContent = tx.reload;
  btn.addEventListener('click', () => win.location.reload());
  box.append(title, hint, btn);
  (doc.getElementById('root') || doc.body).appendChild(box);
  return box;
}
