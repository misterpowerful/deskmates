import test from "node:test";
import assert from "node:assert/strict";
import { PRIMARY_VIEWS, MENU_VIEWS, isPrimaryView, isMenuView } from "../../webapp/src/composables/menuViews.js";

test("primary views are exactly Visualizer and Transcript", () => {
  assert.deepEqual(PRIMARY_VIEWS.map((v) => v.name), ["visualizer", "transcript"]);
});

test("log, turns, costs, usage, changes, changelog and memory live in the menu", () => {
  assert.deepEqual(MENU_VIEWS.map((v) => v.name), [
    "log",
    "turns",
    "costs",
    "usage",
    "changes",
    "changelog",
    "memory",
  ]);
  assert.ok(isMenuView("log"));
  assert.ok(isMenuView("memory"));
  assert.ok(isPrimaryView("transcript"));
  assert.ok(!isPrimaryView("usage"));
});
