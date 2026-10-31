import type { Plugin } from 'vite';

/**
 * Adds a strict Content-Security-Policy to production builds. Everything is served from the app's own
 * origin; no remote hosts are allowed, which also guarantees models are never sent anywhere.
 * (Not applied in dev because the React refresh runtime needs an inline script.)
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

export function contentSecurityPolicy(): Plugin {
  return {
    name: 'zino3d-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}
