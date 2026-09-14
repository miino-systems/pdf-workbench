/** Public API of the `history/` module: append-only event log + snapshots. */

export { HistoryJournal, GENESIS_HASH } from './journal';
export type { HistoryEventInput } from './journal';

export { SnapshotStore } from './snapshots';

export { formatTs, snapshotFileName } from './timestamp';

export { EVENT_TYPES } from './eventTypes';
export type { EventType } from './eventTypes';
