import assert from "node:assert/strict";
import test from "node:test";
import { ScrollState } from "./scroll-state.ts";

test("clamps line movement to the available content", () => {
  const scroll = new ScrollState();
  scroll.update(10, 4);

  scroll.move(3);
  assert.equal(scroll.start, 3);
  assert.equal(scroll.end, 7);

  scroll.move(100);
  assert.equal(scroll.start, 6);
  assert.equal(scroll.end, 10);

  scroll.move(-100);
  assert.equal(scroll.start, 0);
});

test("moves by a page with one line of overlap", () => {
  const scroll = new ScrollState();
  scroll.update(20, 5);

  scroll.movePage(1);
  assert.equal(scroll.start, 4);

  scroll.movePage(-1);
  assert.equal(scroll.start, 0);
});

test("supports start, end, resize, and empty content", () => {
  const scroll = new ScrollState();
  scroll.update(12, 4);
  scroll.moveToEnd();
  assert.equal(scroll.start, 8);

  scroll.update(12, 8);
  assert.equal(scroll.start, 4);

  scroll.moveToStart();
  assert.equal(scroll.start, 0);

  scroll.update(0, 8);
  assert.equal(scroll.start, 0);
  assert.equal(scroll.end, 0);
  assert.equal(scroll.total, 0);
});
