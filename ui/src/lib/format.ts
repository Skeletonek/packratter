export function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log10(n) / 3);
  const value = n / Math.pow(1000, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

// API rows carry epoch seconds.
export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
