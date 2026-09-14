/** Timestamp helpers shared by the history journal and snapshot store. */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * Format a `Date` as ISO-8601 with the *local* UTC offset, seconds
 * precision, e.g. `2026-09-14T10:30:12+09:00`. UTC (`Z`) is always rendered
 * as `+00:00` rather than the `Z` shorthand.
 */
export function formatTs(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  const offsetMinutesTotal = -date.getTimezoneOffset(); // e.g. +540 for JST, 0 for UTC
  const sign = offsetMinutesTotal < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutesTotal);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offset}`;
}

/**
 * File name for a snapshot saved at `date` (local time, no separators):
 * `20260914T103012.json`.
 */
export function snapshotFileName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}.json`;
}
