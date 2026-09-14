/** Well-known `HistoryEvent.type` string constants, for callers to avoid typos. */
export const EVENT_TYPES = {
  workspaceOpened: 'workspace.opened',
  workspaceInitialized: 'workspace.initialized',
  stampEnabled: 'stamp.enabled',
  stampDisabled: 'stamp.disabled',
  stampMoved: 'stamp.moved',
  stampAdded: 'stamp.added',
  stampRemoved: 'stamp.removed',
  stampUpdated: 'stamp.updated',
  preflightRun: 'preflight.run',
  pdfGenerated: 'pdf.generated',
  snapshotSaved: 'snapshot.saved',
  fontSelected: 'font.selected',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
