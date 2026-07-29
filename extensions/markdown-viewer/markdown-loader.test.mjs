import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadMarkdownFile,
  MarkdownFileError,
  resolveMarkdownPath,
} from "./markdown-loader.ts";

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-markdown-viewer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MarkdownFileError);
    assert.equal(error.code, code);
    return true;
  });
}

test("resolves quoted paths relative to cwd", async (t) => {
  const cwd = await createFixture(t);
  const path = join(cwd, "notes with spaces.md");
  await writeFile(path, "# 你好\n");

  const file = await loadMarkdownFile('"notes with spaces.md"', cwd);

  assert.equal(file.path, path);
  assert.equal(file.content, "# 你好\n");
});

test("accepts .markdown files and strips a UTF-8 BOM", async (t) => {
  const cwd = await createFixture(t);
  await writeFile(join(cwd, "guide.markdown"), "\uFEFF# Guide");

  const file = await loadMarkdownFile("guide.markdown", cwd);

  assert.equal(file.content, "# Guide");
});

test("rejects missing paths and remote URLs", async () => {
  assert.throws(() => resolveMarkdownPath("  ", "/tmp"), { code: "empty-path" });
  assert.throws(() => resolveMarkdownPath("https://example.com/README.md", "/tmp"), {
    code: "remote-url",
  });
});

test("rejects missing files, directories, and unsupported extensions", async (t) => {
  const cwd = await createFixture(t);
  await mkdir(join(cwd, "folder.md"));
  await writeFile(join(cwd, "notes.txt"), "text");

  await expectCode(loadMarkdownFile("missing.md", cwd), "not-found");
  await expectCode(loadMarkdownFile("folder.md", cwd), "not-a-file");
  await expectCode(loadMarkdownFile("notes.txt", cwd), "unsupported-extension");
});

test("rejects files larger than the configured limit", async (t) => {
  const cwd = await createFixture(t);
  await writeFile(join(cwd, "large.md"), "12345");

  await expectCode(loadMarkdownFile("large.md", cwd, 4), "too-large");
});

test("rejects invalid UTF-8", async (t) => {
  const cwd = await createFixture(t);
  await writeFile(join(cwd, "invalid.md"), Buffer.from([0xc3, 0x28]));

  await expectCode(loadMarkdownFile("invalid.md", cwd), "invalid-encoding");
});
