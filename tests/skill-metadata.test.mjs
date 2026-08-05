import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillsRoot = join(repositoryRoot, "skills");

function findSkillFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findSkillFiles(path);
    return entry.name === "SKILL.md" ? [path] : [];
  });
}

test("pi-workflow skill carries the Python venv working constraint", () => {
  const skillPath = join(skillsRoot, "pi-workflow", "SKILL.md");
  const content = readFileSync(skillPath, "utf8");

  assert.match(content, /python3 -m venv \.venv/);
  assert.match(content, /source \.venv\/bin\/activate/);
  assert.match(content, /home-directory reads/);
});

test("every SKILL.md has required name and description frontmatter", () => {
  const skillFiles = findSkillFiles(skillsRoot);
  assert.ok(skillFiles.length > 0, "expected at least one SKILL.md");

  for (const path of skillFiles) {
    const content = readFileSync(path, "utf8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    const label = relative(repositoryRoot, path);

    assert.ok(frontmatter, `${label} must start with YAML frontmatter`);
    assert.match(frontmatter[1], /^name:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*$/m, `${label} needs a valid name`);
    assert.match(frontmatter[1], /^description:\s*\S.+$/m, `${label} needs a description`);
  }
});
