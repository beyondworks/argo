// pdf-lib에 꽂는 글꼴 도구 — @pdf-lib/fontkit(1.1.1)은 일부만 넣기(subset)에서 겹친 글리프(한글 음절 대부분)의 부품을 빠뜨려
// 글자가 사라진다(10/2 실측: "2026-10-02 뷁 똠방각하" → "1 뷁 똠"). 원래 fontkit(2.x)은 제대로 넣는다 — pdf-lib가 부르는 옛 모양(encodeStream)만 맞춰 준다.
import * as fk from 'fontkit';

function streamOf(bytes) {
  const handlers = {};
  const api = { on(event, fn) { handlers[event] = fn; if (event === 'end') queueMicrotask(() => { handlers.data?.(bytes); handlers.end?.(); }); return api; } };
  return api;
}

export const fontkit = {
  create(buf) {
    const font = fk.create(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    return new Proxy(font, {
      get(target, key) {
        if (key === 'createSubset') return () => {
          const s = target.createSubset();
          return { get cff() { return !!s.cff; }, includeGlyph: (g) => s.includeGlyph(g), encodeStream: () => streamOf(s.encode()) };
        };
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  },
};
