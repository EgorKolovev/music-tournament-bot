// Русское согласование числительного: 1 файл, 2 файла, 5 файлов.
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Время в песне для людей: 75 → «1:15».
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// «1:15», «0:45», «75» или «1:02:03» → секунды; null — не время.
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((n) => n >= 60)) return null;
  return numbers.reduce((total, n) => total * 60 + n, 0);
}
