import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every module `node server.mjs` reaches at runtime, following relative
// imports, plus the packages it imports by bare name.
function runtimeModules(entry) {
  const seen = new Set();
  const packages = new Set();
  const queue = [resolve(root, entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
      else if (!specifier.startsWith("node:")) packages.add(specifier.split("/")[0]);
    }
  }
  return {
    files: [...seen].map((file) => relative(root, file)),
    packages: [...packages],
  };
}

// The runtime stage is everything after the last FROM.
function runtimeCopies() {
  const lines = readFileSync(resolve(root, "Dockerfile"), "utf8").split("\n");
  const start = lines.findLastIndex((line) => /^FROM\s/.test(line));
  return lines
    .slice(start)
    .map((line) => line.match(/^COPY\s+.*?\s(\/app\/\S+)\s/))
    .filter(Boolean)
    .map((match) => match[1].replace(/^\/app\//, ""));
}

function covers(pattern, file) {
  if (pattern === file) return true;
  if (!pattern.includes("*")) return file.startsWith(`${pattern}/`);
  const rx = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  return rx.test(file);
}

test("the runtime image carries every module the server imports", () => {
  const copies = runtimeCopies();
  assert.ok(copies.length, "no runtime COPY lines found");
  for (const file of runtimeModules("server.mjs").files)
    assert.ok(
      copies.some((pattern) => covers(pattern, file)),
      `${file} is imported by server.mjs but no Dockerfile COPY brings it into the runtime image`,
    );
});

test("the runtime image carries every module the notify relay imports", () => {
  const copies = runtimeCopies();
  for (const file of runtimeModules("relay.mjs").files)
    assert.ok(
      copies.some((pattern) => covers(pattern, file)),
      `${file} is imported by relay.mjs but no Dockerfile COPY brings it into the runtime image`,
    );
});

test("the runtime image carries every module the AI proxy imports", () => {
  const copies = runtimeCopies();
  for (const file of runtimeModules("ai-proxy.mjs").files)
    assert.ok(
      copies.some((pattern) => covers(pattern, file)),
      `${file} is imported by ai-proxy.mjs but no Dockerfile COPY brings it into the runtime image`,
    );
});

test("the runtime image carries every module the metrics proxy imports", () => {
  const copies = runtimeCopies();
  for (const file of runtimeModules("metrics-proxy.mjs").files)
    assert.ok(
      copies.some((pattern) => covers(pattern, file)),
      `${file} is imported by metrics-proxy.mjs but no Dockerfile COPY brings it into the runtime image`,
    );
});

test("the runtime image ships no shell, BusyBox tools or package installer", () => {
  const lines = readFileSync(resolve(root, "Dockerfile"), "utf8").split("\n");
  const runtime = lines.slice(lines.findLastIndex((line) => /^FROM\s/.test(line))).join("\n");
  assert.match(runtime, /readlink "\$f"\)" = \/bin\/busybox \]; then \/bin\/busybox rm "\$f"/);
  for (const path of ["/bin/busybox", "/sbin/apk", "/etc/apk", "/lib/apk"])
    assert.ok(new RegExp(`rm -rf[^\\n]*\\s${path.replace(/\//g, "\\/")}(\\s|$)`, "m").test(runtime), `${path} is not removed from the runtime image`);
  const removal = runtime.indexOf("/bin/busybox readlink");
  for (const needsShell of ["adduser", "apk upgrade"]) assert.ok(runtime.indexOf(needsShell) < removal, `${needsShell} must run before the shell is removed`);
  assert.match(runtime, /^ENTRYPOINT \[\]$/m, "the base image entrypoint is a shell script and must be cleared");
  assert.equal(/^RUN /m.test(runtime.slice(removal).split("\n").slice(1).join("\n")), false, "no RUN can follow the shell removal");
});

test("the runtime image carries the built site and the catalog", () => {
  const copies = runtimeCopies();
  for (const needed of ["dist", "data"])
    assert.ok(
      copies.some((pattern) => covers(pattern, `${needed}/x`) || pattern === needed),
      `${needed} is missing from the runtime image`,
    );
});

// The reason this test exists: until the logger arrived the server imported
// nothing but Node built-ins, so the runtime stage shipped no node_modules at
// all. A bare import is a crash on startup, not a warning at build time.
test("packages the server imports by name are installed in the runtime image", () => {
  const { packages } = runtimeModules("server.mjs");
  if (!packages.length) return;
  const copies = runtimeCopies();
  assert.ok(
    copies.includes("node_modules"),
    `server.mjs imports ${packages.join(", ")} but the runtime stage copies no node_modules`,
  );
  const declared = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  for (const name of packages)
    assert.ok(
      Object.hasOwn(declared.dependencies || {}, name),
      `${name} is imported at runtime but is not a production dependency`,
    );
});

test("the runtime image ships no package manager", () => {
  const lines = readFileSync(resolve(root, "Dockerfile"), "utf8").split("\n");
  const runtime = lines.slice(lines.findLastIndex((line) => /^FROM\s/.test(line))).join("\n");
  for (const tool of ["node_modules/npm", "node_modules/corepack", "/usr/local/bin/corepack", "/usr/local/bin/npx"])
    assert.ok(runtime.includes(tool), `${tool} is left in the runtime image`);
});
