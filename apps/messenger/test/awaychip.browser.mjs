// 화면 검수 UM3(2026-10-05): 꺼진 에이전트 안내 칩(.msgr-replychip.msgr-awaychip)이 계산 스타일로 두 줄까지 보이고 잘리지 않는가 — 실제 렌더러에서
// (innerText만 보던 테스트가 nowrap 말줄임을 못 잡았다). 픽스처 문서(frame)의 입력창 위에 칩을 넣고 잰다. 돌려준 값: 폭·줄 수·잘림 여부.
export async function verifyAwayChip(doc, text) {
  const dock = doc.querySelector('.msgr-dock'); if (!dock) throw new Error('입력창(.msgr-dock)이 없다');
  const chip = doc.createElement('div'); chip.className = 'msgr-replychip msgr-awaychip'; chip.setAttribute('role', 'status');
  chip.innerHTML = `<span class="q"></span><button type="button" class="msgr-titlebtn">×</button>`; chip.querySelector('.q').textContent = text;
  dock.prepend(chip);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const q = chip.querySelector('.q'); const cs = getComputedStyle(q);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  const out = { whiteSpace: cs.whiteSpace, scrollWidth: q.scrollWidth, clientWidth: q.clientWidth, lines: Math.round(q.getBoundingClientRect().height / lh), clipped: q.scrollHeight > q.clientHeight + 1 || q.scrollWidth > q.clientWidth + 1 };
  chip.remove();
  return out;
}
