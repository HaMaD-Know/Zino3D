import type { Texture } from 'three';

export interface EncodedImage {
  bytes: ArrayBuffer;
  mimeType: string;
  width: number;
  height: number;
}

type Drawable = CanvasImageSource & { width: number; height: number };

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  return null;
}

async function canvasToPng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<ArrayBuffer> {
  if ('convertToBlob' in canvas) return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('PNG encoding failed'))),
      'image/png',
    ),
  );
}

/**
 * Encodes a texture's image as PNG so it can be stored as a binary asset (never base64).
 * Returns null for images that cannot be drawn (e.g. float data textures).
 */
export async function encodeTextureImage(texture: Texture): Promise<EncodedImage | null> {
  const image = texture.image as unknown;
  if (!image) return null;
  const img = image as { width?: number; height?: number; data?: ArrayLike<number> };
  const width = img.width ?? 0;
  const height = img.height ?? 0;
  if (!width || !height) return null;
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  if (img.data) {
    if (
      !(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) ||
      img.data.length !== width * height * 4
    )
      return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), width, height), 0, 0);
  } else {
    try {
      ctx.drawImage(image as Drawable, 0, 0);
    } catch {
      return null;
    }
  }
  return { bytes: await canvasToPng(canvas), mimeType: 'image/png', width, height };
}

/** Decodes stored image bytes. Returns an ImageBitmap (or HTMLImageElement fallback) and its flipY handling. */
export async function decodeImage(
  bytes: ArrayBuffer,
  mimeType: string,
  flipY: boolean,
): Promise<{ image: unknown; flipY: boolean } | null> {
  const blob = new Blob([bytes], { type: mimeType });
  if (typeof createImageBitmap === 'function') {
    try {
      // ImageBitmaps ignore UNPACK_FLIP_Y in WebGL, so flipping happens at decode time instead.
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: flipY ? 'flipY' : 'from-image',
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      return { image: bitmap, flipY: false };
    } catch {
      // fall through to <img>
    }
  }
  if (typeof Image === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { image: img, flipY };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
