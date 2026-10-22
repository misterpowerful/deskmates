import test from "node:test";
import assert from "node:assert/strict";
import { PRIMARY_VIEWS, MENU_VIEWS, isPrimaryView, isMenuView } from "../../webapp/src/composables/menuViews.js";

test("unknown, empty and non-string view names are neither primary nor menu", () => {
  for (const bad of ["", "nope", null, undefined, 42, {}, ["log"], "__proto__", "LOG"]) {
    assert.equal(isPrimaryView(bad), false);
    assert.equal(isMenuView(bad), false);
  }
});

test("no view is listed as both primary and menu", () => {
  for (const v of PRIMARY_VIEWS) assert.equal(isMenuView(v.name), false);
  for (const v of MENU_VIEWS) assert.equal(isPrimaryView(v.name), false);
});
