// FrameSequence — 캔버스 스크롤 스크러빙용 프레임 로더/드로어.
// Phase 1에서는 manifest 없이 대기(poster-only), Phase 2에서 Kling→ffmpeg 프레임을
// manifest로 연결하면 컴포넌트 수정 없이 스크러빙이 켜진다 (drop-in 계약).
//
// manifest: { basePath: '/assets/hero/seq', count: 72, ext: 'webp', pad: 4, width: 1600, height: 1066 }

export class FrameSequence {
  constructor(manifest) {
    this.manifest = manifest;
    this.frames = new Array(manifest.count).fill(null);
    this.abort = new AbortController();
    this.loading = false;
  }

  frameUrl(i) {
    const { basePath, ext, pad } = this.manifest;
    return `${basePath}/frame_${String(i + 1).padStart(pad ?? 4, '0')}.${ext ?? 'webp'}`;
  }

  async loadFrame(i) {
    if (this.frames[i]) return this.frames[i];
    try {
      const res = await fetch(this.frameUrl(i), { signal: this.abort.signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      this.frames[i] = bmp;
      return bmp;
    } catch {
      return null;
    }
  }

  // 계층 프리로드: 0번 → count/12 간격 커버리지 → idle에 나머지
  async load() {
    if (this.loading) return;
    this.loading = true;
    const n = this.manifest.count;
    await this.loadFrame(0);
    const step = Math.max(1, Math.floor(n / 12));
    await Promise.all(
      Array.from({ length: Math.ceil(n / step) }, (_, k) => this.loadFrame(k * step))
    );
    const fillRest = (deadline) => {
      let i = 0;
      const tick = () => {
        while (i < n && (!deadline || deadline.timeRemaining() > 4)) {
          if (!this.frames[i]) this.loadFrame(i);
          i += 1;
        }
        if (i < n) schedule(tick);
      };
      tick();
    };
    const schedule = (fn) =>
      'requestIdleCallback' in window
        ? requestIdleCallback(fn, { timeout: 2000 })
        : setTimeout(() => fn(), 120);
    schedule(fillRest);
  }

  // 정확한 프레임이 없으면 가장 가까운 로드된 프레임 (블랭크 금지)
  nearestLoaded(index) {
    if (this.frames[index]) return this.frames[index];
    for (let d = 1; d < this.frames.length; d += 1) {
      if (this.frames[index - d]) return this.frames[index - d];
      if (this.frames[index + d]) return this.frames[index + d];
    }
    return null;
  }

  // object-fit: cover 계산으로 캔버스에 그림
  drawFrame(ctx, progress) {
    const n = this.manifest.count;
    const index = Math.min(n - 1, Math.max(0, Math.round(progress * (n - 1))));
    const frame = this.nearestLoaded(index);
    if (!frame) return false;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const scale = Math.max(cw / frame.width, ch / frame.height);
    const dw = frame.width * scale;
    const dh = frame.height * scale;
    ctx.drawImage(frame, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    return true;
  }

  dispose() {
    this.abort.abort();
    for (const f of this.frames) f?.close?.();
    this.frames = [];
  }
}
