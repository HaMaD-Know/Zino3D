import { Capacitor } from '@capacitor/core';

/** Native-shell integration (status bar, back button, lifecycle). No-ops in the browser. */
export async function initNativeShell(handlers: {
  onBackground: () => void;
  onBack: () => boolean;
}): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => undefined;
  const cleanups: Array<() => void> = [];
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    if (Capacitor.getPlatform() === 'android') await StatusBar.setBackgroundColor({ color: '#1f2125' });
  } catch {
    // Status bar plugin unavailable: keep the default appearance.
  }
  try {
    const { App } = await import('@capacitor/app');
    const state = await App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) handlers.onBackground();
    });
    const back = await App.addListener('backButton', ({ canGoBack }) => {
      if (!handlers.onBack() && !canGoBack) void App.minimizeApp();
    });
    cleanups.push(
      () => void state.remove(),
      () => void back.remove(),
    );
  } catch {
    // App plugin unavailable
  }
  return () => cleanups.forEach((c) => c());
}
