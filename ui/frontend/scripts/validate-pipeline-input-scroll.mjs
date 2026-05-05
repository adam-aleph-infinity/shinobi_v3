#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, "..");

const paths = {
  pipeline: path.join(frontendRoot, "app/pipeline/page.tsx"),
  transcript: path.join(frontendRoot, "components/shared/TranscriptViewer.tsx"),
};

function count(haystack, needle) {
  if (!needle) return 0;
  let hits = 0;
  let idx = 0;
  while (idx >= 0) {
    idx = haystack.indexOf(needle, idx);
    if (idx < 0) break;
    hits += 1;
    idx += needle.length;
  }
  return hits;
}

function takeAround(source, anchor, size = 1200) {
  const at = source.indexOf(anchor);
  if (at < 0) return "";
  return source.slice(at, at + size);
}

function check(ok, name, failHint) {
  return { ok, name, failHint };
}

function printResult(result) {
  const mark = result.ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${result.name}`);
  if (!result.ok && result.failHint) {
    console.log(`       ${result.failHint}`);
  }
}

const [pipelineSrc, transcriptSrc] = await Promise.all([
  fs.readFile(paths.pipeline, "utf8"),
  fs.readFile(paths.transcript, "utf8"),
]);

const renderRawTextSlice = takeAround(
  pipelineSrc,
  "const renderRawText = (rawText: string) => (",
);

const transcriptBranchSlice = takeAround(
  pipelineSrc,
  "if (hint.includes(\"transcript\")) {",
);

const mergedTranscriptBranchSlice = takeAround(
  pipelineSrc,
  "if (hint.includes(\"merged_transcript\")) {",
);

const transcriptViewerViewportSlice = takeAround(
  transcriptSrc,
  "const viewportClass = externalScroll",
  360,
);

const checks = [
  check(
    pipelineSrc.includes("const expandedViewportClass = \"flex-1 min-h-0 max-h-full overflow-y-auto overscroll-contain nowheel\"") &&
      pipelineSrc.includes("expand\n        ? expandedViewportClass\n        : \"max-h-80 overflow-y-auto overscroll-contain nowheel\""),
    "Pipeline result viewport uses local overflow-y scroll container in expanded and compact modes",
    "Expected expanded/compact viewport class contract was not found in RenderResultContent.",
  ),
  check(
    renderRawTextSlice.includes("className={viewportClass}") &&
      renderRawTextSlice.includes("<pre className=\"w-full px-2 py-1.5 text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-words\">"),
    "Raw input view renders inside dedicated scroll viewport + pre block",
    "renderRawText is missing expected viewportClass/pre layout.",
  ),
  check(
    transcriptBranchSlice.includes("{renderRawText(text)}"),
    "Transcript preview uses deterministic raw viewport renderer",
    "Transcript branch no longer routes through renderRawText(text).",
  ),
  check(
    mergedTranscriptBranchSlice.includes("{renderRawText(text)}"),
    "Merged transcript preview uses deterministic raw viewport renderer",
    "Merged transcript branch no longer routes through renderRawText(text).",
  ),
  check(
    pipelineSrc.includes("title={selKind === \"input\" ? \"Input Data\"") &&
      pipelineSrc.includes("bodyClassName={selKind === \"input\" ? \"flex-1 min-h-0 flex flex-col\" : undefined}"),
    "Input panel reserves a full-height body so the input viewport owns scrolling",
    "Input Data properties panel no longer enforces full-height scroll ownership classes.",
  ),
  check(
    transcriptViewerViewportSlice.includes("const viewportClass = externalScroll") &&
      transcriptViewerViewportSlice.includes(": `overflow-y-auto overscroll-contain nowheel h-full min-h-0 pr-1 ${className}`") &&
      !transcriptViewerViewportSlice.includes("? `overflow-y-auto"),
    "TranscriptViewer drops internal overflow when externalScroll is true",
    "TranscriptViewer externalScroll branch changed and may reintroduce nested scrolling.",
  ),
  check(
    count(transcriptSrc, "onWheelCapture={(e) => e.stopPropagation()}") >= 3,
    "TranscriptViewer keeps wheel propagation guards on raw + bubble render modes",
    "Expected at least 3 wheel-capture guards in TranscriptViewer.",
  ),
];

checks.forEach(printResult);

const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
  console.log(`\n${failed.length} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll pipeline input scroll validation checks passed.");
