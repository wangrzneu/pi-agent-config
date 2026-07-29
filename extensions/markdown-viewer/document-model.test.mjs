import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownDocument } from "./document-model.ts";

test("splits standalone images and Mermaid fences while preserving Markdown", () => {
  const parsed = parseMarkdownDocument([
    "# Guide",
    "",
    "![Architecture](./architecture.png)",
    "",
    "```mermaid",
    "graph LR",
    "  A[Start] --> B[End]",
    "```",
    "",
    "Continue reading [details](details.md#usage).",
  ].join("\n"));

  assert.deepEqual(parsed.segments.map((segment) => segment.kind), [
    "markdown",
    "image",
    "markdown",
    "mermaid",
    "markdown",
  ]);
  assert.deepEqual(parsed.segments[1], {
    kind: "image",
    alt: "Architecture",
    source: "./architecture.png",
  });
  assert.equal(parsed.segments[3].source, "graph LR\n  A[Start] --> B[End]");
  assert.deepEqual(parsed.links, [{ label: "details", target: "details.md#usage" }]);
});

test("does not discover links or images inside ordinary code fences", () => {
  const parsed = parseMarkdownDocument([
    "```md",
    "![not an image](hidden.png)",
    "[not a link](hidden.md)",
    "```",
    "",
    "<https://example.com>",
  ].join("\n"));

  assert.equal(parsed.segments.length, 1);
  assert.deepEqual(parsed.links, [
    { label: "https://example.com", target: "https://example.com" },
  ]);
});

test("supports angle-bracket image paths containing spaces", () => {
  const parsed = parseMarkdownDocument("![Diagram](<images/my diagram.png>)");

  assert.deepEqual(parsed.segments, [
    {
      kind: "image",
      alt: "Diagram",
      source: "images/my diagram.png",
    },
  ]);
});

test("extracts inline and multiple images in document order", () => {
  const parsed = parseMarkdownDocument(
    "Before ![One](one.png) middle ![Two](two.webp) after",
  );

  assert.deepEqual(parsed.segments.map((segment) => segment.kind), [
    "markdown",
    "image",
    "markdown",
    "image",
    "markdown",
  ]);
  assert.equal(parsed.segments[0].text, "Before ");
  assert.equal(parsed.segments[2].text, " middle ");
  assert.equal(parsed.segments[4].text, " after");
});
