'use client';

import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import Accent from '@/components/Accent';

// 히어로(황금빛 '한 줄')와 1장 사이의 인터루드 — "설치도 한 줄" 터미널 창.
// 명령어는 argo-agent Latest의 install.sh 정본 (docs/selfhost.md와 동일).
const CMD = 'curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash';

export default function InstallSection() {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* 클립보드 미허용 — 드래그 복사 가능하므로 조용히 무시 */ }
  }

  return (
    <section className="install-section" id="install">
      <div className="install-head">
        <span className="mono-label">{t('install.kicker')}</span>
        <span className="mono-label mono-dim">MAC · LINUX</span>
      </div>

      <div className="install-grid">
        <div className="install-copyblock">
          <p className="install-line">
            <Accent text={t('install.line')} />
          </p>
          <span className="install-note">{t('install.note')}</span>
        </div>

        {/* 터미널 창 — 모노크롬 트래픽 닷 + 타이틀바 + 블링킹 커서 */}
        <div className="install-term">
          <div className="term-bar">
            <span className="term-dot" aria-hidden />
            <span className="term-dot" aria-hidden />
            <span className="term-dot" aria-hidden />
            <span className="term-title">argo — zsh</span>
            <button className="install-copy" onClick={copy} type="button" aria-label={t('install.copy')}>
              {copied ? t('install.copied') : t('install.copy')}
            </button>
          </div>
          <div className="term-body">
            <span className="install-prompt" aria-hidden>$</span>
            <code className="install-cmd">{CMD}</code>
            <span className="term-caret" aria-hidden />
          </div>
        </div>
      </div>
    </section>
  );
}
