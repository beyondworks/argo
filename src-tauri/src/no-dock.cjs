'use strict';
// Argo 자동 생성 — macOS Dock 아이콘 억제(src/no-dock.mjs). 직접 수정하지 마세요.
if (process.platform === 'darwin') {
  try {
    var cur = process.title;
    Object.defineProperty(process, 'title', {
      get: function () { return cur; },
      set: function () { /* 무시 — 대입이 Launch Services 등록(Dock 아이콘)을 만든다 */ },
      configurable: true,
      enumerable: true,
    });
  } catch (e) { /* 재정의 실패 — 원래 동작 유지 */ }
}
