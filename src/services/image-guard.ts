import sharp from 'sharp';

/**
 * Checks that run on every photo BEFORE it reaches the OCR engines.
 *
 * Why: a tiny PNG can describe a huge picture (a "decompression bomb"): 8 KB on the wire became a
 * 1 GB working set in the offline OCR engine. Garbage that is not an image at all used to end as a
 * 500 with an internal library message. Both are the caller's mistake, so they are answered with a 4xx.
 */

const envInt = (name: string, fallback: number): number => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Largest picture accepted, in pixels (default 120 megapixels: far above any phone camera photo). */
export const maxImagePixels = (): number => envInt('MAX_IMAGE_PIXELS', 120_000_000);
/** Largest decoded photo accepted, in bytes (default 30 MB). */
export const maxImageBytes = (): number => envInt('MAX_IMAGE_BYTES', 30 * 1024 * 1024);

export class ImageInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ImageInputError';
  }
}

/** The base64 text (optionally a data: URL) as bytes; throws ImageInputError when there is nothing usable. */
export function decodeBase64Image(image: unknown): Buffer {
  if (typeof image !== 'string' || image.trim() === '') {
    throw new ImageInputError('Missing image payload (base64 string required)');
  }
  const buffer = Buffer.from(image.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (buffer.length < 64) throw new ImageInputError('The image is empty or too small to be a photo.');
  if (buffer.length > maxImageBytes()) {
    throw new ImageInputError(`The image is too large (limit ${Math.round(maxImageBytes() / 1024 / 1024)} MB).`, 413);
  }
  return buffer;
}

/** Reads only the header: fails for anything that is not a picture sharp can open, or that is absurdly large. */
export async function assertReadableImage(buffer: Buffer): Promise<{ width: number; height: number }> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(buffer, { limitInputPixels: maxImagePixels() }).metadata();
    width = meta.width;
    height = meta.height;
  } catch (err: any) {
    // sharp refuses a picture above the pixel limit while reading its header: that is "too large", not "unreadable"
    if (/pixel limit/i.test(String(err?.message))) {
      throw new ImageInputError('The picture is too large. Take the photo again at a lower resolution.', 413);
    }
    throw new ImageInputError('The file is not a readable image. Send a JPEG or PNG photo.');
  }
  if (!width || !height) throw new ImageInputError('The file is not a readable image. Send a JPEG or PNG photo.');
  if (width * height > maxImagePixels()) {
    throw new ImageInputError(`The picture is too large (${width}x${height}). Take the photo again at a lower resolution.`, 413);
  }
  return { width, height };
}

/** decode + validate in one go: what the OCR routes use. */
export async function readImageInput(image: unknown): Promise<Buffer> {
  const buffer = decodeBase64Image(image);
  await assertReadableImage(buffer);
  return buffer;
}
