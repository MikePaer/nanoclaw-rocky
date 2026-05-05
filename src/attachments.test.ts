import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadAttachment } from './attachments.js';

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

function startServer(handler: http.RequestListener): Promise<void> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      } else {
        reject(new Error('Failed to obtain server address'));
      }
    });
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('downloadAttachment', () => {
  it('writes the response body to a file with extension from URL', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    const dest = await downloadAttachment(`${baseUrl}/cat.png`, tmpDir, 0);
    expect(dest).toMatch(/att-0\.png$/);
    expect(fs.readFileSync(dest)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('falls back to extension from content-type when URL has none', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('jpegdata'));
    });
    const dest = await downloadAttachment(`${baseUrl}/photo`, tmpDir, 2);
    expect(dest).toMatch(/att-2\.jpg$/);
  });

  it('rejects responses larger than the size cap (declared length)', async () => {
    await startServer((_req, res) => {
      res.setHeader('content-type', 'image/png');
      res.setHeader('content-length', String(26 * 1024 * 1024));
      res.end('x');
    });
    await expect(
      downloadAttachment(`${baseUrl}/big.png`, tmpDir, 0),
    ).rejects.toThrow(/exceeds/);
  });

  it('rejects non-2xx responses', async () => {
    await startServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    await expect(
      downloadAttachment(`${baseUrl}/missing.png`, tmpDir, 0),
    ).rejects.toThrow(/HTTP 404/);
  });
});
