import assert from "node:assert/strict";
import { test } from "node:test";
import { orbitViewport, orbitDistance } from "../src/framing.js";

test("orbit framing reserves the actual console and notes area", () => {
  const phone = orbitViewport(390, 844, [{ x: 12, y: 530, width: 366, height: 190 }]);
  assert.ok(phone.y + phone.height / 2 < 530);
  const notes = orbitViewport(390, 844, [{ x: 12, y: 337, width: 366, height: 300 }]);
  assert.ok(notes.y + notes.height / 2 < 337);
  const desktop = orbitViewport(1440, 900, [{ x: 42, y: 170, width: 450, height: 500 }, { x: 42, y: 700, width: 1356, height: 80 }]);
  assert.ok(desktop.x - desktop.width / 2 > 492);
  assert.ok(desktop.y + desktop.height / 2 < 700);
  const distance = orbitDistance(2, 62, 844, phone);
  assert.ok(orbitDistance(2, 62, 844, notes) > distance);
  assert.equal(orbitDistance(4, 62, 844, phone), distance * 2);
});
