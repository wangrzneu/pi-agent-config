import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DocumentWorkspace } from "./document-workspace.ts";

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-markdown-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("lists directories first and only includes Markdown files", async (t) => {
  const directory = await createFixture(t);
  await mkdir(join(directory, "docs"));
  await writeFile(join(directory, "b.md"), "# B");
  await writeFile(join(directory, "a.markdown"), "# A");
  await writeFile(join(directory, "ignored.txt"), "ignored");

  const entries = await new DocumentWorkspace().listDirectory(directory);

  assert.deepEqual(entries.slice(1).map((entry) => [entry.kind, entry.name]), [
    ["directory", "docs"],
    ["markdown", "a.markdown"],
    ["markdown", "b.md"],
  ]);
});

test("resolves anchors, Markdown links, directories, and external URLs", async (t) => {
  const directory = await createFixture(t);
  const document = join(directory, "README.md");
  const linked = join(directory, "linked.md");
  const docs = join(directory, "docs");
  await writeFile(document, "# Home");
  await writeFile(linked, "# Linked");
  await mkdir(docs);
  const workspace = new DocumentWorkspace();

  assert.deepEqual(await workspace.resolveLink(document, "#usage"), {
    kind: "anchor",
    value: "usage",
  });
  assert.deepEqual(await workspace.resolveLink(document, "linked.md#details"), {
    kind: "document",
    path: linked,
    anchor: "details",
  });
  assert.deepEqual(await workspace.resolveLink(document, "docs"), {
    kind: "directory",
    path: docs,
  });
  assert.deepEqual(await workspace.resolveLink(document, "https://example.com"), {
    kind: "external",
    target: "https://example.com",
  });
});

test("opens a document and resolves local image resources", async (t) => {
  const directory = await createFixture(t);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await writeFile(join(directory, "pixel.png"), Buffer.from(png, "base64"));
  await writeFile(join(directory, "README.md"), "![Pixel](pixel.png)");

  const document = await new DocumentWorkspace().open("README.md", directory);

  assert.equal(document.segments[0].kind, "image");
  assert.equal(document.segments[0].resource?.mimeType, "image/png");
});

test("detects document changes without consuming a native watch handle", async (t) => {
  const directory = await createFixture(t);
  const path = join(directory, "README.md");
  await writeFile(path, "# Before");
  const workspace = new DocumentWorkspace();
  let changed = false;
  const stop = workspace.watchDocument(path, () => {
    changed = true;
  });
  t.after(stop);

  await delay(100);
  await writeFile(path, "# After\n");

  for (let attempt = 0; attempt < 6 && !changed; attempt += 1) {
    await delay(200);
  }
  assert.equal(changed, true);
});

test("bounds the number of rendered images per document", async (t) => {
  const directory = await createFixture(t);
  const dataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const images = Array.from({ length: 33 }, (_, index) => `![${index}](${dataUrl})`);
  await writeFile(join(directory, "README.md"), images.join("\n"));

  const document = await new DocumentWorkspace().open("README.md", directory);

  assert.equal(document.segments.length, 33);
  assert.match(document.segments[32].error, /Image limit exceeded/);
});
