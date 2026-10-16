const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];

/** Форматирует размер в человекочитаемый вид. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const formatted = unit === 0 ? String(Math.round(value)) : value.toFixed(2);
  return `${formatted} ${UNITS[unit]}`;
}

/** Форматирует скорость (байт/с). */
export function humanRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—/с';
  return `${humanBytes(bytesPerSecond)}/с`;
}

/** Форматирует длительность из секунд кратко: 45с, 2м 10с, 1ч 05м. */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total}с`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}м ${String(secs).padStart(2, '0')}с`;
  const hours = Math.floor(minutes / 60);
  return `${hours}ч ${String(minutes % 60).padStart(2, '0')}м`;
}
