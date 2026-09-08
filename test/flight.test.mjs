import { PerspectiveCamera, Vector3 } from "three";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  achievements,
  cameraRig,
  EXPLORE_HEIGHT,
  INTRO_HEIGHT,
  OVERHEAD_HEIGHT,
  DEFAULT_FLY_CAMERA,
  nextFlyCamera,
  makeFlight,
  positionOf,
  showOrbitGuides,
  steerYaw,
  stepCollect,
  stepFlight,
  SURVEY_HEIGHT,
  unlocks,
  WORLD_LIMIT,
  nearbyEmitters,
} from "../src/flight.js";

const catalog = JSON.parse(
  readFileSync(new URL("../data/projects.json", import.meta.url)),
);
const { bodies, signals } = catalog;
const byId = Object.fromEntries(bodies.map((b) => [b.id, b]));
const planets = bodies.filter((b) => !b.parent);
const moons = bodies.filter((b) => b.parent);
const neutral = { x: 0, z: 0 };

function park(body) {
  const p = positionOf(body, bodies);
  return { x: p.x, z: p.z + body.radius + 2.6 };
}

test("homelab and at least two other planets carry honest moons", () => {
  const parents = new Set(moons.map((m) => m.parent));
  assert.ok(parents.has("homelab"));
  assert.ok(parents.has("platform"));
  assert.ok(parents.has("ai"));
  assert.ok(parents.has("bitops"));
  assert.equal(byId.bitcoin.parent, "homelab");
  assert.equal(byId.fulcrum.parent, "homelab");
  assert.equal(byId.rubinot.parent, "homelab");
  assert.equal(byId.envoy.parent, "homelab");
  assert.equal(byId.storage.parent, "homelab");
  assert.equal(byId.cnpg.parent, "homelab");
  assert.equal(byId.cilium.parent, "platform");
  assert.equal(byId.argo.parent, "platform");
  // The MCP servers are tools, so they orbit AI enablement rather than the
  // Observability planet that happened to be their first subject.
  assert.equal(byId["observe-mcp"].parent, "ai");
  assert.equal(byId["checkly-mcp"].parent, "ai");
  assert.equal(byId["skills-toolkit"].parent, "ai");
  assert.equal(byId["gpu-lab"].parent, "ai");
  for (const id of ["kubernetes", "gitops", "observe", "mcp"])
    assert.equal(byId[`bitops-${id}`].parent, "bitops");
  for (const moon of moons) {
    assert.ok(byId[moon.parent], moon.parent);
    assert.ok(moon.orbit < 12, `${moon.id} moon orbit too wide`);
  }
});

test("moons sit beside their planet, not on the same sun ring", () => {
  const home = positionOf(byId.homelab, bodies);
  const moon = positionOf(byId.bitcoin, bodies);
  const platform = positionOf(byId.platform, bodies);
  assert.ok(Math.hypot(moon.x - home.x, moon.z - home.z) < 10);
  assert.ok(Math.hypot(home.x - platform.x, home.z - platform.z) > 16);
  assert.ok(WORLD_LIMIT >= 60);
  for (const body of bodies) {
    const p = positionOf(body, bodies);
    assert.ok(Math.hypot(p.x, p.z) < WORLD_LIMIT - 1, body.id);
  }
});

test("intro camera stands with the craft among nearby bodies", () => {
  const state = makeFlight();
  const intro = cameraRig(state, "intro");
  const explore = cameraRig(state, "explore");
  const survey = cameraRig(state, "survey");
  const shipY = 1.55;
  const dist = Math.hypot(intro.x - state.x, intro.y - shipY, intro.z - state.z);
  const lookRange = Math.hypot(intro.lookX - state.x, intro.lookZ - state.z);
  const horiz = Math.hypot(intro.x - state.x, intro.z - state.z);
  const surveyPos = positionOf(byId.survey, bodies);
  const fx0 = Math.sin(state.heading),
    fz0 = Math.cos(state.heading);
  const back = (state.x - intro.x) * fx0 + (state.z - intro.z) * fz0;
  const side = -(state.z - intro.z) * fx0 + (state.x - intro.x) * fz0;
  const down =
    (intro.y - intro.lookY) /
    Math.hypot(intro.lookX - intro.x, intro.lookZ - intro.z);

  assert.equal(intro.y, INTRO_HEIGHT);

  assert.ok(dist >= 4 && dist <= 8.5, `intro distance ${dist}`);
  assert.ok(lookRange < 8, "looks through the neighborhood, not the whole chart");
  assert.ok(intro.lookY > 1 && intro.lookY < 2);
  assert.ok(horiz > intro.y * 0.9, "beside the craft, not top-down");
  assert.ok(back > 2.5 && back < 6.5, `intro is with the ship (${back})`);
  assert.ok(Math.abs(side) > 1.4 && Math.abs(side) < 3.6, "offset among bodies");
  assert.ok(down > 0.2 && down < 0.5, "crescent hull is visible at an oblique angle");
  for (const aspect of [1440 / 900, 390 / 844]) {
    const camera = new PerspectiveCamera(intro.fov, aspect, 0.1, 200);
    camera.position.set(intro.x, intro.y, intro.z);
    camera.lookAt(intro.lookX, intro.lookY, intro.lookZ);
    camera.updateMatrixWorld();
    for (const dx of [-0.82, 0.82]) for (const dz of [-0.81, 0.6]) {
      const point = new Vector3(state.x + dx * fz0 + dz * fx0, shipY, state.z - dx * fx0 + dz * fz0).project(camera);
      assert.ok(Math.abs(point.x) < 0.95, `hull inside viewport at aspect ${aspect}`);
      assert.ok(point.y > -0.45 && point.y < 0.8, "hull clears intro copy and header");
    }
  }
  assert.ok(explore.y < 2.6, "explore occupies the neighborhood, not the chart");
  assert.ok(explore.y < survey.y / 10, "explore is not survey altitude");
  assert.ok(
    Math.hypot(surveyPos.x - state.x, surveyPos.z - state.z) < 10,
    "spawn sits beside the survey array",
  );
  const toSurvey =
    (surveyPos.x - state.x) * fx0 + (surveyPos.z - state.z) * fz0;
  const toSun = -state.x * fx0 - state.z * fz0;
  assert.ok(toSurvey > 4, "spawn nose faces the nearby survey array");
  assert.ok(toSun < toSurvey, "spawn does not stare into the star");
  const lookAhead =
    (intro.lookX - intro.x) * fx0 + (intro.lookZ - intro.z) * fz0;
  assert.ok(lookAhead > 6, "intro looks along the nose into the scene");
  assert.ok(intro.fov <= explore.fov);
  const world = readFileSync(new URL("../src/world.js", import.meta.url), "utf8");
  assert.match(world, /cameraRig\(\s*state,\s*active\s*\?\s*view\s*:\s*["']intro["']\s*\)/);
  assert.doesNotMatch(world, /innerWidth\s*<\s*760[\s\S]{0,80}rig\.y/);
});

test("intro first frame hides instrument chrome until takeoff", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(html, /id="canopy-hud" hidden/);
  assert.match(html, /<footer class="cockpit"/);
  assert.match(main, /document\.body\.classList\.add\("flying"\)/);
  assert.match(main, /\$\("#canopy-hud"\)\.hidden = false/);
  assert.match(
    css,
    /body:not\(\.flying\)[\s\S]{0,80}footer\.cockpit[\s\S]{0,160}display:\s*none/,
  );
  assert.match(
    css,
    /body:not\(\.flying\)[\s\S]{0,80}\.world-caption[\s\S]{0,160}display:\s*none/,
  );
  assert.doesNotMatch(main, /\$\("#canopy-hud"\)\.hidden = false[\s\S]{0,200}classList\.add\("flying"\)/);
});

test("intro is an overlay on the world, not a copy column", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const introBlock = css.match(/^\.intro \{[^}]+\}/m)?.[0] || "";
  assert.match(introBlock, /bottom:/);
  assert.doesNotMatch(introBlock, /top:\s*24%/);
  assert.doesNotMatch(introBlock, /width:\s*440px/);
  assert.match(css, /\.intro\s*\{[^}]*max-width:\s*min\(/s);
  assert.doesNotMatch(
    css,
    /body:not\(\.flying\)\s+\.vignette\s*\{[^}]*90deg[^}]*transparent 48%/s,
  );
  assert.match(html, /id="intro"/);
  assert.match(html, /id="launch"/);
  assert.match(html, /id="intro-title"/);
});

test("explore camera flies in the plane of the bodies; survey still sees the whole chart", () => {
  const state = makeFlight();
  Object.assign(state, { x: 12, z: 18, heading: 0.4 });
  const explore = cameraRig(state, "explore");
  const survey = cameraRig(state, "survey");
  const cockpit = cameraRig(state, "cockpit");
  const fx = Math.sin(state.heading);
  const fz = Math.cos(state.heading);
  const shipY = 1.55;
  assert.ok(explore.y >= 1.35 && explore.y <= 2.4, `explore height ${explore.y}`);
  assert.equal(explore.y, EXPLORE_HEIGHT);
  assert.ok(Math.abs(explore.y - shipY) < 0.9, "explore occupies the body plane");
  const backX = state.x - explore.x;
  const backZ = state.z - explore.z;
  const back = backX * fx + backZ * fz;
  const side = -backZ * fx + backX * fz;
  assert.ok(back > 3.5 && back < 7.5, `camera sits close behind the nose (${back})`);
  assert.ok(Math.abs(side) > 1.1 && Math.abs(side) < 3.2, `offset among bodies (${side})`);
  const lookDx = explore.lookX - explore.x;
  const lookDz = explore.lookZ - explore.z;
  assert.ok(lookDx * fx + lookDz * fz > 0, "looks along heading");
  const down =
    (explore.y - explore.lookY) /
    Math.hypot(explore.lookX - explore.x, explore.lookZ - explore.z);
  assert.ok(down < 0.1, `looks in-plane through the neighborhood, not down at a tabletop (${down})`);
  assert.ok(explore.lookY > 1.15 && explore.lookY < 1.85);
  const yawed = cameraRig({ ...state, heading: state.heading + Math.PI / 2 }, "explore");
  assert.ok(Math.hypot(yawed.x - explore.x, yawed.z - explore.z) > 6);
  assert.ok(survey.y >= SURVEY_HEIGHT);
  assert.ok(survey.y > explore.y * 10);
  assert.ok(Math.hypot(survey.lookX, survey.lookZ) < 8);
  assert.ok(cockpit.y < 2.3);
  assert.ok(cockpit.lookY > 1);
  assert.ok(Math.hypot(cockpit.x - state.x, cockpit.z - state.z) < 2);
});

test("overhead is a north-up plan camera above the craft", () => {
  const state = makeFlight();
  Object.assign(state, { x: 12, z: 18, heading: 0.4 });
  const overhead = cameraRig(state, "overhead");
  const explore = cameraRig(state, "explore");
  const survey = cameraRig(state, "survey");
  const yawed = cameraRig({ ...state, heading: state.heading + Math.PI / 2 }, "overhead");
  assert.equal(overhead.y, OVERHEAD_HEIGHT);
  assert.ok(overhead.y >= 14 && overhead.y <= 20, `overhead height ${overhead.y}`);
  assert.ok(overhead.y > explore.y * 4, "plan cam sits well above the chase");
  assert.ok(overhead.y < survey.y / 4, "plan cam is not survey altitude");
  assert.ok(Math.abs(overhead.x - state.x) < 0.2, "north-up: camera stays over the ship X");
  assert.ok(overhead.z > state.z + 8, "north-up: camera sits on +Z");
  assert.ok(Math.hypot(overhead.lookX - state.x, overhead.lookZ - state.z) < 1);
  assert.ok(overhead.lookY < 1);
  assert.ok(Math.abs(yawed.x - overhead.x) < 0.2, "heading does not yaw the plan camera");
  assert.equal(showOrbitGuides("overhead"), true);
});

test("C cycles fly cameras; default and V are overhead", () => {
  assert.equal(DEFAULT_FLY_CAMERA, "overhead");
  assert.equal(nextFlyCamera("overhead"), "explore");
  assert.equal(nextFlyCamera("explore"), "cockpit");
  assert.equal(nextFlyCamera("cockpit"), "overhead");
  assert.equal(nextFlyCamera("survey"), "explore");
});

test("orbit rings stay on the survey chart and hide while flying", () => {
  assert.equal(showOrbitGuides("survey"), true);
  assert.equal(showOrbitGuides("explore"), false);
  assert.equal(showOrbitGuides("cockpit"), false);
  assert.equal(showOrbitGuides("intro"), false);
  const world = readFileSync(new URL("../src/world.js", import.meta.url), "utf8");
  assert.match(world, /orbitGuides/);
  assert.match(world, /showOrbitGuides\(/);
});

test("instrument bar hides while flying and returns in orbit or via console", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(html, /id="console-toggle"/);
  assert.match(main, /instruments-open/);
  assert.match(main, /KeyI/);
  assert.match(
    css,
    /body\.flying:not\(\.in-orbit\):not\(\.instruments-open\)[\s\S]{0,80}footer\.cockpit[\s\S]{0,160}display:\s*none/,
  );
  assert.match(
    css,
    /body\.flying:not\(\.cockpit-view\):not\(\.instruments-open\)[\s\S]{0,80}#canopy-hud[\s\S]{0,160}display:\s*none/,
  );
});

test("Nómada hull is scaled below planet and moon size", () => {
  const world = readFileSync(new URL("../src/world.js", import.meta.url), "utf8");
  const match = world.match(/SHIP_SCALE\s*=\s*([0-9.]+)/);
  assert.ok(match, "SHIP_SCALE is defined");
  const scale = Number(match[1]);
  assert.ok(scale >= 0.38 && scale <= 0.45, `SHIP_SCALE ${scale}`);
  assert.match(world, /hull\.scale\.setScalar\(\s*SHIP_SCALE\s*\)/);
});

test("moon hops are short; planet cruises still finish in seconds", () => {
  const moonHop = [byId.homelab, byId.bitcoin];
  const state = makeFlight();
  Object.assign(state, park(moonHop[0]), { target: moonHop[1].id });
  let frames = 0;
  for (; frames < 180 && !state.docked; frames++)
    stepFlight(state, neutral, bodies, 1 / 60);
  assert.equal(state.docked, "bitcoin");
  assert.ok(frames / 60 < 2.2, `moon hop ${frames / 60}s`);

  for (const from of planets.filter((b) => b.kind !== "relay"))
    for (const to of planets.filter((b) => b.kind !== "relay")) {
      if (from === to) continue;
      const trip = makeFlight();
      Object.assign(trip, park(from), { target: to.id });
      for (let i = 0; i < 480 && !trip.docked; i++)
        stepFlight(trip, neutral, bodies, 1 / 60);
      assert.equal(trip.docked, to.id, `${from.id} → ${to.id}`);
    }
});

test("every destination pair docks in under eight simulation seconds", () => {
  const destinations = bodies.filter((b) => b.kind !== "relay");
  for (const from of destinations)
    for (const to of destinations) {
      if (from === to) continue;
      const state = makeFlight();
      Object.assign(state, park(from), { target: to.id });
      for (let i = 0; i < 480 && !state.docked; i++)
        stepFlight(state, neutral, bodies, 1 / 60);
      assert.equal(state.docked, to.id, `${from.id} → ${to.id}`);
    }
});

test("A and stick-left yaw opposite of D (inverted from D-minus-A)", () => {
  assert.equal(steerYaw({ left: true, right: false, stickX: 0 }), 1);
  assert.equal(steerYaw({ left: false, right: true, stickX: 0 }), -1);
  assert.equal(steerYaw({ left: false, right: false, stickX: 0.5 }), -0.5);
  assert.equal(steerYaw({ left: true, right: false, stickX: -0.25 }), 1.25);
});

test("W thrusts along heading, A/D yaw, S brakes, Space boosts", () => {
  const alongZ = makeFlight();
  alongZ.heading = 0;
  stepFlight(alongZ, { thrust: 1 }, bodies, 1 / 60);
  assert.ok(alongZ.vz > 0.05);
  assert.ok(Math.abs(alongZ.vx) < alongZ.vz);
  const alongX = makeFlight();
  alongX.heading = Math.PI / 2;
  stepFlight(alongX, { thrust: 1 }, bodies, 1 / 60);
  assert.ok(alongX.vx > 0.05);
  assert.ok(Math.abs(alongX.vz) < alongX.vx);
  const turn = makeFlight();
  turn.heading = 0;
  stepFlight(turn, { yaw: 1 }, bodies, 0.05);
  assert.ok(turn.heading > 0.05);
  const stop = makeFlight();
  stop.vx = 12;
  stop.heading = Math.PI / 2;
  for (let i = 0; i < 60; i++)
    stepFlight(stop, { brake: true }, bodies, 1 / 60);
  assert.ok(Math.abs(stop.vx) < 0.001);
  const cruise = makeFlight();
  cruise.heading = 0;
  const boosted = makeFlight();
  boosted.heading = 0;
  stepFlight(cruise, { thrust: 1 }, bodies, 1 / 30);
  stepFlight(boosted, { thrust: 1, boost: true }, bodies, 1 / 30);
  assert.ok(boosted.vz > cruise.vz);
});

test("thrust cancels assisted flight; world boundary and sun stay playable", () => {
  const state = makeFlight();
  state.target = "scout";
  stepFlight(state, { thrust: 1 }, bodies, 1 / 60);
  assert.equal(state.target, null);
  const inward = makeFlight();
  inward.x = 0;
  inward.z = 4;
  inward.heading = Math.PI;
  for (let i = 0; i < 180; i++)
    stepFlight(inward, { thrust: 1, boost: true }, bodies, 1 / 60);
  assert.ok(Math.hypot(inward.x, inward.z) >= 2.6 - 1e-8);
  const out = makeFlight();
  out.heading = Math.PI / 4;
  for (let i = 0; i < 900; i++)
    stepFlight(out, { thrust: 1, boost: true }, bodies, 1 / 60);
  assert.ok(Math.hypot(out.x, out.z) <= WORLD_LIMIT + 1e-8);
});

test("docking holds a parking orbit instead of freezing the craft", () => {
  const state = makeFlight();
  const homelab = positionOf(byId.homelab, bodies);
  state.docked = "homelab";
  state.x = homelab.x + 4;
  state.z = homelab.z;
  stepFlight(state, { x: 1, z: 1 }, bodies, 0.05);
  assert.equal(state.docked, "homelab");
  const d = Math.hypot(state.x - homelab.x, state.z - homelab.z);
  assert.ok(d > byId.homelab.radius);
  assert.ok(d < byId.homelab.radius + 8);
  assert.ok(2 * Math.atan(byId.homelab.radius / d) < 0.6);
  assert.ok(
    Math.cos(
      state.heading - Math.atan2(homelab.x - state.x, homelab.z - state.z),
    ) > 0.99,
  );
  const x = state.x;
  stepFlight(state, { x: 1, z: 1 }, bodies, 0.05);
  assert.notEqual(state.x, x);
});

test("instruments, surveyor, and collector achievements stay honest", () => {
  assert.deepEqual(unlocks(new Set(["platform", "observe"])), {
    gitops: false,
    signal: false,
  });
  assert.deepEqual(unlocks(new Set(["platform", "homelab"])), {
    gitops: true,
    signal: false,
  });
  assert.deepEqual(unlocks(new Set(["observe", "bitcoin"])), {
    gitops: false,
    signal: true,
  });
  const a = achievements({
    visited: new Set(["survey", "platform", "cilium", "argo", "bitcoin"]),
    collected: new Set(signals.map((s) => s.id)),
    bodies,
  });
  assert.equal(a.surveyor, true);
  assert.equal(a.hopper, true);
  assert.equal(a.collector, true);
  assert.equal(a.gitops, false);
});

test("assisted flight routes around a directly obstructing sun from arbitrary starts", () => {
  for (const target of planets) {
    const p = positionOf(target, bodies),
      length = Math.hypot(p.x, p.z),
      state = makeFlight();
    Object.assign(state, {
      x: (-p.x / length) * 14,
      z: (-p.z / length) * 14,
      target: target.id,
    });
    for (let i = 0; i < 480 && !state.docked; i++)
      stepFlight(state, neutral, bodies, 1 / 60);
    assert.equal(state.docked, target.id, target.id);
  }
});

test("signal buoys collect on contact and do not invent extra catalog claims", () => {
  assert.ok(signals.length >= 6);
  const state = makeFlight();
  const first = signals[0];
  const p = positionOf(first, bodies);
  state.x = p.x;
  state.z = p.z;
  const got = stepCollect(state, signals, bodies);
  assert.equal(got.id, first.id);
  assert.ok(state.collected.has(first.id));
  assert.equal(stepCollect(state, signals, bodies), null);
});

test("the scanner ranks metric emitters by surface distance, not by centre", () => {
  const emitters = new Set(["bitcoin", "lab-grafana", "talos", "metrics"]);
  const state = makeFlight();
  const bitcoin = bodies.find((b) => b.id === "bitcoin");
  Object.assign(state, park(bitcoin));
  const near = nearbyEmitters(state, bodies, emitters);
  assert.equal(near[0].id, "bitcoin", "parked beside it, so it is the nearest signal");
  assert.ok(near[0].distance < near[1].distance);
  // Surface distance: never negative-by-centre for a body you are parked beside.
  assert.ok(near[0].distance >= 0);
  // A body with no feed is never offered, however close it is.
  assert.ok(!near.some((n) => !emitters.has(n.id)));
});

test("out of range means nothing to scan, not the least distant thing in the system", () => {
  const state = makeFlight();
  Object.assign(state, { x: 0, z: 0 });
  const emitters = new Set(["bitcoin"]);
  assert.deepEqual(nearbyEmitters(state, bodies, emitters, 0.5), []);
  assert.equal(nearbyEmitters(state, bodies, emitters, Infinity).length, 1);
});
