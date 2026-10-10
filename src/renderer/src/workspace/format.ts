export function formatTime(v: unknown): string {
  if (typeof v !== 'string') return 'Unknown';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
