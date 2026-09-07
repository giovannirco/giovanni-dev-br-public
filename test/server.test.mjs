import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { requestPath } from "../server.mjs";

describe("paths", () => {
  it("strips query from bitcoin routes", () => {
    assert.equal(requestPath("/api/bitcoin/tip?x=1"), "/api/bitcoin/tip");
  });
});

describe("catalog", () => {
  it("has resume plus real work bodies", async () => {
    const catalog = JSON.parse(await readFile(new URL("../data/projects.json", import.meta.url), "utf8"));
    assert.equal(catalog.person.name, "Giovanni Coutinho");
    const ids = catalog.bodies.map((b) => b.id);
    assert.ok(ids.includes("resume"));
    assert.ok(ids.includes("platform"));
    assert.ok(ids.includes("homelab"));
    assert.ok(catalog.bodies.some((b) => b.parent === "homelab"));
    for (const body of catalog.bodies) {
      if (body.parent) assert.ok(body.orbit < 12, `${body.id} moon too far`);
      else assert.ok(body.orbit < 70, `${body.id} too far`);
    }
  });
});
