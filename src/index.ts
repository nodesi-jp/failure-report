export { EVIDENCE_ROOT, RUN_ID, RUN_DIR, paths, linkLatest } from './runContext';
export {
  shot,
  step,
  note,
  safeName,
  viewpoint,
  precondition,
  issue,
  details,
  reference,
  recordState,
  aroundState,
  ANNOTATION,
  type StatePhase,
} from './evidence';
export { trackTransfer, formatBytes, type TransferOptions } from './transfer';
export { default as FailureReport, type FailureReportOptions } from './reporter';
export {
  listRuns,
  readRun,
  resolveRun,
  writeIndex,
  formatDuration,
  type RunMeta,
  type RunEntry,
  type CaseRecord,
} from './site';
export { buildReport, buildShare, type ReportOptions } from './report';
export { listTests, formatCatalog, type CatalogEntry } from './catalog';
export {
  PAGE_FIELDS,
  STATUS_LABEL,
  STATUS_WORDS,
  REQUIRED_FIELDS,
  formatPageSpec,
  MCP_INSTRUCTIONS,
  type PageField,
} from './page';
export { findGaps, formatGaps, type Gap } from './lint';
export { diffState, renderStateHtml, type StateDiff } from './diff';
export {
  buildMatrix,
  classificationOf,
  groupCases,
  numberGroups,
  renderMatrixHtml,
  renderMatrixText,
  type Group,
  type Matrix,
} from './matrix';
