import type { Texture } from 'three';

const cache = new WeakMap<object, string>();

/** Small data-URL preview of a texture's image (cached per image). */
export function texturePreview(texture: Texture, size = 64): string | null {
  const image = texture.image as
    (CanvasImageSource & { width?: number; height?: number; data?: unknown }) | undefined;
  if (!image || !image.width || !image.height) return null;
  const cached = cache.get(image as object);
  if (cached) return cached;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (image.data) return null; // raw data textures are not previewed
    ctx.drawImage(image, 0, 0, size, size);
    const url = canvas.toDataURL('image/png');
    cache.set(image as object, url);
    return url;
  } catch {
    return null;
  }
}
