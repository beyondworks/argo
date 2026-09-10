// Run in an existing browser with the static fixture; no account, fetch, or message mutations.
export async function verifyMobileLayout(frame) {
  const rows = [];
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  for (const [width, height, theme] of [[390, 844, 'linen-light'], [360, 740, 'linen-dark'], [360, 430, 'linen-light'], [1280, 800, 'linen-light'], [844, 390, 'linen-light'], [844, 240, 'linen-dark']]) {
    frame.style.width = `${width}px`; frame.style.height = `${height}px`;
    const doc = frame.contentDocument;
    doc.documentElement.dataset.theme = theme;
    await settle();
    const main = doc.querySelector('.msgr-main'); const dock = doc.querySelector('.msgr-dock');
    const thread = doc.querySelector('.msgr-thread'); const shell = doc.querySelector('.msgr-shell');
    const side = doc.querySelector('.msgr-side'); const mobile = width <= 720 || ((frame.dataset.coarseSimulation === 'true' || doc.defaultView.matchMedia('(pointer: coarse)').matches) && height <= 600);
    check(doc.documentElement.scrollWidth === width, `Document overflow at ${width}`);
    check(thread.scrollWidth <= thread.clientWidth, `Message content clipped at ${width}`);
    check(Math.abs(dock.getBoundingClientRect().bottom - height) <= 1, `Composer outside viewport at ${width}x${height}`);
    check(Math.abs(main.getBoundingClientRect().height - height) <= 1, `Main height incorrect at ${width}`);
    check((getComputedStyle(side).display === 'none') === mobile, `Navigation visibility incorrect at ${width}`);
    if (mobile) {
      for (const button of doc.querySelectorAll('.msgr-main button')) {
        if (!button.getClientRects().length) continue;
        const rect = button.getBoundingClientRect();
        check(rect.width >= 44 && rect.height >= 44, `Touch target under 44px at ${width}x${height}: ${button.textContent} (${rect.width}x${rect.height})`);
      }
      check(parseFloat(getComputedStyle(doc.querySelector('textarea')).fontSize) >= 16, 'Input font can trigger focus zoom');
      const saved = thread.innerHTML;
      thread.classList.add('page');
      thread.innerHTML = '<div class="msgr-settings tabs"><nav class="msgr-setnav"><button>Account</button><button>Connections</button></nav><div class="msgr-setbody"><div class="msgr-setcard">Settings</div></div></div>';
      await settle();
      const nav = thread.querySelector('.msgr-setnav').getBoundingClientRect();
      const settings = thread.querySelector('.msgr-setbody').getBoundingClientRect();
      check(settings.top >= nav.bottom, 'Settings restored a desktop sidebar on mobile');
      check(thread.scrollWidth <= thread.clientWidth, 'Settings overflow');
      thread.classList.remove('page');
      thread.innerHTML = '<div class="msgr-row"><span class="msgr-av">S</span><div class="msgr-editbox"><textarea class="msgr-input">Edit</textarea></div></div>';
      await settle();
      check(thread.scrollWidth <= thread.clientWidth, 'Message editor overflow');
      thread.innerHTML = saved;
      shell.classList.add('rail-open'); await settle();
      check(side.getBoundingClientRect().height === height, 'Drawer does not fit viewport');
      check(getComputedStyle(side).display === 'flex', 'Drawer did not open');
      shell.classList.remove('rail-open');
    } else check(side.getBoundingClientRect().width === 268, 'Desktop rail width changed');
    rows.push({ width, height, theme, passed: true });
  }
  return rows;
}


export async function verifyMobileAuthLayout(frame) {
  const doc = frame.contentDocument;
  const shell = doc.querySelector('.msgr-shell');
  shell.hidden = true; shell.style.display = 'none';
  const rows = [];
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    for (const width of [360, 390]) {
      frame.style.width = `${width}px`; frame.style.height = '844px';
      for (const mode of ['production', 'waiting', 'dev-expanded']) {
        const auth = doc.querySelector('#auth-fixture').content.firstElementChild.cloneNode(true);
        if (mode !== 'dev-expanded') auth.querySelector('.auth-dev').remove();
        if (mode === 'waiting') {
          auth.querySelector('.auth-buttons').remove();
          auth.querySelector('.msgr-wait').hidden = false;
        } else auth.querySelector('.msgr-wait').remove();
        auth.querySelector('.msgr-server').open = mode === 'dev-expanded';
        // Native font metrics differ: a larger intrinsic input size must still shrink into its grid cell.
        if (mode === 'dev-expanded') auth.querySelectorAll('input').forEach((input) => { input.size = 40; });
        doc.body.append(auth);
        try {
          await settle();
          const card = auth.querySelector('.msgr-card'); const boundary = card.getBoundingClientRect();
          if (boundary.left < 0 || boundary.right > width) throw new Error(`Auth card exceeds viewport: ${width}/${mode}`);
          for (const element of card.querySelectorAll('.body, .band, .foot, .msgr-field, input, button, summary')) {
            if (!element.getClientRects().length) continue;
            const rect = element.getBoundingClientRect();
            if (rect.left < boundary.left || rect.right > boundary.right + 1 || element.scrollWidth > element.clientWidth + 1) {
              throw new Error(`Auth content clipped: ${width}/${mode}/${element.className || element.tagName}`);
            }
          }
          rows.push({ width, mode, passed: true });
        } finally { auth.remove(); }
      }
    }
    return rows;
  } finally { shell.hidden = false; shell.style.removeProperty('display'); }
}


// Aside cannot emulate touch hardware. Exercise the coarse media branch only inside this CSS fixture;
// native rotation remains the acceptance check for the real WebView pointer/viewport combination.
export async function verifyMobileLandscapeLayout(frame) {
  const changed = [];
  for (const sheet of frame.contentDocument.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule.media?.mediaText.includes('(pointer: coarse)')) {
        changed.push([rule.media, rule.media.mediaText]);
        rule.media.mediaText = rule.media.mediaText.replaceAll('(pointer: coarse)', '(min-width: 0px)');
      }
    }
  }
  if (!changed.length) throw new Error('No touch landscape media branch to check');
  frame.dataset.coarseSimulation = 'true';
  try {
    return (await verifyMobileLayout(frame)).map((row) => ({ ...row, pointer: 'coarse media branch simulation' }));
  } finally {
    for (const [media, original] of changed) media.mediaText = original;
    delete frame.dataset.coarseSimulation;
  }
}

export async function verifyMobileVisualViewport(frame) {
  const doc = frame.contentDocument;
  const changed = [];
  frame.style.width = '844px'; frame.style.height = '390px';
  // Same coarse-predicate fixture substitution as the landscape check; layout height stays 390px.
  for (const sheet of doc.styleSheets) for (const rule of sheet.cssRules) {
    if (rule.media?.mediaText.includes('(pointer: coarse)')) {
      changed.push([rule.media, rule.media.mediaText]);
      rule.media.mediaText = rule.media.mediaText.replaceAll('(pointer: coarse)', '(min-width: 0px)');
    }
  }
  const rows = [];
  try {
    doc.body.classList.add('msgr-short-viewport');
    for (const visualHeight of [240, 160]) {
      doc.documentElement.style.setProperty('--msgr-viewport-height', `${visualHeight}px`);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const dock = doc.querySelector('.msgr-dock').getBoundingClientRect();
      const input = doc.querySelector('.msgr-composer textarea').getBoundingClientRect();
      const send = doc.querySelector('.msgr-tools .send').getBoundingClientRect();
      if (doc.documentElement.clientHeight !== 390) throw new Error('Test altered layout viewport instead of visual height');
      if (Math.abs(dock.bottom - visualHeight) > 1 || input.bottom > visualHeight || send.bottom > visualHeight || input.height < 44 || send.height < 44) throw new Error(`Composer outside reduced visual viewport: ${visualHeight}; dock=${dock.bottom}; input=${input.height}/${input.bottom}; send=${send.height}/${send.bottom}`);
      rows.push({ layout: '844x390', visualHeight, passed: true, pointer: 'coarse media branch simulation' });
    }
    return rows;
  } finally {
    doc.body.classList.remove('msgr-short-viewport');
    doc.documentElement.style.removeProperty('--msgr-viewport-height');
    for (const [media, original] of changed) media.mediaText = original;
  }
}
