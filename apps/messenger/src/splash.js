// 시작 스플래시 — 초안 A2 '북극성'(유건 선택 2026-09-29): 별이 꼬리를 끌며 내려와 자리를 잡고, 그 순간 돛이 올라온다.
// React보다 먼저 DOM으로 그린다(첫 페인트부터 보이게). 앱이 준비되면(markAppReady) 최소 0.9초를 채운 뒤 닫고, 신호가 없으면 5초에 닫는다.
// 끝맺음: 데스크톱은 로고의 별이 레일 머리의 ARGO 별(.msgr-brand svg) 자리로 날아가 앉고, 폰은 머리에 Argo 로고가 없어 살짝 떠오르며 사라진다.
// 움직임 줄이기 설정이면 페이드만. 한 페이지 로드에 한 번(앱이 백그라운드에서 돌아올 때는 페이지가 다시 로드되지 않으므로 안 뜬다).
import { splashExitAt } from './splash-timing.mjs';

const BG = '#1F1E1B'; // iOS LaunchScreen·Android 창 배경과 같은 색 — 네이티브 첫 화면에서 끊김 없이 이어진다
const YELLOW = '#E4E700';
const LOGO = `<svg viewBox="0 0 882 882" aria-hidden="true" style="width:100%;height:100%;display:block;overflow:visible">
<path data-part="sail" fill="${YELLOW}" d="M787.403 551.11H785.64L511.548 481.243L440.789 204.737L370.106 480.947L95.9297 551.11H93.8965L348.011 111H533.288L787.403 551.11Z"/>
<path data-part="star" fill="${YELLOW}" d="M477.057 628.072L440.789 770.352L404.561 628.224L262.241 591.804L404.408 555.423L440.789 413.256L477.209 555.575L619.337 591.804L477.057 628.072Z"/></svg>`;

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

let readyAt = null;
let onReady = null;
export function markAppReady() {
  if (readyAt != null) return;
  readyAt = performance.now();
  onReady?.();
}

export function startSplash() {
  if (typeof document === 'undefined' || !document.body) return;
  // index.html의 정적 바탕을 이어받는다(첫 페인트부터 같은 색) — 없으면(테스트·다른 진입점) 새로 만든다. 두 번 시작하지 않는다
  let root = document.getElementById('argo-splash');
  if (root?.dataset.started) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const phone = window.matchMedia?.('(max-width: 720px)').matches;
  const startedAt = performance.now();

  if (!root) { root = document.createElement('div'); root.id = 'argo-splash'; document.body.appendChild(root); }
  root.dataset.started = '1';
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = `position:fixed;inset:0;z-index:2147483000;background:${BG};display:grid;place-items:center;pointer-events:auto;overflow:hidden`; // 정적 바탕의 8초 안전 사라짐은 여기서 푼다(스크립트가 닫는다)
  const size = phone ? 'min(30vw, 132px)' : '112px';
  root.innerHTML = `<div data-part="glow" style="position:absolute;width:calc(${size} * 2.3);aspect-ratio:1;border-radius:50%;background:radial-gradient(circle, rgba(228,231,0,.26), rgba(228,231,0,0) 62%);opacity:0"></div>
<div data-part="trail" style="position:absolute;width:3px;border-radius:99px;background:linear-gradient(to top, rgba(228,231,0,.9), rgba(228,231,0,0));transform-origin:50% 100%;opacity:0"></div>
<div data-part="logo" style="position:relative;width:${size};aspect-ratio:1">${LOGO}</div>`;

  const $ = (k) => root.querySelector(`[data-part="${k}"]`);
  const logo = $('logo'), sail = $('sail'), star = $('star'), glow = $('glow'), trail = $('trail');
  for (const el of [sail, star]) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = '50% 50%'; }
  const A = (el, frames, o) => el.animate(frames, { fill: 'both', ...o });

  const running = [];
  if (reduced) {
    running.push(A(logo, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease' }));
  } else {
    const s = spring(0.60, 3.0);
    const sb = star.getBoundingClientRect(), cx = sb.left + sb.width / 2, cy = sb.top + sb.height / 2;
    const tl = Math.min(innerHeight * 0.3, 260);
    Object.assign(trail.style, { left: `${cx - 1.5}px`, top: `${cy - tl}px`, height: `${tl}px` });
    const lb = logo.getBoundingClientRect();
    glow.style.left = `${cx - glow.offsetWidth / 2}px`; glow.style.top = `${cy - glow.offsetWidth / 2}px`;
    void lb;
    const drop = -(cy - innerHeight * (phone ? 0.12 : 0.1));
    running.push(
      A(star, [{ opacity: 0, transform: `translateY(${drop}px) scale(0.55) rotate(-25deg)` }, { opacity: 1, transform: `translateY(${drop * 0.9}px) scale(0.6) rotate(-22deg)`, offset: 0.08 }, { opacity: 1, transform: 'translateY(0) scale(1) rotate(0deg)' }], { duration: s.ms, easing: s.easing }),
      A(trail, [{ opacity: 0, transform: `translateY(${drop}px) scaleY(0.4)` }, { opacity: 0.9, transform: `translateY(${drop * 0.5}px) scaleY(1)`, offset: 0.35 }, { opacity: 0, transform: 'translateY(0) scaleY(0.1)' }], { duration: 560, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' }),
      A(sail, [{ clipPath: 'inset(100% 0 0 0)', transform: 'translateY(8%)' }, { clipPath: 'inset(0 0 0 0)', transform: 'none' }], { duration: 440, delay: 430, easing: EASE_OUT }),
      A(glow, [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)', offset: 0.35 }, { opacity: 0, transform: 'scale(1.35)' }], { duration: 700, delay: 420, easing: EASE_OUT }),
    );
  }

  let breathe = null, closing = false;
  const close = () => {
    if (closing) return; closing = true;
    breathe?.cancel();
    root.style.pointerEvents = 'none';
    const target = !phone && !reduced ? document.querySelector('.msgr-brand svg') : null;
    const tb = target?.getBoundingClientRect();
    let fly;
    if (tb && tb.width > 0) {
      // 로고의 별이 레일 머리 ARGO 별 자리에 겹쳐 앉도록 — 별 중심을 목표 중심으로, 별 폭을 목표 폭으로
      const sb = star.getBoundingClientRect();
      const k = tb.width / sb.width, lb = logo.getBoundingClientRect();
      const ox = lb.left + lb.width / 2, oy = lb.top + lb.height / 2; // 로고 변환 기준점(가운데)
      const dx = tb.left + tb.width / 2 - (ox + (sb.left + sb.width / 2 - ox) * k);
      const dy = tb.top + tb.height / 2 - (oy + (sb.top + sb.height / 2 - oy) * k);
      fly = A(logo, [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 1, offset: 0.9 }, { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0 }], { duration: 480, easing: EASE_IN_OUT });
      A(root, [{ backgroundColor: BG }, { backgroundColor: 'rgba(31,30,27,0)' }], { duration: 420, delay: 80, easing: 'ease-out' });
    } else {
      fly = A(logo, [{ transform: 'none', opacity: 1 }, { transform: reduced ? 'none' : 'translateY(-10px) scale(0.94)', opacity: 0 }], { duration: reduced ? 240 : 320, easing: EASE_OUT });
      A(root, [{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 260 : 340, delay: reduced ? 0 : 60, easing: 'ease-out' });
    }
    fly.finished.catch(() => {}).finally(() => setTimeout(() => root.remove(), 120));
  };

  const schedule = () => {
    const wait = splashExitAt(startedAt, readyAt) - performance.now();
    setTimeout(close, Math.max(0, wait));
  };
  onReady = schedule;
  if (readyAt != null) schedule();
  // 준비 신호가 영영 안 오면(예외 화면) 5초에 닫는다
  setTimeout(() => { if (!closing) close(); }, splashExitAt(startedAt, null) - startedAt);
  // 인트로가 끝났는데 아직 준비 전이면 로고가 천천히 숨 쉬듯 머문다(멈춘 앱처럼 보이지 않게)
  if (!reduced) setTimeout(() => { if (!closing && readyAt == null) breathe = logo.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 1600, iterations: Infinity, easing: 'ease-in-out' }); }, 1000);
  return running;
}
