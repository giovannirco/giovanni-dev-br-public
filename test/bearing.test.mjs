import assert from "node:assert/strict";
import { test } from "node:test";
import { emitterBearing } from "../src/flight.js";

test("the scanner bearing follows the nose through yaw and wraps behind", () => {
  const body = { id: "contact", angle: Math.PI / 2, orbit: 10, radius: 1 };
  const state = { x: 0, z: 0, heading: 0 };
  const read = (heading) => emitterBearing({ ...state, heading }, body, [body]);
  assert.ok(Math.abs(read(0).bearing) < 1e-10);
  assert.equal(read(0).distance, 9);
  assert.ok(Math.abs(Math.abs(read(Math.PI).bearing) - Math.PI) < 1e-10);
  assert.ok(Math.abs(read(Math.PI / 2).bearing + Math.PI / 2) < 1e-10);
  assert.ok(Math.abs(read(-Math.PI / 2).bearing - Math.PI / 2) < 1e-10);
  assert.ok(Math.abs(read(Math.PI * 4).bearing) < 1e-10);
});

test("moon bearings include the parent position and range never goes negative", () => {
  const parent = { id: "parent", angle: 0, orbit: 10, radius: 2 };
  const moon = { id: "contact", parent: "parent", angle: Math.PI / 2, orbit: 5, radius: 1 };
  const bodies = [parent, moon];
  const contact = emitterBearing({ x: 10, z: 0, heading: 0 }, moon, bodies);
  assert.ok(Math.abs(contact.bearing) < 1e-10);
  assert.equal(contact.distance, 4);
  assert.equal(emitterBearing({ x: 10, z: 5, heading: 0 }, moon, bodies).distance, 0);
});
