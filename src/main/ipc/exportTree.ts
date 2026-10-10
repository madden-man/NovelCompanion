import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, dialog } from 'electron';
import type { Request, Response } from '../../shared/ipc';

/** A standalone page that holds only the tree, for printing to PDF. */
function printPage(svg: string, width: number, height: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${Math.ceil(width)}px ${Math.ceil(height)}px; margin: 0; }
html, body { margin: 0; padding: 0; background: #ffffff; }
svg { display: block; width: ${width}px; height: ${height}px; }
</style></head><body>${svg}</body></html>`;
}

/**
 * FT-9: save the tree as a PNG (rasterized in the renderer on a canvas) or a
 * PDF (printed with `webContents.printToPDF` from a hidden window holding only
 * the tree), at a place chosen in a save dialog.
 */
export async function exportTree(
  req: Request<'tree.export'> & { format: 'png' | 'pdf' },
): Promise<Response<'tree.export'>> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const ext = req.format;
  const options = {
    title: ext === 'pdf' ? 'Export the family tree as a PDF' : 'Export the family tree as an image',
    defaultPath: `${req.fileName}.${ext}`,
    filters: [{ name: ext === 'pdf' ? 'PDF' : 'PNG image', extensions: [ext] }],
  };
  const choice = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return { saved: false, path: null };
  const target = choice.filePath;

  if (ext === 'png') {
    if (!req.png) throw new Error('The image was not ready. Try the export again.');
    const data = Buffer.from(req.png.replace(/^data:image\/png;base64,/, ''), 'base64');
    await writeFile(target, data);
    return { saved: true, path: target };
  }

  const dir = await mkdtemp(join(tmpdir(), 'novel-companion-tree-'));
  const file = join(dir, 'tree.html');
  const win = new BrowserWindow({
    show: false,
    width: Math.min(Math.ceil(req.width), 4000),
    height: Math.min(Math.ceil(req.height), 4000),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });
  try {
    await writeFile(file, printPage(req.svg, req.width, req.height), 'utf8');
    await win.loadURL(pathToFileURL(file).toString());
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    await writeFile(target, pdf);
    return { saved: true, path: target };
  } finally {
    win.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}
