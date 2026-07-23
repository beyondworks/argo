'use client';

import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import Accent from '@/components/Accent';

// 히어로(황금빛 '한 줄')와 1장 사이의 인터루드 — "설치도 한 줄" 터미널 창.
// OS별 명령은 전부 실동작 검증 경로만: linux=install.sh(정본), mac=최신 dmg 직다운+열기,
// win=고정 파일명 설치본 직다운+실행 (argo-agent Latest 자산 — 파일명 고정이라 URL 안정).
const BASE = 'https://github.com/beyondworks/argo-agent/releases/latest/download';
const OSES = [
  {
    id: 'mac',
    tab: 'MACOS',
    shell: 'argo — zsh',
    prompt: '$',
    cmd: `curl -fsSL -o /tmp/argo.dmg ${BASE}/argo-macos-apple-silicon.dmg && open /tmp/argo.dmg`,
  },
  {
    id: 'win',
    tab: 'WINDOWS',
    shell: 'argo — powershell',
    prompt: '>',
    cmd: `iwr -useb ${BASE}/argo-windows-setup.exe -OutFile "$env:TEMP\\argo-setup.exe"; & "$env:TEMP\\argo-setup.exe"`,
  },
  {
    id: 'linux',
    tab: 'LINUX',
    shell: 'argo — bash',
    prompt: '$',
    cmd: `curl -fsSL ${BASE}/install.sh | bash`,
  },
];

export default function InstallSection() {
  const { t } = useLang();
  const [osId, setOsId] = useState('mac');
  const [copied, setCopied] = useState(false);
  const os = OSES.find((o) => o.id === osId);

  async function copy() {
    try {
      await navigator.clipboard.writeText(os.cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* 클립보드 미허용 — 드래그 복사 가능하므로 조용히 무시 */ }
  }

  return (
    <section className="install-section" id="install">
      <div className="install-head">
        <span className="mono-label">{t('install.kicker')}</span>
        <span className="mono-label mono-dim">MAC · WIN · LINUX</span>
      </div>

      <div className="install-grid">
        <div className="install-copyblock">
          <p className="install-line">
            <Accent text={t('install.line')} />
          </p>
          <span className="install-note">{t(`install.note.${os.id}`)}</span>
        </div>

        {/* 터미널 창 — 모노크롬 트래픽 닷 + OS 탭 + 블링킹 커서 */}
        <div className="install-term">
          <div className="term-bar">
            <span className="term-dot" aria-hidden />
            <span className="term-dot" aria-hidden />
            <span className="term-dot" aria-hidden />
            <span className="term-tabs" role="tablist" aria-label="OS">
              {OSES.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="tab"
                  aria-selected={o.id === osId}
                  className={`term-tab${o.id === osId ? ' on' : ''}`}
                  onClick={() => { setOsId(o.id); setCopied(false); }}
                >
                  {o.tab}
                </button>
              ))}
            </span>
            <button className="install-copy" onClick={copy} type="button" aria-label={t('install.copy')}>
              {copied ? t('install.copied') : t('install.copy')}
            </button>
          </div>
          <div className="term-body">
            <span className="term-shell mono-label mono-dim">{os.shell}</span>
            <div className="term-cmdrow">
              <span className="install-prompt" aria-hidden>{os.prompt}</span>
              <code className="install-cmd">{os.cmd}</code>
              <span className="term-caret" aria-hidden />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
