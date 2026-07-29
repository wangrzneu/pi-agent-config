import assert from "node:assert/strict";
import test from "node:test";
import { SearchState } from "./search-state.ts";

test("finds matches case-insensitively and cycles in both directions", () => {
  const search = new SearchState();
  search.setDraft("alpha");
  search.commit();
  search.update(["Alpha", "beta", "another ALPHA"]);

  assert.deepEqual(search.matchLines, [0, 2]);
  assert.equal(search.move(1), 0);
  assert.equal(search.move(1), 2);
  assert.equal(search.move(1), 0);
  assert.equal(search.move(-1), 2);
  assert.equal(search.position, "2/2");
});

test("starts reverse search at the last match and handles no results", () => {
  const search = new SearchState();
  search.setDraft("x");
  search.commit();
  search.update(["x", "x", "x"]);
  assert.equal(search.move(-1), 2);

  search.setDraft("missing");
  search.commit();
  search.update(["x"]);
  assert.equal(search.move(1), undefined);
  assert.equal(search.position, "0/0");
});

test("can cancel a draft without changing the committed query", () => {
  const search = new SearchState();
  search.setDraft("saved");
  search.commit();
  search.begin();
  search.setDraft("temporary");
  search.cancel();

  assert.equal(search.query, "saved");
  assert.equal(search.draft, "saved");
});
