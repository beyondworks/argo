// Tauri sets this at build time; window size and user agent are not native capabilities.
export const isMobilePlatform = ['ios', 'android'].includes(import.meta.env.TAURI_ENV_PLATFORM);
export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const isMobileNative = isMobilePlatform && inTauri();
export const isDesktopTauri = () => !isMobilePlatform && inTauri();
