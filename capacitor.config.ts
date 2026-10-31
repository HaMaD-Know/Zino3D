import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.zino3d.editor',
  appName: 'Zino3D',
  webDir: 'dist',
  // The app is fully bundled; no remote server URL is used (works offline).
  backgroundColor: '#16171a',
  ios: {
    contentInset: 'never',
    backgroundColor: '#16171a',
  },
  android: {
    backgroundColor: '#16171a',
    allowMixedContent: false,
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#1f2125',
    },
  },
};

export default config;
