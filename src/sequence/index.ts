/**
 * Public API of the `sequence/` module: continuous page numbering across
 * the workspace's source PDFs (`.pdf-workbench/sequence.json`).
 */
export {
  resolveSequence,
  orderFiles,
  entryFor,
  sequenceItemFor,
  describeRange,
  naturalCompare,
  compareFileNames,
  type SequenceFileInfo,
  type ResolvedSequence,
  type ResolvedSequenceItem,
  type OrderedFile,
} from './resolve';
export {
  materializeOrder,
  useNameOrder,
  moveFile,
  setFileOverrides,
  removeMissingEntries,
  removeEntry,
} from './edit';
export {
  PAGE_RANGES_BASENAME,
  PAGE_RANGE_COLUMNS,
  pageRangeRows,
  formatPageRangesTable,
  formatPageRangesJson,
  type PageRangeRow,
  type PageRangesDocument,
} from './export';
export { normalizeSequenceConfig, type NormalizedSequence } from './normalize';
export {
  importSequenceText,
  parseSequenceList,
  parseSequenceJson,
  type ImportSequenceOptions,
  type ImportedSequence,
} from './import';
