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
