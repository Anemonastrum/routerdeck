export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

export function formatBytes(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Number(value);
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(unitIndex > 1 ? 1 : 0)} ${units[unitIndex]}`;
}

export function formatPercent(value) {
  return value == null || Number.isNaN(Number(value)) ? '—' : `${Number(value).toFixed(0)}%`;
}

export function formatLatency(value) {
  return value == null || Number.isNaN(Number(value)) ? '—' : `${Number(value).toFixed(1)} ms`;
}

export function formatUptime(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const seconds = Number(value);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatDuration(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const seconds = Math.max(0, Number(value));
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

export function formatBitsPerSecond(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let amount = Math.max(0, Number(value));
  let unitIndex = 0;
  while (amount >= 1000 && unitIndex < units.length - 1) {
    amount /= 1000;
    unitIndex += 1;
  }
  return `${amount.toFixed(unitIndex >= 2 ? 2 : unitIndex ? 1 : 0)} ${units[unitIndex]}`;
}
