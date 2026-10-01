// 북극성 시작 스플래시 엔진(정본 하나) — 초안 A2 '북극성'(유건 선택 2026-09-29): 별이 꼬리를 끌며 내려와 자리를 잡고, 그 순간 돛이 올라온다.
// 쓰는 곳: 메신저(apps/messenger/src/splash.js, 별칭 @argo/splash), Argo 본체 부트 화면(public/boot-splash.mjs)과 Next 첫 화면(app/splash-continue.jsx).
// 부트 화면은 번들러 없이 public 파일만 읽으므로 정본이 public/에 있다(사본 금지 — 메신저는 vite 별칭, Next는 상대 경로로 가져간다).
//
// CSP 규칙(반대 검토 2026-10-01, WKWebView 재현): style 속성을 만들지 않는다. Tauri는 HTML에 <style>이 있으면 style-src에 nonce를 붙이고,
// nonce가 있으면 'unsafe-inline'이 무시돼 HTML·innerHTML·setAttribute의 style 속성이 전부 막힌다(로고 폭 0으로 아무것도 안 보였다).
// 그래서 DOM은 createElement로 만들고 크기·위치·색은 CSSOM(el.style.x = …)으로만 정한다. SVG의 fill 같은 표현 속성은 막히지 않는다.
// test/north-star-splash.test.mjs가 잠근다.
import { splashExitAt, SPLASH_MIN_MS, SPLASH_MAX_MS } from './timing.mjs';

export const LOGO_VIEWBOX = '0 0 882 882';
export const SAIL_D = 'M787.403 551.11H785.64L511.548 481.243L440.789 204.737L370.106 480.947L95.9297 551.11H93.8965L348.011 111H533.288L787.403 551.11Z';
export const STAR_D = 'M477.057 628.072L440.789 770.352L404.561 628.224L262.241 591.804L404.408 555.423L440.789 413.256L477.209 555.575L619.337 591.804L477.057 628.072Z';

// 등장이 끝났다고 보는 상한 — 가장 긴 후광이 420ms 지연 + 700ms. 창이 가려지면(최소화·다른 앱 뒤) rAF와 WAAPI가 멈춰
// finished가 영영 안 끝난다(반대 검토 #2 실측: 2.5초간 currentTime 0). setTimeout은 돌기 때문에 타이머 상한을 같이 건다.
export const INTRO_CAP_MS = 1400;

// Argo 본체 색 — graphite(시스템 밝기를 따름). app/globals.css :root[data-theme='graphite']의 --bg·--primary와 같아야 한다(테스트가 잠근다).
// rgb는 마크 색(후광·꼬리 그라데이션), bgRgb는 바탕 색(끝맺음에서 투명으로 풀 때).
export const GRAPHITE = {
  light: { bg: '#fafafa', mark: '#1a1a1a', rgb: '26, 26, 26', bgRgb: '250, 250, 250', glowA: 0.1, trailA: 0.5 },
  dark: { bg: '#202020', mark: '#ededed', rgb: '237, 237, 237', bgRgb: '32, 32, 32', glowA: 0.16, trailA: 0.7 },
};
export function graphitePalette(win = globalThis) {
  return win.matchMedia?.('(prefers-color-scheme: dark)').matches ? GRAPHITE.dark : GRAPHITE.light;
}

// 감쇠 진동자(감쇠비·진동수) → CSS linear() 이징과 가라앉는 시간 — 초안과 같은 smooth 스프링(0.60·3.0Hz)
function spring(z, hz) {
  const w = 2 * Math.PI * hz, wd = w * Math.sqrt(1 - z * z), T = Math.log(1000) / (z * w), N = 48, pts = [];
  for (let i = 0; i <= N; i++) { const t = (i / N) * T; pts.push(+(1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t))).toFixed(4)); }
  pts[N] = 1;
  const ok = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', 'linear(0, 1)');
  return { easing: ok ? `linear(${pts.join(', ')})` : 'cubic-bezier(0.34, 1.3, 0.64, 1)', ms: Math.round(T * 1000) };
}
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 스플래시를 띄운다. 한 root에 한 번만(두 번째 호출은 null).
 * @param {object} o
 * @param {Element} [o.root]   이어받을 정적 바탕(HTML의 #argo-splash). 없으면 body 끝에 새로 만든다.
 * @param {object}  o.palette  { bg, mark, rgb, bgRgb, glowA, trailA }
 * @param {string}  [o.size]   로고 한 변(CSS 길이)
 * @param {boolean} [o.phone]  폰 배치(낙하 거리·끝맺음은 떠오르며 사라짐)
 * @param {boolean} [o.hold]   등장 없이 마지막 프레임으로 시작(본체 2단계 — 등장은 부트 화면에서 이미 재생)
 * @param {boolean} [o.breathe] 등장 뒤에도 준비 전이면 숨 쉬듯 머문다(멈춘 앱처럼 보이지 않게)
 * @param {boolean} [o.fullWidth] 가로를 100vw로(기본 켬 — html에 zoom이 걸린 화면은 끈다)
 * @param {boolean} [o.autoClose] false면 스스로 닫지 않는다(부트 화면 — 다음 화면 이동이 덮는다)
 * @param {number}  [o.minMs] [o.maxMs]  닫는 시각(timing.mjs)
 * @param {() => Element|null} [o.target] 끝맺음에서 로고의 별이 날아가 앉을 자리
 * @param {() => void} [o.onClosed]
 * @returns {{ root: Element, introDone: Promise<void>, ready: (at?: number) => void, close: () => void } | null}
 */
export function startNorthStar({
  doc = globalThis.document, win = globalThis.window, root, palette, size = '112px', phone = false, hold = false,
  breathe = true, fullWidth = true, autoClose = true, minMs = SPLASH_MIN_MS, maxMs = SPLASH_MAX_MS, target = null, onClosed,
} = {}) {
  if (!doc?.body || !palette) return null;
  if (root?.dataset.started) return null;
  const now = () => win.performance.now();
  const reduced = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // 창이 안 보이는 채로 시작하면 등장을 건너뛰고 마지막 프레임으로(멈춘 애니메이션이 첫 장면에 걸려 있지 않게 — 반대 검토 #2)
  const still = hold || doc.visibilityState === 'hidden';
  const startedAt = now();

  if (!root) { root = doc.createElement('div'); root.id = 'argo-splash'; doc.body.appendChild(root); }
  root.dataset.started = '1';
  root.setAttribute('aria-hidden', 'true');
  root.textContent = '';
  // 정적 바탕(CSS 파일)의 8초 안전 사라짐은 animation:none으로 푼다 — 이제 스크립트가 닫는다
  Object.assign(root.style, {
    position: 'fixed', inset: '0', zIndex: '2147483000', background: palette.bg, color: palette.mark,
    display: 'grid', placeItems: 'center', pointerEvents: 'auto', overflow: 'hidden', animation: 'none', opacity: '1', visibility: 'visible',
  });

  // 가로를 100vw로 — 고전 스크롤바가 있는 화면(Windows)에서도 가운데가 스크롤바 없는 부트 화면과 같은 자리(inset:0이면 스크롤바 폭의 절반만큼
  // 왼쪽으로 밀린다). html에 CSS zoom이 걸린 화면은 vw까지 배율이 곱해져 오른쪽으로 밀리므로(Chromium 실측) 부르는 쪽이 끈다.
  if (fullWidth) Object.assign(root.style, { right: 'auto', width: '100vw' });

  const part = (name) => { const e = doc.createElement('div'); e.dataset.part = name; return e; };
  const glow = part('glow'), trail = part('trail'), logo = part('logo');
  Object.assign(glow.style, {
    position: 'absolute', width: `calc(${size} * 2.3)`, aspectRatio: '1', borderRadius: '50%', opacity: '0',
    background: `radial-gradient(circle, rgba(${palette.rgb}, ${palette.glowA}), rgba(${palette.rgb}, 0) 62%)`,
  });
  Object.assign(trail.style, {
    position: 'absolute', width: '3px', borderRadius: '99px', transformOrigin: '50% 100%', opacity: '0',
    background: `linear-gradient(to top, rgba(${palette.rgb}, ${palette.trailA}), rgba(${palette.rgb}, 0))`,
  });
  Object.assign(logo.style, { position: 'relative', width: size, height: size });
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', LOGO_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, { width: '100%', height: '100%', display: 'block', overflow: 'visible' });
  const path = (name, d) => {
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('data-part', name); p.setAttribute('d', d); p.setAttribute('fill', 'currentColor');
    Object.assign(p.style, { transformBox: 'fill-box', transformOrigin: '50% 50%' });
    svg.appendChild(p);
    return p;
  };
  const sail = path('sail', SAIL_D), star = path('star', STAR_D);
  logo.appendChild(svg);
  root.append(glow, trail, logo);

  const A = (el, frames, o) => el.animate(frames, { fill: 'both', ...o });
  const running = [];
  if (still) {
    // 마지막 프레임 그대로 — 부트 화면이 이동 직전에 보여 준 장면과 같다
  } else if (reduced) {
    running.push(A(logo, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease' }));
  } else {
    const s = spring(0.60, 3.0);
    const sb = star.getBoundingClientRect(), cx = sb.left + sb.width / 2, cy = sb.top + sb.height / 2;
    const tl = Math.min(win.innerHeight * 0.3, 260);
    Object.assign(trail.style, { left: `${cx - 1.5}px`, top: `${cy - tl}px`, height: `${tl}px` });
    glow.style.left = `${cx - glow.offsetWidth / 2}px`; glow.style.top = `${cy - glow.offsetWidth / 2}px`;
    const drop = -(cy - win.innerHeight * (phone ? 0.12 : 0.1));
    running.push(
      A(star, [{ opacity: 0, transform: `translateY(${drop}px) scale(0.55) rotate(-25deg)` }, { opacity: 1, transform: `translateY(${drop * 0.9}px) scale(0.6) rotate(-22deg)`, offset: 0.08 }, { opacity: 1, transform: 'translateY(0) scale(1) rotate(0deg)' }], { duration: s.ms, easing: s.easing }),
      A(trail, [{ opacity: 0, transform: `translateY(${drop}px) scaleY(0.4)` }, { opacity: 0.9, transform: `translateY(${drop * 0.5}px) scaleY(1)`, offset: 0.35 }, { opacity: 0, transform: 'translateY(0) scaleY(0.1)' }], { duration: 560, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' }),
      A(sail, [{ clipPath: 'inset(100% 0 0 0)', transform: 'translateY(8%)' }, { clipPath: 'inset(0 0 0 0)', transform: 'none' }], { duration: 440, delay: 430, easing: EASE_OUT }),
      A(glow, [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)', offset: 0.35 }, { opacity: 0, transform: 'scale(1.35)' }], { duration: 700, delay: 420, easing: EASE_OUT }),
    );
  }
  // 등장 끝 = 모든 애니메이션 종료와 타이머 상한 중 먼저 오는 쪽
  const introDone = running.length
    ? Promise.race([Promise.all(running.map((a) => a.finished.catch(() => {}))), new Promise((r) => win.setTimeout(r, INTRO_CAP_MS))]).then(() => {})
    : Promise.resolve();

  let readyAt = null, breathing = null, closing = false;
  const close = () => {
    if (closing) return; closing = true;
    breathing?.cancel();
    root.style.pointerEvents = 'none';
    const t = !phone && !reduced && target ? target() : null;
    const tb = t?.getBoundingClientRect();
    let fly;
    if (tb && tb.width > 0) {
      // 로고의 별이 목표 별 자리에 겹쳐 앉도록 — 별 중심을 목표 중심으로, 별 폭을 목표 폭으로
      const sb = star.getBoundingClientRect();
      const k = tb.width / sb.width, lb = logo.getBoundingClientRect();
      const ox = lb.left + lb.width / 2, oy = lb.top + lb.height / 2; // 로고 변환 기준점(가운데)
      const dx = tb.left + tb.width / 2 - (ox + (sb.left + sb.width / 2 - ox) * k);
      const dy = tb.top + tb.height / 2 - (oy + (sb.top + sb.height / 2 - oy) * k);
      fly = A(logo, [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 1, offset: 0.9 }, { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0 }], { duration: 480, easing: EASE_IN_OUT });
      A(root, [{ backgroundColor: palette.bg }, { backgroundColor: `rgba(${palette.bgRgb}, 0)` }], { duration: 420, delay: 80, easing: 'ease-out' });
    } else {
      fly = A(logo, [{ transform: 'none', opacity: 1 }, { transform: reduced ? 'none' : 'translateY(-10px) scale(0.94)', opacity: 0 }], { duration: reduced ? 240 : 320, easing: EASE_OUT });
      A(root, [{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 260 : 340, delay: reduced ? 0 : 60, easing: 'ease-out' });
    }
    // 가려진 창에서는 finished가 안 끝나므로 타이머로도 걷는다
    let removed = false;
    const remove = () => { if (removed) return; removed = true; root.remove(); onClosed?.(); };
    fly.finished.catch(() => {}).finally(() => win.setTimeout(remove, 120));
    win.setTimeout(remove, 900);
  };

  const ready = (at) => {
    if (readyAt != null) return;
    readyAt = at ?? now();
    if (!autoClose) return;
    win.setTimeout(close, Math.max(0, splashExitAt(startedAt, readyAt, minMs, maxMs) - now()));
  };
  if (autoClose) {
    // 준비 신호가 영영 안 오면(예외 화면) 상한에 닫는다
    win.setTimeout(() => { if (!closing) close(); }, splashExitAt(startedAt, null, minMs, maxMs) - startedAt);
  }
  // 등장이 끝났는데 아직 준비 전이면 로고가 천천히 숨 쉬듯 머문다
  if (breathe && !reduced) {
    win.setTimeout(() => { if (!closing && readyAt == null) breathing = logo.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 1600, iterations: Infinity, easing: 'ease-in-out' }); }, 1000);
  }
  return { root, introDone, ready, close };
}
