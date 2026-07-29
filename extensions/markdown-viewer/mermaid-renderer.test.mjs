import assert from "node:assert/strict";
import test from "node:test";
import { renderMermaidASCII } from "beautiful-mermaid";

test("renders Mermaid flowcharts locally as Unicode diagrams", () => {
  const output = renderMermaidASCII(
    "graph LR\n  A[Start] --> B[End]",
    { colorMode: "none", paddingX: 3, paddingY: 2 },
  );

  assert.match(output, /Start/);
  assert.match(output, /End/);
  assert.match(output, /►/);
});
