/**
 * Hosts the app may open in the system browser. Everything else is refused
 * with a plain explanation, so a link in imported text cannot send Tommy to
 * an arbitrary site.
 */
export const EXTERNAL_HOSTS: readonly string[] = [
  'docs.google.com',
  'drive.google.com',
  'accounts.google.com',
  'console.anthropic.com',
  'github.com',
];

export type ExternalCheck = { ok: true; url: string } | { ok: false; message: string };

export function checkExternalUrl(raw: string): ExternalCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'That link is not a valid web address.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, message: 'The app only opens secure (https) links.' };
  }
  if (url.username || url.password || url.port) {
    return { ok: false, message: 'The app does not open links with a user name or a port.' };
  }
  if (!EXTERNAL_HOSTS.includes(url.hostname)) {
    return {
      ok: false,
      message: `The app does not open links to ${url.hostname}. It opens only ${EXTERNAL_HOSTS.join(', ')}.`,
    };
  }
  return { ok: true, url: url.toString() };
}
