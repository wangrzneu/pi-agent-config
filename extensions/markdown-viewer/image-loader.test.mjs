import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ImageLoadError,
  loadImageResource,
  resolveLocalImagePath,
} from "./image-loader.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-markdown-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("loads local raster images relative to the Markdown file", async (t) => {
  const directory = await createFixture(t);
  const documentPath = join(directory, "README.md");
  const imagePath = join(directory, "pixel.png");
  await writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG, "base64"));

  const image = await loadImageResource("./pixel.png", documentPath);

  assert.equal(image.mimeType, "image/png");
  assert.equal(image.filename, "pixel.png");
  assert.equal(image.base64, ONE_PIXEL_PNG);
});

test("loads supported base64 data images", async () => {
  const image = await loadImageResource(
    `data:image/png;base64,${ONE_PIXEL_PNG}`,
    "/tmp/README.md",
  );

  assert.equal(image.mimeType, "image/png");
  assert.equal(image.base64, ONE_PIXEL_PNG);
});

test("downloads bounded remote raster images", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(Buffer.from(ONE_PIXEL_PNG, "base64"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });

  const image = await loadImageResource(
    "https://example.com/images/pixel.png",
    "/tmp/README.md",
  );

  assert.equal(image.mimeType, "image/png");
  assert.equal(image.filename, "pixel.png");
  assert.equal(image.base64, ONE_PIXEL_PNG);
});

test("decodes local paths and rejects unsupported formats and oversized images", async (t) => {
  const directory = await createFixture(t);
  const documentPath = join(directory, "README.md");
  await writeFile(join(directory, "diagram.svg"), "<svg/>");
  await writeFile(join(directory, "large.png"), "12345");

  assert.equal(
    resolveLocalImagePath("my%20image.png#preview", documentPath),
    join(directory, "my image.png"),
  );
  await assert.rejects(
    loadImageResource("diagram.svg", documentPath),
    (error) => error instanceof ImageLoadError && /Only PNG/.test(error.message),
  );
  await assert.rejects(
    loadImageResource("large.png", documentPath, 4),
    (error) => error instanceof ImageLoadError && /too large/.test(error.message),
  );
});
