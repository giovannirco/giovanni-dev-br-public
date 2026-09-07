import * as THREE from "three";
import { orbitViewport, orbitDistance } from "./framing.js";
import {
  cameraRig,
  makeFlight,
  nextFlyCamera,
  positionOf,
  showOrbitGuides,
  steerYaw,
  stepCollect,
  stepFlight,
  DEFAULT_FLY_CAMERA,
  DOCK_MARGIN,
  WORLD_LIMIT,
} from "./flight.js";

const TAU = Math.PI * 2;
const metal = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: 0.48,
    metalness: 0.55,
    ...extra,
  });
const light = (color, opacity = 1) =>
  new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
function mesh(parent, geometry, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function ring(parent, radius, thickness, material, tilt = Math.PI / 2) {
  const r = mesh(
    parent,
    new THREE.TorusGeometry(radius, thickness, 6, 96),
    material,
  );
  r.rotation.x = tilt;
  return r;
}
function orbitPath(radius, color, opacity) {
  const points = Array.from({ length: 192 }, (_, i) => {
    const angle = (i * TAU) / 192;
    return new THREE.Vector3(
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius,
    );
  });
  return new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
}
function rock(parent, radius, color, detail = 2, seed = 1) {
  const geo = new THREE.IcosahedronGeometry(radius, detail),
    pos = geo.attributes.position;
  const colors = [],
    c = new THREE.Color(color);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const n =
      Math.sin(x * 8 + seed) * Math.cos(y * 7 + z * 4) * 0.07 +
      Math.sin(z * 11 + x * 3) * 0.025;
    pos.setXYZ(i, x * (1 + n), y * (1 + n), z * (1 + n));
    const shade =
      0.6 + (Math.sin(x * 3 + z * 5 + seed) * Math.cos(y * 4) + 1) * 0.23;
    colors.push(c.r * shade, c.g * shade, c.b * shade);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return mesh(
    parent,
    geo,
    metal(0xffffff, {
      vertexColors: true,
      flatShading: true,
      roughness: 0.9,
      metalness: 0.15,
    }),
  );
}
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d"),
    gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,0.8)");
  gradient.addColorStop(0.18, "rgba(255,255,255,0.3)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.06)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
function glow(parent, texture, color, size) {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  s.scale.setScalar(size);
  parent.add(s);
  return s;
}

// Each moon gets its own silhouette. Before this they inherited the planet's
// form, so a planet and its moons read as one shape at four sizes.
const MOON_FORMS = {
  // Platform
  cilium: ({ rotor, r, accent, dark, pale }) => {
    const plate = mesh(rotor, new THREE.CylinderGeometry(r * 1.15, r * 1.15, r * 0.22, 6), dark);
    plate.rotation.x = 0.5;
    mesh(plate, new THREE.CylinderGeometry(r * 0.62, r * 0.62, r * 0.26, 6), accent);
    for (let i = 0; i < 6; i++) {
      const a = (i * TAU) / 6;
      mesh(plate, new THREE.BoxGeometry(r * 0.08, r * 0.3, r * 0.08), pale,
        Math.cos(a) * r * 0.92, 0, Math.sin(a) * r * 0.92);
    }
  },
  argo: ({ rotor, r, accent, pale }) => {
    mesh(rotor, new THREE.IcosahedronGeometry(r * 0.4, 0), pale);
    for (let i = 0; i < 3; i++) {
      const loop = ring(rotor, r * (0.8 + i * 0.3), 0.02, i === 1 ? pale : accent);
      loop.rotation.x = 1.1 + i * 0.5;
      loop.rotation.z = i * 0.9;
    }
  },
  // AI enablement
  "observe-mcp": ({ rotor, r, accent, dark, pale }) => {
    const prism = mesh(rotor, new THREE.CylinderGeometry(0, r * 1.05, r * 1.7, 3), dark);
    prism.rotation.z = 0.28;
    for (const sign of [-1, 1])
      mesh(rotor, new THREE.BoxGeometry(r * 2.1, 0.02, 0.02), accent, 0, sign * r * 0.35);
    mesh(rotor, new THREE.OctahedronGeometry(r * 0.22), pale, 0, r * 0.95);
  },
  "checkly-mcp": ({ rotor, r, accent, pale }) => {
    mesh(rotor, new THREE.SphereGeometry(r * 0.34, 12, 10), pale);
    for (let i = 0; i < 4; i++) {
      const pulse = ring(rotor, r * (0.6 + i * 0.32), 0.014, accent, Math.PI / 2);
      pulse.scale.y = 1 - i * 0.12;
    }
  },
  "skills-toolkit": ({ rotor, r, accent, dark, pale }) => {
    for (let i = 0; i < 5; i++) {
      const plate = mesh(rotor, new THREE.BoxGeometry(r * 1.5, r * 0.16, r * 1.05),
        i % 2 ? pale : dark, 0, (i - 2) * r * 0.24);
      plate.rotation.y = i * 0.16;
      if (i === 4) mesh(plate, new THREE.BoxGeometry(r * 1.1, 0.02, r * 0.7), accent, 0, r * 0.09);
    }
  },
  "gpu-lab": ({ rotor, r, accent, dark, pale }) => {
    const card = mesh(rotor, new THREE.BoxGeometry(r * 2, r * 0.5, r * 0.9), dark);
    for (let i = 0; i < 7; i++)
      mesh(card, new THREE.BoxGeometry(0.02, r * 0.36, r * 0.8), pale, (i - 3) * r * 0.24);
    mesh(card, new THREE.BoxGeometry(r * 0.5, r * 0.08, r * 0.5), accent, r * 0.6, r * 0.28);
  },
  // Observability
  cardinality: ({ rotor, r, accent, pale }) => {
    for (let i = 0; i < 5; i++)
      mesh(rotor, new THREE.SphereGeometry(r * (0.62 - i * 0.11), 10, 8),
        i ? pale : accent, (i - 1.4) * r * 0.78, 0, i * r * 0.16);
  },
  alloy: ({ rotor, r, accent, pale }) => {
    const knot = mesh(rotor, new THREE.TorusKnotGeometry(r * 0.7, r * 0.16, 64, 8, 2, 3), pale);
    knot.rotation.x = 0.6;
    ring(rotor, r * 1.35, 0.016, accent, 1.35);
  },
  dashboards: ({ rotor, r, accent, dark }) => {
    for (let i = 0; i < 4; i++) {
      const panel = mesh(rotor, new THREE.BoxGeometry(r * 0.82, r * 0.06, r * 0.58), dark,
        ((i % 2) - 0.5) * r * 0.95, 0, (Math.floor(i / 2) - 0.5) * r * 0.7);
      for (let bar = 0; bar < 3; bar++)
        mesh(panel, new THREE.BoxGeometry(r * 0.12, 0.02, r * (0.18 + bar * 0.1)), accent,
          (bar - 1) * r * 0.2, r * 0.04);
    }
  },
  // Homelab
  fulcrum: ({ rotor, r, accent, dark, pale }) => {
    mesh(rotor, new THREE.CylinderGeometry(r * 0.16, r * 0.16, r * 2.3, 8), pale);
    for (let i = 0; i < 4; i++)
      mesh(rotor, new THREE.CylinderGeometry(r * (1.05 - i * 0.14), r * (1.05 - i * 0.14), r * 0.09, 18),
        i % 2 ? dark : accent, 0, (i - 1.5) * r * 0.5);
  },
  "lab-grafana": ({ rotor, r, accent, dark, pale }) => {
    const dish = mesh(rotor, new THREE.SphereGeometry(r * 1.1, 16, 10, 0, TAU, 0, Math.PI / 2.4), pale);
    dish.rotation.x = -0.7;
    dish.material.side = THREE.DoubleSide;
    mesh(rotor, new THREE.CylinderGeometry(0.02, 0.02, r * 1.5, 6), dark, 0, -r * 0.5);
    mesh(rotor, new THREE.OctahedronGeometry(r * 0.2), accent, 0, r * 0.5);
  },
};

// BitOps practices are shards of the parent crystal, but each a different one.
const BITOPS_SHARDS = {
  "bitops-kubernetes": [6, 1.5],
  "bitops-gitops": [4, 1.2],
  "bitops-observe": [8, 0.9],
  "bitops-mcp": [3, 1.8],
};

function makeBody(spec, texture) {
  const group = new THREE.Group(),
    r = spec.radius,
    accent = light(spec.color),
    dark = metal("#283c46"),
    pale = metal("#bbc8bf");
  const rotor = new THREE.Group();
  group.add(rotor);
  if (spec.id === "survey") {
    mesh(rotor, new THREE.CylinderGeometry(0.18, 0.22, 1.6, 8), pale);
    mesh(rotor, new THREE.BoxGeometry(2.4, 0.12, 0.7), dark, 0, 0.2);
    mesh(rotor, new THREE.BoxGeometry(0.7, 0.12, 2.1), dark, 0, 0.2);
    for (const sign of [-1, 1]) {
      const panel = mesh(
        rotor,
        new THREE.BoxGeometry(1.6, 0.04, 0.7),
        metal("#8fb9ac", { roughness: 0.28 }),
        sign * 1.55,
        0.22,
      );
      panel.rotation.z = sign * 0.18;
      mesh(panel, new THREE.BoxGeometry(1.4, 0.01, 0.55), accent, 0, 0.03);
    }
    ring(rotor, 1.15, 0.03, accent, 0.2);
    glow(rotor, texture, spec.color, 3.4);
    const mast = mesh(
      rotor,
      new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6),
      pale,
      0,
      1.4,
    );
    mesh(mast, new THREE.OctahedronGeometry(0.12), accent, 0, 1.2);
  } else if (MOON_FORMS[spec.id]) {
    MOON_FORMS[spec.id]({ rotor, r, spec, accent, dark, pale, texture });
    glow(rotor, texture, spec.color, 2.1);
  } else if (spec.id === "resume") {
    ring(rotor, r, 0.18, pale, 0.65);
    ring(rotor, r, 0.035, accent, 0.65).scale.setScalar(1.16);
    mesh(rotor, new THREE.OctahedronGeometry(0.46), accent);
    for (let i = 0; i < 3; i++) {
      const a = (i * TAU) / 3,
        arm = new THREE.Group();
      arm.rotation.z = a;
      rotor.add(arm);
      mesh(arm, new THREE.BoxGeometry(0.2, 1.4, 0.2), dark, 0, 0.7);
      mesh(arm, new THREE.BoxGeometry(0.65, 0.32, 0.5), pale, 0, 1.35);
    }
  } else if (spec.parent === "resume") {
    mesh(rotor, new THREE.OctahedronGeometry(r * 0.48), accent);
    if (spec.id === "production-ops") {
      for (let i = 0; i < 3; i++) {
        const rack = mesh(
          rotor,
          new THREE.BoxGeometry(r * 0.55, r * 1.5, r * 0.6),
          dark,
          (i - 1) * r * 0.7,
        );
        for (let slot = 0; slot < 4; slot++)
          mesh(
            rack,
            new THREE.BoxGeometry(r * 0.4, 0.025, 0.02),
            accent,
            0,
            (slot - 1.5) * r * 0.28,
            r * 0.31,
          );
      }
      ring(rotor, r * 1.7, 0.025, pale);
    } else if (spec.id === "incident-response") {
      mesh(
        rotor,
        new THREE.CylinderGeometry(r * 0.1, r * 0.18, r * 2.8, 8),
        pale,
      );
      for (let i = 0; i < 3; i++) {
        const wave = ring(rotor, r * (0.7 + i * 0.35), 0.025, accent);
        wave.position.y = (i - 1) * r * 0.5;
      }
    } else if (spec.id === "ai-enablement") {
      for (let i = 0; i < 3; i++) {
        const loop = ring(rotor, r * 1.4, 0.035, pale, (i * Math.PI) / 3);
        loop.rotation.y = (i * Math.PI) / 3;
        mesh(loop, new THREE.OctahedronGeometry(r * 0.22), accent, r * 1.4);
      }
    } else {
      for (const sign of [-1, 1]) {
        const arm = mesh(
          rotor,
          new THREE.BoxGeometry(r * 0.25, r * 2.3, r * 0.4),
          pale,
          sign * r * 0.8,
        );
        arm.rotation.z = sign * -0.35;
        mesh(
          arm,
          new THREE.BoxGeometry(r * 0.8, r * 0.2, r * 0.4),
          accent,
          -sign * r * 0.25,
          r,
        );
      }
      ring(rotor, r * 1.65, 0.025, accent, 0.35);
    }
    glow(rotor, texture, spec.color, r * 3);
  } else if (
    spec.id === "platform" ||
    spec.id === "cilium" ||
    spec.id === "argo"
  ) {
    rock(
      rotor,
      r,
      spec.id === "platform" ? "#517d70" : spec.color,
      spec.parent ? 1 : 2,
    );
    ring(rotor, r * 1.35, spec.parent ? 0.04 : 0.07, pale, 0.4);
    if (!spec.parent) {
      for (let i = 0; i < 6; i++) {
        const a = (i * TAU) / 6,
          node = mesh(
            rotor,
            new THREE.BoxGeometry(0.4, 0.32, 0.45),
            dark,
            Math.cos(a) * r * 1.5,
            0,
            Math.sin(a) * r * 1.5,
          );
        mesh(node, new THREE.BoxGeometry(0.28, 0.04, 0.3), accent, 0, 0.18);
        node.rotation.y = -a;
      }
      ring(rotor, r * 1.52, 0.012, accent);
    }
  } else if (spec.id === "ai" || spec.parent === "ai") {
    // A lattice: a core wrapped in nested cages, one cage per orbiting tool.
    const core = mesh(
      rotor,
      new THREE.IcosahedronGeometry(r * 0.58, 1),
      metal("#6b53a8", { flatShading: true }),
    );
    core.scale.set(1, 1.1, 1);
    for (let i = 0; i < (spec.parent ? 2 : 4); i++) {
      const cage = ring(rotor, r * (0.95 + i * 0.22), 0.022, i % 2 ? pale : accent);
      cage.rotation.x = 0.42 + i * 0.55;
      cage.rotation.y = i * 0.78;
    }
    if (!spec.parent)
      for (let i = 0; i < 6; i++) {
        const a = (i * TAU) / 6;
        mesh(
          rotor,
          new THREE.TetrahedronGeometry(0.22),
          light("#d7c6f7"),
          Math.cos(a) * r * 1.5,
          Math.sin(a * 2) * 0.35,
          Math.sin(a) * r * 1.5,
        );
      }
    glow(rotor, texture, spec.color, spec.parent ? 2.3 : 4.2);
  } else if (BITOPS_SHARDS[spec.id]) {
    // Shards of the parent crystal, a different cut for each practice.
    const [faces, stretch] = BITOPS_SHARDS[spec.id];
    const shard = mesh(
      rotor,
      new THREE.CylinderGeometry(0, r * 1.05, r * 1.9, faces),
      metal("#dadcc7", { flatShading: true }),
    );
    shard.scale.y = stretch;
    shard.rotation.z = 0.2 * stretch;
    ring(rotor, r * 1.5, 0.02, accent, 0.9 + stretch * 0.2);
  } else if (spec.id === "envoy" || spec.id === "storage" || spec.id === "cnpg") {
    rock(rotor, r * 0.82, spec.color, 1, spec.orbit * 7);
    if (spec.id === "envoy")
      for (const sign of [-1, 1]) {
        const vane = mesh(
          rotor,
          new THREE.BoxGeometry(0.08, 0.62, 1.05),
          dark,
          sign * r * 1.05,
        );
        mesh(vane, new THREE.BoxGeometry(0.02, 0.5, 0.9), accent, sign * 0.05);
      }
    if (spec.id === "storage")
      for (let i = 0; i < 3; i++)
        mesh(
          rotor,
          new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.16, 12),
          i % 2 ? pale : metal("#8a5f3c"),
          0,
          i * 0.26 - 0.26,
        );
    if (spec.id === "cnpg")
      for (let i = 0; i < 3; i++)
        mesh(
          rotor,
          new THREE.CylinderGeometry(r * 0.5, r * 0.5, 0.42, 14),
          metal("#b8794a"),
          0,
          i * 0.44 - 0.44,
        );
    ring(rotor, r * 1.5, 0.022, accent, 0.6);
  } else if (spec.id === "observe" || spec.parent === "observe") {
    mesh(
      rotor,
      new THREE.IcosahedronGeometry(r * 0.67, 1),
      metal("#457e9c", { flatShading: true }),
    );
    for (let i = 0; i < (spec.parent ? 1 : 3); i++) {
      const loop = ring(
        rotor,
        r * (1 + i * 0.25),
        0.028,
        i === 1 ? pale : accent,
        i * 0.72 + 0.4,
      );
      loop.rotation.y = i * 0.65;
    }
    mesh(
      rotor,
      new THREE.CylinderGeometry(0.05, 0.1, spec.parent ? 1.6 : 3.7, 6),
      pale,
    );
    glow(rotor, texture, spec.color, spec.parent ? 2.2 : 4);
  } else if (spec.id === "homelab") {
    rock(rotor, r, spec.color, 2, 5);
    for (let i = 0; i < 5; i++) {
      const a = i * 1.3,
        tower = mesh(
          rotor,
          new THREE.BoxGeometry(0.35, 0.5 + i * 0.08, 0.4),
          dark,
          Math.cos(a) * 0.8,
          r * 0.88,
          Math.sin(a) * 0.8,
        );
      for (let j = 0; j < 3; j++)
        mesh(
          tower,
          new THREE.BoxGeometry(0.25, 0.025, 0.42),
          accent,
          0,
          j * 0.12 - 0.1,
        );
    }
    ring(rotor, r * 1.35, 0.035, metal("#bc8759"), 1.85);
  } else if (spec.id === "bitops") {
    const core = mesh(
      rotor,
      new THREE.OctahedronGeometry(r),
      metal("#dadcc7", { flatShading: true }),
    );
    core.scale.y = 1.55;
    ring(rotor, r * 1.5, 0.03, accent);
    for (let i = 0; i < 3; i++) {
      const a = (i * TAU) / 3;
      mesh(
        rotor,
        new THREE.OctahedronGeometry(0.3),
        pale,
        Math.cos(a) * 1.8,
        0,
        Math.sin(a) * 1.8,
      );
    }
  } else if (spec.id === "rubinot") {
    mesh(rotor, new THREE.IcosahedronGeometry(r * 0.75, 1), light("#d97c3a"));
    rock(rotor, r, "#a98147", 1, 8);
    ring(rotor, r * 1.9, 0.012, accent, 1.25);
  } else if (spec.id === "scout") {
    mesh(
      rotor,
      new THREE.OctahedronGeometry(r * 0.7),
      metal("#9381b4"),
    ).scale.y = 2;
    mesh(rotor, new THREE.CylinderGeometry(0.035, 0.07, 3.7, 6), pale);
    for (const sign of [-1, 1]) {
      const panel = mesh(
        rotor,
        new THREE.BoxGeometry(1.25, 0.09, 0.85),
        dark,
        sign * 1.25,
      );
      for (let i = 0; i < 4; i++)
        mesh(
          panel,
          new THREE.BoxGeometry(0.025, 0.015, 0.8),
          accent,
          -0.48 + i * 0.3,
          0.055,
        );
    }
    ring(rotor, r * 1.6, 0.025, accent, 0.3);
  } else if (spec.id === "bitcoin" || spec.id === "fulcrum") {
    for (let i = 0; i < 3; i++) {
      const block = mesh(
        rotor,
        new THREE.BoxGeometry(spec.radius * 1.4, 0.38, spec.radius * 1.4),
        metal("#986c31"),
        0,
        i * 0.42 - 0.4,
      );
      block.rotation.y = i * 0.25;
    }
    ring(rotor, r * 1.6, 0.025, accent);
    glow(rotor, texture, spec.color, 2.6);
  } else {
    rock(rotor, r, spec.color, 1, spec.orbit * 10);
    ring(rotor, r * 1.45, 0.03, accent, 0.7);
    glow(rotor, texture, spec.color, 2.1);
  }
  const pad = ring(group, r + 0.85, 0.016, light(spec.color, 0.28));
  pad.position.y = -0.9;
  const atmo = glow(group, texture, spec.color, r * (spec.parent ? 3.2 : 4.8));
  atmo.material.opacity = spec.parent ? 0.45 : 0.7;
  return { group, rotor, pad };
}

export const SHIP_SCALE = 0.42;

function makeShip(texture) {
  const ship = new THREE.Group(),
    hull = new THREE.Group(),
    interior = new THREE.Group();
  ship.add(hull);
  ship.add(interior);
  hull.layers.set(1);
  interior.layers.set(2);
  const shell = metal("#9daea4", { roughness: 0.32, metalness: 0.72 }),
    dark = metal("#193b40"),
    seam = light("#a7f5d7");
  const core = mesh(hull, new THREE.SphereGeometry(0.48, 16, 12), dark);
  core.scale.set(0.8, 0.55, 1.9);
  core.layers.set(1);
  const canopy = mesh(
    hull,
    new THREE.SphereGeometry(0.34, 16, 12),
    metal("#68cbbb", {
      emissive: "#1d7568",
      emissiveIntensity: 0.8,
      roughness: 0.18,
    }),
    0,
    0.18,
    0.25,
  );
  canopy.scale.set(0.75, 0.65, 1.6);
  canopy.layers.set(1);
  for (const sign of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(0.18, -0.65);
    shape.bezierCurveTo(0.65, -1.25, 1.85, -0.55, 1.52, 1.25);
    shape.bezierCurveTo(1.1, 0.5, 0.65, 0.55, 0.18, -0.65);
    const wing = mesh(
      hull,
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.12,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.09,
        bevelThickness: 0.07,
        curveSegments: 16,
      }),
      shell,
    );
    wing.rotation.x = Math.PI / 2;
    wing.scale.x = sign;
    wing.layers.set(1);
    const tendon = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sign * 0.3, 0.1, -0.75),
      new THREE.Vector3(sign * 1.1, 0.12, -0.6),
      new THREE.Vector3(sign * 1.48, 0.07, 0.5),
    ]);
    mesh(
      hull,
      new THREE.TubeGeometry(tendon, 20, 0.022, 5, false),
      seam,
    ).layers.set(1);
    mesh(
      hull,
      new THREE.SphereGeometry(0.12, 10, 8),
      seam,
      sign * 0.67,
      0,
      -0.7,
    ).layers.set(1);
  }
  const tail = mesh(
    hull,
    new THREE.ConeGeometry(0.19, 1.6, 5),
    shell,
    0,
    0.05,
    -1.05,
  );
  tail.rotation.x = -Math.PI / 2;
  tail.layers.set(1);
  const drive = new THREE.Group();
  hull.add(drive);
  drive.position.set(0, 0, -1.25);
  drive.layers.set(1);
  const exhaust = glow(drive, texture, "#79f8d2", 2.2);
  hull.scale.setScalar(SHIP_SCALE);
  return { ship, hull, interior, exhaust };
}

function makeCockpit(camera) {
  const cockpit = new THREE.Group();
  camera.add(cockpit);
  const shell = new THREE.MeshBasicMaterial({
    color: "#14252a",
    side: THREE.DoubleSide,
  });
  const trim = new THREE.MeshBasicMaterial({
    color: "#80b7a5",
    transparent: true,
    opacity: 0.48,
  });
  for (const sign of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sign * 1.07, -0.82, -1.3),
      new THREE.Vector3(sign * 0.9, 0.03, -1.3),
      new THREE.Vector3(sign * 0.72, 0.63, -1.3),
      new THREE.Vector3(sign * 0.44, 1.08, -1.3),
    ]);
    mesh(cockpit, new THREE.TubeGeometry(curve, 32, 0.027, 6, false), shell);
    const rim = new THREE.CatmullRomCurve3(
      curve.points.map(
        (p) => new THREE.Vector3(p.x - sign * 0.03, p.y, p.z + 0.002),
      ),
    );
    mesh(cockpit, new THREE.TubeGeometry(rim, 32, 0.0025, 4, false), trim);
    const rail = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sign * 1.12, -0.67, -1.3),
      new THREE.Vector3(sign * 0.63, -0.61, -1.3),
      new THREE.Vector3(sign * 0.23, -0.77, -1.3),
    ]);
    mesh(cockpit, new THREE.TubeGeometry(rail, 24, 0.018, 6, false), shell);
  }
  const brow = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-1.1, 0.93, -1.3),
    new THREE.Vector3(0, 0.83, -1.3),
    new THREE.Vector3(1.1, 0.93, -1.3),
  ]);
  mesh(cockpit, new THREE.TubeGeometry(brow, 32, 0.025, 6, false), shell);
  mesh(cockpit, new THREE.BoxGeometry(2.3, 0.4, 0.08), shell, 0, -1.03, -1.3);
  cockpit.traverse((o) => {
    if (o.isMesh) {
      o.material.depthTest = false;
      o.material.depthWrite = false;
      o.renderOrder = 10;
    }
  });
  return cockpit;
}

function makeBuoy(texture, color) {
  const g = new THREE.Group();
  mesh(
    g,
    new THREE.OctahedronGeometry(0.22),
    metal(color, { emissive: color, emissiveIntensity: 0.35 }),
  );
  ring(g, 0.38, 0.018, light(color, 0.7), 0.4);
  glow(g, texture, color, 1.6);
  return g;
}

export function createWorld(canvas, catalog, callbacks) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let low = matchMedia("(pointer: coarse)").matches;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !low,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, low ? 1 : 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.28;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#070d14");
  scene.fog = new THREE.FogExp2("#070d14", 0.0085);
  const camera = new THREE.PerspectiveCamera(
    48,
    innerWidth / innerHeight,
    0.08,
    600,
  );
  camera.layers.enable(1);
  scene.add(camera);
  const cockpit = makeCockpit(camera);
  const texture = glowTexture();
  scene.add(new THREE.HemisphereLight("#c5d6e2", "#344b59", 1.45));
  const keyLight = new THREE.DirectionalLight("#c5e3e7", 1.8);
  keyLight.position.set(-12, 20, 9);
  scene.add(keyLight);
  const sunLight = new THREE.PointLight("#ffc578", 120, 90, 1.35);
  sunLight.position.y = 2;
  scene.add(sunLight);
  const warm = new THREE.DirectionalLight("#e4a16b", 0.95);
  warm.position.set(18, 6, -12);
  scene.add(warm);
  const cabinFill = new THREE.DirectionalLight("#b9d5e4", 0.65);
  cabinFill.position.set(-3, 4, 2);
  cabinFill.target.position.set(0, 0, -1);
  camera.add(cabinFill, cabinFill.target);

  const sun = new THREE.Group();
  sun.position.y = 0.6;
  scene.add(sun);
  const sunMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: `varying vec3 v; void main(){v=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec3 v; uniform float time; void main(){float n=sin(v.x*13.+sin(v.z*11.+time*.3)*2.)*sin(v.y*14.+cos(v.x*7.)*3.);float band=sin(v.y*22.+n*2.+time*.15);vec3 c=mix(vec3(.67,.25,.065),vec3(1.,.79,.38),.6+n*.2+band*.16);gl_FragColor=vec4(c,1.);}`,
  });
  mesh(sun, new THREE.SphereGeometry(2, 40, 32), sunMat);
  glow(sun, texture, "#ffc36e", 15);
  const haze = glow(scene, texture, "#274f65", 80);
  haze.position.set(8, -12, -8);
  haze.material.opacity = 0.22;
  ring(sun, 2.65, 0.025, light("#daaa65", 0.6), 0.6).rotation.y = 0.5;
  ring(sun, 3.05, 0.02, light("#daaa65", 0.35), 1.9).rotation.y = -0.3;
  const sunHoop = ring(sun, 2.85, 0.012, light("#ffde94", 0.55));

  const orbitGuides = [];
  const addOrbitGuide = (object) => {
    object.visible = false;
    scene.add(object);
    orbitGuides.push(object);
    return object;
  };
  const bodies = catalog.bodies.map((spec) => {
    const body = makeBody(spec, texture),
      p = positionOf(spec, catalog.bodies);
    body.group.position.set(p.x, 0.45 + (spec.altitude || 0), p.z);
    scene.add(body.group);
    if (!spec.parent) {
      const orbit = orbitPath(spec.orbit, spec.color, 0.3);
      orbit.position.y = -0.7;
      addOrbitGuide(orbit);
      const points = Array.from({ length: 36 }, (_, i) => {
        const a = spec.angle - 0.28 + i / 110;
        return new THREE.Vector3(
          Math.cos(a) * spec.orbit,
          -0.68,
          Math.sin(a) * spec.orbit,
        );
      });
      addOrbitGuide(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({
            color: spec.color,
            transparent: true,
            opacity: 0.3,
          }),
        ),
      );
    } else {
      const parent = catalog.bodies.find((b) => b.id === spec.parent);
      const moonRing = orbitPath(spec.orbit, spec.color, 0.23);
      addOrbitGuide(moonRing);
      body.moonRing = moonRing;
      body.parentSpec = parent;
    }
    return { ...body, spec };
  });

  const ticks = [];
  for (let i = 0; i < 96; i++) {
    const a = (i * TAU) / 96;
    const r = WORLD_LIMIT - 1.2;
    ticks.push(
      new THREE.Vector3(Math.cos(a) * r, -0.72, Math.sin(a) * r),
      new THREE.Vector3(
        Math.cos(a) * (r + 0.55),
        -0.72,
        Math.sin(a) * (r + 0.55),
      ),
    );
  }
  addOrbitGuide(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(ticks),
      new THREE.LineBasicMaterial({
        color: "#6f8b86",
        transparent: true,
        opacity: 0.16,
      }),
    ),
  );
  const positions = new Float32Array(900 * 3);
  let seed = 73;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < positions.length; i += 3) {
    const a = random() * TAU,
      b = Math.acos(2 * random() - 1),
      rad = 40 + random() * 110;
    positions[i] = Math.sin(b) * Math.cos(a) * rad;
    positions[i + 1] = Math.cos(b) * rad * 0.55;
    positions[i + 2] = Math.sin(b) * Math.sin(a) * rad;
  }
  const starsGeo = new THREE.BufferGeometry();
  starsGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(
    starsGeo,
    new THREE.PointsMaterial({
      color: "#b7c6c4",
      size: 0.09,
      transparent: true,
      opacity: 0.62,
    }),
  );
  scene.add(stars);
  const dustGeo = new THREE.IcosahedronGeometry(0.13, 0),
    dust = new THREE.InstancedMesh(
      dustGeo,
      metal("#617176", { flatShading: true }),
      220,
    ),
    dummy = new THREE.Object3D();
  for (let i = 0; i < 220; i++) {
    const a = random() * TAU,
      r = 52 + random() * 10;
    dummy.position.set(
      Math.cos(a) * r,
      -0.25 + random() * 1.4,
      Math.sin(a) * r,
    );
    dummy.rotation.set(random() * 3, random() * 3, random() * 3);
    dummy.scale.setScalar(0.28 + random());
    dummy.updateMatrix();
    dust.setMatrixAt(i, dummy.matrix);
  }
  scene.add(dust);

  const buoys = (catalog.signals || []).map((spec) => {
    const obj = makeBuoy(texture, "#8ee0c4");
    const p = positionOf(spec, catalog.bodies);
    obj.position.set(p.x, 0.9, p.z);
    scene.add(obj);
    return { spec, obj };
  });

  const craft = makeShip(texture);
  scene.add(craft.ship);
  const state = makeFlight(),
    keys = new Set(),
    stick = { x: 0, z: 0 };
  const aim = new THREE.Vector3(),
    cameraGoal = new THREE.Vector3(),
    projection = new THREE.Vector3();
  let active = false,
    paused = false,
    stopped = false,
    brake = false,
    boostHeld = false,
    lensOn = false,
    frames = 0,
    elapsed = 0,
    sampled = false,
    pendingDock = null,
    view = "explore",
    flyCamera = DEFAULT_FLY_CAMERA,
    viewBlend = 1;
  const routeLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]),
    new THREE.LineDashedMaterial({
      color: "#9ed6be",
      dashSize: 0.3,
      gapSize: 0.23,
      transparent: true,
      opacity: 0.5,
    }),
  );
  scene.add(routeLine);
  const lens = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]),
    new THREE.LineDashedMaterial({
      color: "#92dac1",
      dashSize: 0.3,
      gapSize: 0.18,
      transparent: true,
      opacity: 0.7,
    }),
  );
  lens.visible = false;
  scene.add(lens);

  const editable = (e) =>
    e.target.closest("input, select, textarea, dialog") ||
    (e.code === "Space" && e.target.closest("button, a"));
  window.addEventListener("keydown", (e) => {
    if (!active || paused || editable(e)) return;
    if (
      [
        "KeyW",
        "KeyA",
        "KeyS",
        "KeyD",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
        "ShiftLeft",
        "ShiftRight",
      ].includes(e.code)
    ) {
      e.preventDefault();
      keys.add(e.code);
    }
    if (e.code === "KeyE" && active) dock();
    if (e.code === "Space" && active && !e.repeat) callbacks.onBoost?.();
    if (e.code === "KeyC" && active && !e.repeat) {
      e.preventDefault();
      cycleCamera();
    }
    if (e.code === "KeyV" && active && !e.repeat) {
      e.preventDefault();
      setOverhead();
    }
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", resetInput);
  document.addEventListener("visibilitychange", resetInput);
  function resetInput() {
    keys.clear();
    stick.x = stick.z = 0;
    brake = false;
    boostHeld = false;
  }
  function desiredView() {
    if (state.docked === "survey") return "survey";
    if (state.docked) return "cockpit";
    return flyCamera;
  }
  function setView(next) {
    if (next === view) return;
    view = next;
    viewBlend = reduced ? 1 : 0;
    camera.layers.enable(0);
    camera.layers.enable(1);
    camera.layers.enable(2);
    if (view === "cockpit") camera.layers.disable(1);
    else camera.layers.disable(2);
    callbacks.onView?.(view);
  }
  function cycleCamera() {
    if (state.docked) return;
    flyCamera = nextFlyCamera(flyCamera);
    setView(desiredView());
  }
  function setOverhead() {
    if (state.docked) return;
    flyCamera = "overhead";
    setView(desiredView());
  }
  function dock() {
    if (state.nearest && state.distance <= DOCK_MARGIN) {
      state.docked = state.nearest;
      state.target = null;
      state.vx = state.vz = 0;
      const spec = catalog.bodies.find((b) => b.id === state.docked);
      const p = positionOf(spec, catalog.bodies);
      state.park = Math.atan2(state.z - p.z, state.x - p.x);
      setView(desiredView());
      callbacks.onDock(spec);
    }
  }
  function navigate(id) {
    if (!active) return;
    const spec = catalog.bodies.find((b) => b.id === id);
    if (!spec) return;
    state.docked = null;
    state.target = id;
    state.courseTarget = null;
    resetInput();
    setView(desiredView());
    if (reduced) {
      const p = positionOf(spec, catalog.bodies);
      state.x = p.x;
      state.z = p.z + spec.radius + 1.5;
      state.target = null;
      state.docked = id;
      pendingDock = spec;
      setView(desiredView());
    }
  }
  const orbitPanels = ["#station", "#orbit-notes", "#comm-hud", "footer.cockpit"].map(id => document.querySelector(id));
  let framing = orbitViewport(innerWidth, innerHeight), framingPending = false;
  function measureFraming() {
    if (framingPending) return;
    framingPending = true;
    requestAnimationFrame(() => {
      framingPending = false;
      const panels = orbitPanels.filter(el => el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden").map(el => el.getBoundingClientRect());
      framing = orbitViewport(innerWidth, innerHeight, panels);
      document.body.style.setProperty("--orbit-center-x", `${framing.x}px`);
      document.body.style.setProperty("--orbit-center-y", `${framing.y}px`);
    });
  }
  const panelResize = new ResizeObserver(measureFraming);
  for (const panel of orbitPanels) if (panel) panelResize.observe(panel);
  const panelState = new MutationObserver(measureFraming);
  panelState.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", measureFraming);
  const orbitOffset = new THREE.Vector2();
  const orbitDirection = new THREE.Vector3();
  const raycaster = new THREE.Raycaster(),
    pointer = new THREE.Vector2();
  canvas.addEventListener("pointerup", (e) => {
    if (!active || paused || stopped) return;
    pointer.set(
      (e.clientX / innerWidth) * 2 - 1,
      (-e.clientY / innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(
      bodies.map((b) => b.group),
      true,
    )[0];
    if (hit) {
      let object = hit.object;
      while (object.parent && !bodies.some((b) => b.group === object))
        object = object.parent;
      const body = bodies.find((b) => b.group === object);
      if (body) callbacks.onNavigate(body.spec.id);
    }
  });
  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
  window.addEventListener("resize", resize);
  function setLow(value) {
    low = value;
    renderer.setPixelRatio(Math.min(devicePixelRatio, low ? 1 : 1.5));
    dust.visible = !low;
    stars.visible = !low;
    callbacks.onQuality(low);
  }
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    stopped = true;
    callbacks.onFailure(
      "The 3D connection was interrupted. Continue exploring in the chart, or read my resume.",
    );
  });
  const trail = new Float32Array(45 * 3);
  for (let i = 0; i < 45; i++) {
    trail[i * 3] = state.x;
    trail[i * 3 + 1] = 1.6;
    trail[i * 3 + 2] = state.z;
  }
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trail, 3));
  const trailLine = new THREE.Line(
    trailGeo,
    new THREE.LineBasicMaterial({
      color: "#8fd9c0",
      transparent: true,
      opacity: 0.2,
    }),
  );
  scene.add(trailLine);
  let last = performance.now(),
    uiTime = 0,
    animationTime = 0;
  function frame(now) {
    if (stopped) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (document.hidden) return;
    if (active && !paused) {
      const arrived = stepFlight(
        state,
        {
          yaw: steerYaw({
            left: keys.has("KeyA") || keys.has("ArrowLeft"),
            right: keys.has("KeyD") || keys.has("ArrowRight"),
            stickX: stick.x,
          }),
          thrust:
            keys.has("KeyW") || keys.has("ArrowUp") || stick.z < -0.12
              ? Math.max(
                  keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0,
                  stick.z < 0 ? -stick.z : 0,
                )
              : 0,
          boost: boostHeld || keys.has("Space"),
          brake:
            brake ||
            keys.has("KeyS") ||
            keys.has("ArrowDown") ||
            stick.z > 0.45,
        },
        catalog.bodies,
        reduced && state.docked ? 0 : dt,
      );
      if (arrived || pendingDock) {
        const spec = arrived || pendingDock;
        pendingDock = null;
        setView(desiredView());
        callbacks.onDock(spec);
      }
      const found = stepCollect(state, catalog.signals || [], catalog.bodies);
      if (found) callbacks.onCollect?.(found);
    }
    setView(desiredView());
    if (!reduced && !paused) animationTime += dt;
    const time = animationTime;
    sunMat.uniforms.time.value = time;
    sun.rotation.y = time * 0.025;
    sunHoop.rotation.z = time * 0.08;
    for (const body of bodies) {
      const p = positionOf(body.spec, catalog.bodies);
      body.group.position.set(
        p.x,
        0.45 +
          (body.spec.altitude || 0) +
          (reduced ? 0 : Math.sin(time * 0.5 + body.spec.angle) * 0.1),
        p.z,
      );
      body.group.scale.setScalar(
        view === "survey" ? (body.spec.parent ? 1.3 : 1.65) : 1,
      );
      body.rotor.rotation.y =
        time *
        (body.spec.id === "observe"
          ? 0.17
          : body.spec.id === "survey"
            ? 0.22
            : 0.055);
      if (body.moonRing && body.parentSpec) {
        const parent = positionOf(body.parentSpec, catalog.bodies);
        body.moonRing.position.set(parent.x, -0.15, parent.z);
      }
    }
    for (const buoy of buoys) {
      const p = positionOf(buoy.spec, catalog.bodies);
      const taken = state.collected.has(buoy.spec.id);
      buoy.obj.visible = !taken;
      buoy.obj.position.set(p.x, 0.9 + Math.sin(time * 2 + p.x) * 0.12, p.z);
      buoy.obj.rotation.y = time * 0.8;
    }
    craft.ship.position.set(
      state.x,
      1.55 + (reduced ? 0 : Math.sin(time * 2) * 0.06),
      state.z,
    );
    craft.ship.rotation.y = state.heading;
    craft.hull.rotation.z = reduced ? 0 : -state.vx * 0.016;
    craft.hull.rotation.x = reduced ? 0 : state.vz * 0.008;
    craft.exhaust.scale.setScalar(1.4 + Math.hypot(state.vx, state.vz) * 0.1);
    const rig = cameraRig(state, active ? view : "intro");
    camera.fov += (rig.fov - camera.fov) * (1 - Math.exp(-4 * dt));
    camera.updateProjectionMatrix();
    const surveyFit = view === "survey" ? Math.max(1.6, 1.05 / camera.aspect) : 1;
    cameraGoal.set(rig.x, rig.y * surveyFit, rig.z * surveyFit);
    aim.set(rig.lookX, rig.lookY, rig.lookZ);
    const focusedBody = active && view === "cockpit" && state.docked ? bodies.find(body => body.spec.id === state.docked) : null;
    const offsetX = focusedBody ? innerWidth / 2 - framing.x : 0;
    const offsetY = focusedBody ? innerHeight / 2 - framing.y : 0;
    const framingBlend = reduced ? 1 : 1 - Math.exp(-5 * dt);
    orbitOffset.x += (offsetX - orbitOffset.x) * framingBlend;
    orbitOffset.y += (offsetY - orbitOffset.y) * framingBlend;
    camera.setViewOffset(innerWidth, innerHeight, orbitOffset.x, orbitOffset.y, innerWidth, innerHeight);
    if (focusedBody) {
      aim.copy(focusedBody.group.position);
      orbitDirection.copy(cameraGoal).sub(aim);
      const distance = Math.max(orbitDirection.length(), orbitDistance(focusedBody.spec.radius * 1.4, camera.fov, innerHeight, framing));
      cameraGoal.copy(aim).add(orbitDirection.normalize().multiplyScalar(distance));
    }

    const follow =
      view === "cockpit" ? 7 : view === "survey" || view === "overhead" ? 1.8 : 2.4;
    if (frames === 0 || reduced || !active || (view === "explore" && viewBlend === 1))
      camera.position.copy(cameraGoal);
    else {
      viewBlend = Math.min(1, viewBlend + dt / 0.85);
      const k = 1 - Math.exp(-follow * dt);
      camera.position.lerp(cameraGoal, Math.max(k, viewBlend * k * 2));
    }
    camera.lookAt(aim);
    camera.updateMatrixWorld();
    routeLine.visible = Boolean(state.target);
    if (state.target) {
      const p = positionOf(
          catalog.bodies.find((b) => b.id === state.target),
          catalog.bodies,
        ),
        a = routeLine.geometry.attributes.position;
      a.setXYZ(0, state.x, 0.1, state.z);
      a.setXYZ(1, p.x, 0.1, p.z);
      a.needsUpdate = true;
      routeLine.computeLineDistances();
    }
    if (lensOn) {
      const pts = ["platform", "homelab", "bitops"].map((id) =>
        positionOf(
          catalog.bodies.find((b) => b.id === id),
          catalog.bodies,
        ),
      );
      const a = lens.geometry.attributes.position;
      pts.forEach((p, i) => a.setXYZ(i, p.x, -0.35, p.z));
      a.needsUpdate = true;
      lens.computeLineDistances();
    }
    lens.visible = lensOn;
    const charted = showOrbitGuides(active ? view : "intro");
    for (const guide of orbitGuides) guide.visible = charted;
    dust.visible = !low && view !== "survey";
    stars.material.opacity = view === "survey" ? 0.2 : 0.62;
    if (!paused && !reduced) {
      trail.copyWithin(0, 3);
      trail[132] = state.x;
      trail[133] = 1.4;
      trail[134] = state.z;
      trailGeo.attributes.position.needsUpdate = true;
    }
    trailLine.visible = active && !reduced && view !== "cockpit";
    craft.hull.visible = view !== "cockpit";
    if (scene.fog) scene.fog.density = view === "survey" ? 0.0012 : 0.0046;
    cockpit.visible = view === "cockpit";
    const cockpitScale =
      Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.3;
    cockpit.scale.set(cockpitScale * camera.aspect, cockpitScale, 1);
    craft.interior.visible = false;
    renderer.render(scene, camera);
    for (const body of bodies) {
      projection.copy(body.group.position);
      projection.y += body.spec.radius + 1.1;
      projection.project(camera);
      const dist = Math.hypot(
        body.group.position.x - state.x,
        body.group.position.z - state.z,
      );
      const moonFar = body.spec.parent && dist > 20 && view !== "survey";
      const sy = (-projection.y * 0.5 + 0.5) * innerHeight;
      callbacks.onProject(
        body.spec.id,
        (projection.x * 0.5 + 0.5) * innerWidth,
        sy,
        view !== "cockpit" &&
          !moonFar &&
          !(
            view === "survey" &&
            (body.spec.parent || body.spec.id === "survey")
          ) &&
          projection.z < 1 &&
          projection.x > -0.94 &&
          projection.x < 0.94 &&
          sy > 125 &&
          sy < innerHeight - 155,
      );
    }
    uiTime += dt;
    if (uiTime > 0.1) {
      callbacks.onState(state, view);
      uiTime = 0;
    }
    frames++;
    elapsed += dt;
    if (frames === 1) {
      performance.mark("orrery-first-frame");
      callbacks.onReady(low);
    }
    if (!sampled && elapsed > 6) {
      sampled = true;
      if (frames / elapsed < 42 && !low) setLow(true);
    }
  }
  requestAnimationFrame(frame);
  return {
    state,
    navigate,
    dock,
    start() {
      active = true;
      viewBlend = reduced ? 1 : 0;
      setView(desiredView());
    },
    pause(value) {
      paused = value;
      resetInput();
    },
    undock() {
      state.docked = null;
      resetInput();
      setView(desiredView());
    },
    cancel() {
      state.target = null;
      state.courseTarget = null;
      resetInput();
    },
    cycleCamera,
    setOverhead,
    setStick(x, z) {
      stick.x = x;
      stick.z = z;
    },
    setBrake(value) {
      brake = value;
    },
    setBoost(value) {
      if (value && !boostHeld && active) callbacks.onBoost?.();
      boostHeld = value;
    },
    setLow,
    setLens(value) {
      lensOn = value;
    },
    view() {
      return view;
    },
    stop() {
      stopped = true;
      resetInput();
      panelResize.disconnect();
      panelState.disconnect();
      window.removeEventListener("resize", measureFraming);
      renderer.dispose();
    },
  };
}
