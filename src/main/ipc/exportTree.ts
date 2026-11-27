import { writeFile } from 'node:fs/promises';
import type { Request, Response } from '../../shared/ipc';
import type { HostDialogs } from '../host/types';

/** A58: said when the host has no save dialog, so there is nowhere to choose. */
export const NO_SAVE_DIALOG = 'Open the desktop app to save the family tree as an image.';

/**
 * FT-9: save the tree as a PNG (rasterized in the renderer on a canvas) at a
 * place chosen in a save dialog. A45 took the PDF export out; the export is
 * always a PNG.
 */
export async function exportTree(
  req: Request<'tree.export'>,
  dialogs: HostDialogs | null,
): Promise<Response<'tree.export'>> {
  if (!dialogs) throw new Error(NO_SAVE_DIALOG);
  const path = await dialogs.saveFile({
    title: 'Export the family tree as an image',
    defaultPath: `${req.fileName}.png`,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
    onWindow: true,
  });
  if (!path) return { saved: false, path: null };
  const data = Buffer.from(req.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  await writeFile(path, data);
  return { saved: true, path };
}
