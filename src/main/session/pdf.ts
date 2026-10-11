import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';

/**
 * SB-8: print a standalone page (a brief) to PDF bytes from a hidden window
 * with scripts off, the same way the family tree is printed (FT-9).
 */
export async function printHtmlToPdf(html: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'novel-companion-brief-'));
  const file = join(dir, 'brief.html');
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });
  try {
    await writeFile(file, html, 'utf8');
    await win.loadURL(pathToFileURL(file).toString());
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    return Buffer.from(pdf);
  } finally {
    win.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
