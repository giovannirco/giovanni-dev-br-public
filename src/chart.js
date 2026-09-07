import { positionOf } from "./flight.js";

const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function renderChart({
  catalog,
  visited,
  state,
  lens,
  focus,
  chooseFocus,
  navigate,
}) {
  const svg = document.querySelector("#chart-svg"),
    list = document.querySelector("#chart-destinations");
  const roots = catalog.bodies.filter((b) => !b.parent),
    selected = roots.find((b) => b.id === focus);
  const center = selected
      ? positionOf(selected, catalog.bodies)
      : { x: 0, z: 0 },
    span = selected ? 12.2 : 66;
  const xy = (p) => ({
    x: 240 + ((p.x - center.x) / span) * 206,
    y: 240 + ((p.z - center.z) / span) * 206,
  });
  const shown = selected
    ? catalog.bodies.filter((b) => b.id === focus || b.parent === focus)
    : roots;
  document.querySelector("#chart-focus-title").textContent = selected
    ? `${selected.name} / ${shown.length - 1} moons`
    : "System overview";
  document.querySelector("#chart-filters").innerHTML = [
    { id: "all", name: "All orbits" },
    ...roots.filter((b) => catalog.bodies.some((m) => m.parent === b.id)),
  ]
    .map(
      (b) =>
        `<button data-focus="${b.id}" aria-pressed="${(focus || "all") === b.id}">${escape(b.name.replace(" station", ""))}</button>`,
    )
    .join("");
  document
    .querySelectorAll("[data-focus]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        chooseFocus(
          button.dataset.focus === "all" ? null : button.dataset.focus,
        ),
      ),
    );
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const a = (i * Math.PI) / 36,
      r = i % 6 ? 224 : 218;
    return `M${240 + Math.sin(a) * r},${240 + Math.cos(a) * r}L${240 + Math.sin(a) * 228},${240 + Math.cos(a) * 228}`;
  }).join("");
  const rings = [
    ...new Set(shown.filter((b) => b.id !== focus).map((b) => b.orbit)),
  ]
    .map(
      (r) =>
        `<circle cx="240" cy="240" r="${(r / span) * 206}" class="chart-orbit"/>`,
    )
    .join("");
  const route =
    lens && !selected
      ? `<path class="chart-connection" d="${["platform", "homelab", "bitops"]
          .map((id, i) => {
            const p = xy(
              positionOf(
                catalog.bodies.find((b) => b.id === id),
                catalog.bodies,
              ),
            );
            return `${i ? "L" : "M"}${p.x},${p.y}`;
          })
          .join(" ")}"/>`
      : "";
  const dots = shown
    .map((b) => {
      const p = xy(positionOf(b, catalog.bodies)),
        children = catalog.bodies.filter((m) => m.parent === b.id),
        radius = b.id === focus ? 15 : b.parent ? 7 : 10;
      return `<g class="chart-node" role="button" tabindex="0" data-node="${b.id}" aria-label="${!selected && children.length ? "Explore" : "Fly to"} ${escape(b.name)}" style="--body-color:${b.color}"><circle cx="${p.x}" cy="${p.y}" r="23" fill="transparent"/><circle class="chart-node-halo" cx="${p.x}" cy="${p.y}" r="${radius + 5}"/><circle class="chart-node-core" cx="${p.x}" cy="${p.y}" r="${radius}"/><path d="M${p.x},${p.y - radius - 6}v-10" stroke="${b.color}" stroke-opacity=".6"/><text x="${p.x}" y="${p.y - radius - 22}" text-anchor="middle">${escape(b.name)}</text><text class="chart-node-meta" x="${p.x}" y="${p.y + radius + 20}" text-anchor="middle">${visited.has(b.id) ? "VISITED" : children.length ? `${children.length} MOONS` : b.parent ? "MOON" : "ORBIT"}</text>${!selected && children.length ? `<circle cx="${p.x}" cy="${p.y}" r="26" class="chart-moon-orbit"/>` : ""}</g>`;
    })
    .join("");
  const ship = state ? xy(state) : null;
  const craft =
    ship && Math.hypot(ship.x - 240, ship.y - 240) < 222
      ? `<g transform="translate(${ship.x} ${ship.y})"><path d="M0,-7L5,6 0,3 -5,6Z" transform="rotate(${180 - (state.heading * 180) / Math.PI})" fill="#c6f7d9"/><text x="9" y="4" class="chart-craft-label">NÓMADA</text></g>`
      : "";
  svg.setAttribute("viewBox", "0 0 480 480");
  svg.setAttribute("role", "group");
  svg.innerHTML = `<defs><radialGradient id="chart-halo"><stop stop-color="#a2d6c1" stop-opacity=".08"/><stop offset="1" stop-color="#a2d6c1" stop-opacity="0"/></radialGradient></defs><circle cx="240" cy="240" r="234" fill="url(#chart-halo)"/><path d="${ticks}" stroke="#738e88" stroke-opacity=".55"/><path d="M240 16v448M16 240h448" stroke="#78948a" stroke-opacity=".12"/>${rings}${route}${!selected ? '<circle cx="240" cy="240" r="5" fill="#e6c58f"/><text x="240" y="262" text-anchor="middle" class="chart-node-meta">GC</text>' : ""}${dots}${craft}`;
  svg.querySelectorAll("[data-node]").forEach((node) => {
    const activate = () => {
      const b = catalog.bodies.find((b) => b.id === node.dataset.node);
      if (!selected && catalog.bodies.some((m) => m.parent === b.id))
        chooseFocus(b.id);
      else navigate(b.id);
    };
    node.addEventListener("click", activate);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });
  const row = (b) =>
    `<button data-id="${b.id}" class="${b.parent ? "moon-dest" : ""}" style="--body-color:${b.color}"><span class="chart-number">${b.parent ? "◌" : "◉"}</span><span>${escape(b.name)}<small>${escape(b.subtitle)}</small></span><span class="chart-check">${visited.has(b.id) ? "✓" : "↗"}</span></button>`;
  list.innerHTML = selected
    ? shown.map(row).join("")
    : roots
        .map(
          (b) =>
            `<div class="chart-family">${row(b)}${catalog.bodies
              .filter((m) => m.parent === b.id)
              .map(row)
              .join("")}</div>`,
        )
        .join("");
  list.scrollTop = 0;
  list
    .querySelectorAll("[data-id]")
    .forEach((button) =>
      button.addEventListener("click", () => navigate(button.dataset.id)),
    );
}
