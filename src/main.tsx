import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { log } from './utils/logging';
import './styles/tokens.css';
import './styles/global.css';
import './styles/editor.css';
import './styles/responsive.css';
import './styles/home.css';

window.addEventListener('error', (e) => log.error(`Uncaught: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log.error(`Unhandled rejection: ${String(e.reason)}`));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support: the service worker caches only the application shell (never user models).
if (
  import.meta.env.PROD &&
  'serviceWorker' in navigator &&
  window.isSecureContext &&
  !navigator.userAgent.includes('Capacitor')
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch((error) => log.warn(`Service worker registration failed: ${String(error)}`));
  });
}
