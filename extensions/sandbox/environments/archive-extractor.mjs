import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { x as extractTar } from "tar";

const [archivePath, destination, rawStrip] = process.argv.slice(2);
const stripComponents = Number(rawStrip);
if (
  !archivePath
  || !destination
  || !isAbsolute(archivePath)
  || !isAbsolute(destination)
  || !Number.isInteger(stripComponents)
  || stripComponents < 0
  || stripComponents > 8
) {
  throw new Error("Invalid restricted archive extraction request");
}
await access(archivePath);
await extractTar({
  file: archivePath,
  cwd: destination,
  gzip: true,
  strip: stripComponents,
  preservePaths: false,
  strict: true,
});
