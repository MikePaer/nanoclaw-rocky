import fs from 'fs';
import path from 'path';

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;
export const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

const URL_EXT_FROM_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
};

export async function downloadAttachment(
  url: string,
  destDir: string,
  index: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ATTACHMENT_FETCH_TIMEOUT_MS,
  );
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${url}`);
    }
    const contentType = (resp.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const lengthHeader = resp.headers.get('content-length');
    const declaredLength = lengthHeader ? parseInt(lengthHeader, 10) : NaN;
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > ATTACHMENT_MAX_BYTES
    ) {
      throw new Error(
        `Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes (declared ${declaredLength})`,
      );
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new Error(`Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
    }

    let urlExt = '';
    try {
      urlExt = path.extname(new URL(url).pathname).toLowerCase();
    } catch {
      /* malformed url — fall back to content-type */
    }
    const ext = urlExt || URL_EXT_FROM_CONTENT_TYPE[contentType] || '.bin';
    const filename = `att-${index}${ext}`;
    const destPath = path.join(destDir, filename);
    fs.writeFileSync(destPath, buf);
    return destPath;
  } finally {
    clearTimeout(timer);
  }
}
