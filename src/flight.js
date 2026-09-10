export const WORLD_LIMIT = 68;
export const DOCK_MARGIN = 2.4;
export const INTRO_HEIGHT = 4.2;
export const INTRO_BACK = 6.2;
export const INTRO_SIDE = -2.2;
export const INTRO_LOOK = 0.2;
export const INTRO_LOOK_Y = 1.55;
export const EXPLORE_HEIGHT = 1.78;
export const EXPLORE_BACK = 5.1;
export const EXPLORE_SIDE = -1.7;
export const EXPLORE_LOOK = 6.4;
export const EXPLORE_LOOK_Y = 1.48;
export const OVERHEAD_HEIGHT = 16.5;
export const OVERHEAD_BACK = 12.5;
export const SURVEY_HEIGHT = 118;

export function showOrbitGuides(mode) {
  return mode === "survey" || mode === "overhead";
}

export const FLY_CAMERAS = ["overhead", "explore", "cockpit"];
export const DEFAULT_FLY_CAMERA = "overhead";

export function nextFlyCamera(current) {
  const i = FLY_CAMERAS.indexOf(current);
  const from = i < 0 ? DEFAULT_FLY_CAMERA : current;
  return FLY_CAMERAS[(FLY_CAMERAS.indexOf(from) + 1) % FLY_CAMERAS.length];
}

export function positionOf(body, bodies = []) {
  const x = Math.cos(body.angle) * body.orbit;
  const z = Math.sin(body.angle) * body.orbit;
  const y = body.altitude || 0;
  if (!body.parent) return { x, y, z };
  const parent = bodies.find((b) => b.id === body.parent);
  if (!parent) throw new Error(`Unknown parent ${body.parent} for ${body.id}`);
  const p = positionOf(parent, bodies);
  return { x: p.x + x, y: p.y + y, z: p.z + z };
}

export function steerYaw({ left = false, right = false, stickX = 0 } = {}) {
  return (left ? 1 : 0) - (right ? 1 : 0) - stickX;
}

export function makeFlight() {
  const x = 8,
    z = 9;
  return {
    x,
    z,
    vx: 0,
    vz: 0,
    heading: Math.atan2(3.28, -4.88) - 0.35,
    target: null,
    docked: null,
    nearest: null,
    distance: Infinity,
    park: 0,
    collected: new Set(),
  };
}

export function cameraRig(state, mode) {
  if (mode === "survey") {
    return {
      x: state.x * 0.04,
      y: SURVEY_HEIGHT,
      z: state.z * 0.04 + 12,
      lookX: 0,
      lookY: 0,
      lookZ: 0,
      fov: 62,
    };
  }
  if (mode === "cockpit") {
    const fx = Math.sin(state.heading),
      fz = Math.cos(state.heading);
    return {
      x: state.x,
      y: 1.72,
      z: state.z,
      lookX: state.x + fx * 9,
      lookY: 1.35,
      lookZ: state.z + fz * 9,
      fov: 62,
    };
  }
  if (mode === "overhead") {
    return {
      x: state.x,
      y: OVERHEAD_HEIGHT,
      z: state.z + OVERHEAD_BACK,
      lookX: state.x,
      lookY: 0.35,
      lookZ: state.z,
      fov: 48,
    };
  }
  const fx = Math.sin(state.heading),
    fz = Math.cos(state.heading);
  const rx = fz,
    rz = -fx;
  if (mode === "intro") {
    return {
      x: state.x - fx * INTRO_BACK + rx * INTRO_SIDE,
      y: INTRO_HEIGHT,
      z: state.z - fz * INTRO_BACK + rz * INTRO_SIDE,
      lookX: state.x + fx * INTRO_LOOK,
      lookY: INTRO_LOOK_Y,
      lookZ: state.z + fz * INTRO_LOOK,
      fov: 48,
    };
  }
  return {
    x: state.x - fx * EXPLORE_BACK + rx * EXPLORE_SIDE,
    y: EXPLORE_HEIGHT,
    z: state.z - fz * EXPLORE_BACK + rz * EXPLORE_SIDE,
    lookX: state.x + fx * EXPLORE_LOOK,
    lookY: EXPLORE_LOOK_Y,
    lookZ: state.z + fz * EXPLORE_LOOK,
    fov: 52,
  };
}

function planCourse(start, target, bodies) {
  const obstacles = [
    { x: 0, z: 0, radius: 3.3 },
    ...bodies
      .filter((b) => b.id !== target.id && !b.parent)
      .map((b) => ({ ...positionOf(b, bodies), radius: b.radius + 1.6 })),
  ];
  for (const o of obstacles)
    o.radius = Math.min(
      o.radius,
      Math.max(0.1, Math.hypot(start.x - o.x, start.z - o.z) - 0.02),
    );
  const nodes = [{ x: start.x, z: start.z }, positionOf(target, bodies)];
  for (const o of obstacles)
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      nodes.push({
        x: o.x + Math.cos(a) * (o.radius + 0.5),
        z: o.z + Math.sin(a) * (o.radius + 0.5),
      });
    }
  function clear(a, b) {
    const dx = b.x - a.x,
      dz = b.z - a.z,
      lengthSq = dx * dx + dz * dz;
    return obstacles.every((o) => {
      const t = lengthSq
        ? Math.max(
            0,
            Math.min(1, ((o.x - a.x) * dx + (o.z - a.z) * dz) / lengthSq),
          )
        : 0;
      return (
        Math.hypot(a.x + dx * t - o.x, a.z + dz * t - o.z) >= o.radius - 0.001
      );
    });
  }
  if (clear(nodes[0], nodes[1])) return [];
  const distance = nodes.map(() => Infinity),
    previous = [],
    done = new Set();
  distance[0] = 0;
  while (done.size < nodes.length) {
    let current = -1;
    for (let i = 0; i < nodes.length; i++)
      if (!done.has(i) && (current === -1 || distance[i] < distance[current]))
        current = i;
    if (current === 1 || !Number.isFinite(distance[current])) break;
    done.add(current);
    for (let i = 0; i < nodes.length; i++) {
      if (done.has(i) || !clear(nodes[current], nodes[i])) continue;
      const candidate =
        distance[current] +
        Math.hypot(
          nodes[i].x - nodes[current].x,
          nodes[i].z - nodes[current].z,
        );
      if (candidate < distance[i]) {
        distance[i] = candidate;
        previous[i] = current;
      }
    }
  }
  const route = [];
  let node = previous[1];
  while (node !== undefined && node !== 0) {
    route.unshift(nodes[node]);
    node = previous[node];
  }
  return route;
}

function related(a, b) {
  return (
    a.parent === b.id ||
    b.parent === a.id ||
    (a.parent && a.parent === b.parent)
  );
}

export function stepFlight(state, input, bodies, dt) {
  dt = Math.min(Math.max(dt, 0), 0.05);
  if (state.docked) {
    const spec = bodies.find((b) => b.id === state.docked);
    if (!spec) return;
    const p = positionOf(spec, bodies);
    state.park += dt * 0.12;
    const hold = Math.max(spec.radius * 3.4 + 2, spec.radius + 5.2);
    state.x = p.x + Math.cos(state.park) * hold;
    state.z = p.z + Math.sin(state.park) * hold;
    state.vx = state.vz = 0;
    state.heading = Math.atan2(p.x - state.x, p.z - state.z);
    state.nearest = spec.id;
    state.distance = 0;
    return;
  }
  const yaw = input.yaw ?? input.x ?? 0;
  const thrust = input.thrust ?? (input.z < -0.05 ? -input.z : 0);
  const manual = thrust > 0.05 || Math.abs(yaw) > 0.05;
  if (manual || input.brake) state.target = null;
  if (!state.target) state.courseTarget = null;
  let ix = 0,
    iz = 0;
  let speed = input.boost ? 18 : 11;
  let assisted = false;
  const target = bodies.find((b) => b.id === state.target);
  if (target) {
    const p = positionOf(target, bodies),
      dx = p.x - state.x,
      dz = p.z - state.z,
      distance = Math.hypot(dx, dz);
    if (distance <= target.radius + DOCK_MARGIN - 0.45) {
      state.courseTarget = null;
      state.docked = target.id;
      state.target = null;
      state.park = Math.atan2(state.z - p.z, state.x - p.x);
      state.vx = state.vz = 0;
      return target;
    }
    if (state.courseTarget !== target.id) {
      state.course = planCourse(state, target, bodies);
      state.courseTarget = target.id;
    }
    while (
      state.course.length &&
      Math.hypot(state.course[0].x - state.x, state.course[0].z - state.z) < 0.7
    )
      state.course.shift();
    const waypoint = state.course[0] || p;
    const wx = waypoint.x - state.x,
      wz = waypoint.z - state.z,
      wd = Math.hypot(wx, wz);
    ix = wx / Math.max(wd, 0.001);
    iz = wz / Math.max(wd, 0.001);
    const from = bodies.find((b) => b.id === state.nearest);
    const local = from && related(from, target);
    speed = local
      ? Math.min(11, Math.max(3.2, (distance - target.radius - 1) * 3.4))
      : Math.min(15, Math.max(6.5, (distance - target.radius - 1) * 2.2));
    if (state.course.length) speed = Math.min(speed, 5.5 + wd * 2.4);
    assisted = true;
  } else {
    state.heading += yaw * 2.6 * dt;
    const fx = Math.sin(state.heading),
      fz = Math.cos(state.heading);
    ix = fx * Math.min(1, Math.max(0, thrust));
    iz = fz * Math.min(1, Math.max(0, thrust));
  }
  const length = Math.hypot(ix, iz);
  if (length > 1) {
    ix /= length;
    iz /= length;
  }
  const blend = 1 - Math.exp(-(input.brake ? 18 : length > 0 ? 7 : 4) * dt);
  state.vx += ((input.brake ? 0 : ix * speed) - state.vx) * blend;
  state.vz += ((input.brake ? 0 : iz * speed) - state.vz) * blend;
  state.x += state.vx * dt;
  state.z += state.vz * dt;
  for (const body of [
    { radius: 2.6, x: 0, z: 0 },
    ...bodies.map((b) => ({
      ...positionOf(b, bodies),
      radius: b.radius + 0.7,
    })),
  ]) {
    const dx = state.x - body.x,
      dz = state.z - body.z,
      d = Math.hypot(dx, dz);
    if (d < body.radius) {
      const nx = d > 0.001 ? dx / d : 1,
        nz = d > 0.001 ? dz / d : 0;
      state.x = body.x + nx * body.radius;
      state.z = body.z + nz * body.radius;
      const inward = state.vx * nx + state.vz * nz;
      if (inward < 0) {
        state.vx -= inward * nx;
        state.vz -= inward * nz;
      }
    }
  }
  const radius = Math.hypot(state.x, state.z);
  if (radius > WORLD_LIMIT) {
    state.x *= WORLD_LIMIT / radius;
    state.z *= WORLD_LIMIT / radius;
    const outward = (state.vx * state.x + state.vz * state.z) / WORLD_LIMIT;
    if (outward > 0) {
      state.vx -= (outward * state.x) / WORLD_LIMIT;
      state.vz -= (outward * state.z) / WORLD_LIMIT;
    }
  }
  if (assisted && Math.hypot(state.vx, state.vz) > 0.2) {
    const angle = Math.atan2(state.vx, state.vz);
    const delta = Math.atan2(
      Math.sin(angle - state.heading),
      Math.cos(angle - state.heading),
    );
    state.heading += delta * (1 - Math.exp(-9 * dt));
  }
  state.nearest = null;
  state.distance = Infinity;
  for (const body of bodies) {
    const p = positionOf(body, bodies),
      d = Math.hypot(p.x - state.x, p.z - state.z) - body.radius;
    if (d < state.distance) {
      state.nearest = body.id;
      state.distance = d;
    }
  }
}

export function stepCollect(state, signals, bodies) {
  if (state.docked) return null;
  for (const signal of signals) {
    if (state.collected.has(signal.id)) continue;
    const p = positionOf(signal, bodies);
    if (Math.hypot(p.x - state.x, p.z - state.z) < 1.35) {
      state.collected.add(signal.id);
      return signal;
    }
  }
  return null;
}

export function unlocks(visited) {
  return {
    gitops: visited.has("platform") && visited.has("homelab"),
    signal: visited.has("observe") && visited.has("bitcoin"),
  };
}

export function achievements({ visited, collected, bodies = [] }) {
  // Derived from the catalog rather than a hand-kept list, which would go
  // stale on every body added.
  const moons = new Set(bodies.filter((b) => b.parent).map((b) => b.id));
  const moonVisits = [...visited].filter((id) => moons.has(id)).length;
  return {
    ...unlocks(visited),
    surveyor: visited.has("survey"),
    hopper: moonVisits >= 3,
    collector: collected.size >= 8,
  };
}

// The metric emitters within scanning range, nearest first, measured to the
// surface rather than the centre so a large planet is not always "further"
// than a small moon beside it. The scanner picks among these; the caller owns
// the hysteresis and dwell that stop two overlapping sources from flickering.
export function nearbyEmitters(state, bodies, emitters, range = Infinity, limit = 3) {
  const found = [];
  for (const body of bodies) {
    if (!emitters.has(body.id)) continue;
    const p = positionOf(body, bodies);
    const distance = Math.hypot(p.x - state.x, p.z - state.z) - body.radius;
    if (distance <= range) found.push({ id: body.id, distance });
  }
  return found.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

// Positive bearings are to starboard; zero follows the ship's nose (+z before
// yaw). Use the same world positions and surface distance as the scanner.
export function emitterBearing(state, body, bodies) {
  const p = positionOf(body, bodies);
  const relative = Math.atan2(p.x - state.x, p.z - state.z) - state.heading;
  return {
    bearing: Math.atan2(Math.sin(relative), Math.cos(relative)),
    distance: Math.max(0, Math.hypot(p.x - state.x, p.z - state.z) - body.radius),
  };
}

export function scannerChoice(state, nearby, now, { ENTER, EXIT, DWELL }) {
  const held = state.pinned || state.source;
  const holding = nearby.some(n => n.id === held && n.distance <= EXIT);
  if (state.pinned && holding) return held;
  if (!holding) state.pinned = null;
  const nearest = nearby.find(n => n.distance <= ENTER);
  if (!holding) {
    state.candidate = null;
    return nearest?.id || null;
  }
  if (!nearest || nearest.id === state.source) {
    state.candidate = null;
    return holding ? held : null;
  }
  if (state.candidate !== nearest.id) {
    state.candidate = nearest.id;
    state.candidateSince = now;
  }
  if (now - state.candidateSince >= DWELL) return nearest.id;
  return holding ? held : null;
}
