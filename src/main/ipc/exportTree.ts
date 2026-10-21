import { writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog } from 'electron';
import type { Request, Response } from '../../shared/ipc';

/**
 * FT-9: save the tree as a PNG (rasterized in the renderer on a canvas) at a
 * place chosen in a save dialog. A45 took the PDF export out; the export is
 * always a PNG.
 */
export async function exportTree(req: Request<'tree.export'>): Promise<Response<'tree.export'>> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: 'Export the family tree as an image',
    defaultPath: `${req.fileName}.png`,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  };
  const choice = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return { saved: false, path: null };
  const data = Buffer.from(req.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  await writeFile(choice.filePath, data);
  return { saved: true, path: choice.filePath };
}
