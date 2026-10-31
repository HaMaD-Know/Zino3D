/** Generates a reasonably unique, URL-safe identifier. Uses crypto.randomUUID when available. */
export function createId(prefix = ''): string {
  const c = globalThis.crypto as Crypto | undefined;
  let raw: string;
  if (c && typeof c.randomUUID === 'function') {
    raw = c.randomUUID().replace(/-/g, '');
  } else if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    raw = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    raw = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }
  return prefix ? `${prefix}_${raw.slice(0, 20)}` : raw.slice(0, 20);
}
