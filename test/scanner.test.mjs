import assert from "node:assert/strict";
import { test } from "node:test";
import { scannerChoice } from "../src/flight.js";

const config = { ENTER: 7, EXIT: 11, DWELL: 900 };
const state = () => ({ source: "bitcoin", pinned: null, candidate: null, candidateSince: 0 });

test("a nearer emitter takes over after continuous dwell while the old source is in range", () => {
  const scanner = state();
  const near = [{ id: "talos", distance: 2 }, { id: "bitcoin", distance: 6 }];
  for (const now of [0, 200, 400, 600, 800]) assert.equal(scannerChoice(scanner, near, now, config), "bitcoin");
  assert.equal(scannerChoice(scanner, near, 1000, config), "talos");
});

test("dwell resets when the candidate ceases to be nearest", () => {
  const scanner = state();
  const near = [{ id: "talos", distance: 2 }, { id: "bitcoin", distance: 6 }];
  scannerChoice(scanner, near, 0, config);
  scannerChoice(scanner, [{ id: "bitcoin", distance: 1 }, { id: "talos", distance: 2 }], 800, config);
  assert.equal(scannerChoice(scanner, near, 1000, config), "bitcoin");
  assert.equal(scannerChoice(scanner, near, 1800, config), "bitcoin");
  assert.equal(scannerChoice(scanner, near, 1900, config), "talos");
});

test("manual selection holds through the exit band but releases out of range", () => {
  const scanner = { ...state(), pinned: "bitcoin" };
  const near = [{ id: "talos", distance: 2 }, { id: "bitcoin", distance: 10 }];
  assert.equal(scannerChoice(scanner, near, 0, config), "bitcoin");
  assert.equal(scannerChoice(scanner, near, 2000, config), "bitcoin");
  assert.equal(scannerChoice(scanner, [], 3000, config), null);
  assert.equal(scanner.pinned, null);
});

test("the first signal is acquired before a compact hop can finish", () => {
  const scanner = { ...state(), source: null };
  assert.equal(scannerChoice(scanner, [{ id: "bitcoin", distance: 6 }], 0, config), "bitcoin");
  scanner.source = "bitcoin";
  assert.equal(scannerChoice(scanner, [{ id: "talos", distance: 2 }, { id: "bitcoin", distance: 6 }], 100, config), "bitcoin");
});
