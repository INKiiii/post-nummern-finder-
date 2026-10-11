// Entfernungen lesbar formatieren.

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m / 5) * 5} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}
