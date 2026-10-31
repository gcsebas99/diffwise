import { getFileDiff } from "./get-file-diff.js";
import { listChangedFiles } from "./list-changed-files.js";
import { readFile } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import { reportFinding } from "./report-finding.js";
import { searchRepo } from "./search-repo.js";
import { submitReview } from "./submit-review.js";

// The loop (1.8) stops when this tool succeeds; exported so the name lives in one place.
export const TERMINAL_TOOL = submitReview.name;

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry([
    listChangedFiles,
    getFileDiff,
    readFile,
    searchRepo,
    reportFinding,
    submitReview,
  ]);
}
