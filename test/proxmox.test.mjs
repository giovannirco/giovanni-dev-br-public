import assert from "node:assert/strict";
import { test } from "node:test";
import { createInsight, PROXMOX_QUERY } from "../src/insight.mjs";

const NOW = 1800000000000;
const base = {
  collection_success: 1, collection_timestamp_seconds: NOW / 1000 - 10,
  up: 1, cpu_ratio: 0.23, cores: 16, memory_used_bytes: 12e9,
  memory_total_bytes: 48e9, uptime_seconds: 90061,
  vms_total: 7, vms_running: 5, containers_total: 3, containers_running: 0,
};
function feed(overrides = {}, options = {}) {
  const values = { ...base, ...overrides };
  return createInsight({
    mimirUrl: "http://metrics.test", now: () => NOW,
    ...options,
    fetchImpl: async url => {
      assert.equal(new URL(url).searchParams.get("query"), PROXMOX_QUERY);
      return Response.json({ status: "success", data: { result: Object.entries(values).map(([field, value]) => ({
        metric: { __name__: `orrery_proxmox_${field}`, instance: "private-hypervisor", name: "secret-guest", address: "10.77.0.9" },
        value: [1, value],
      })) } });
    },
  });
}

test("Proxmox emits only sanitized host readings, including valid zero counts", async () => {
  const result = await feed({}, { proxmoxAliases: "private-hypervisor=Compute A,missing-host=Compute B" }).proxmox();
  const host = result.hosts.find(h => h.name === "Compute A");
  assert.equal(host.reporting, true);
  assert.equal(host.cpu, 0.23);
  assert.equal(host.up, true);
  assert.equal(host.containersRunning, 0);
  assert.equal(host.memoryUsed, 12e9);
  assert.equal(host.updatedAt, new Date(NOW - 10000).toISOString());
  const missing = result.hosts.find(h => h.name === "Compute B");
  assert.equal(missing.reporting, false);
  assert.equal(missing.up, null);
  assert.equal(missing.vmsTotal, null);
  assert.doesNotMatch(JSON.stringify(result), /private-hypervisor|missing-host|secret-guest|10\.77/);
});

test("Proxmox collector failure, stale timestamps and clock errors invalidate readings", async () => {
  for (const override of [
    { collection_success: 0 }, { collection_success: null },
    { collection_timestamp_seconds: NOW / 1000 - 181 },
    { collection_timestamp_seconds: NOW / 1000 + 31 },
    { collection_timestamp_seconds: null },
  ]) {
    const host = (await feed(override).proxmox()).hosts[0];
    assert.equal(host.reporting, false);
    for (const field of ["up", "cpu", "memoryUsed", "vmsRunning", "uptimeSeconds", "updatedAt"])
      assert.equal(host[field], null);
  }
});

test("Proxmox rejects impossible ratios, missing denominators and upstream text", async () => {
  const host = (await feed({
    up: 0.4, cpu_ratio: 3, memory_used_bytes: 50e9, memory_total_bytes: 48e9,
    vms_running: 8, vms_total: 7, containers_total: null, uptime_seconds: "secret-guest",
    cores: -1,
  }).proxmox()).hosts[0];
  for (const field of ["up", "cpu", "memoryUsed", "vmsRunning", "containersRunning", "uptimeSeconds", "cores"])
    assert.equal(host[field], null, field);
  const offline = (await feed({ up: 0, cpu_ratio: 0 }).proxmox()).hosts[0];
  assert.equal(offline.up, false);
  assert.equal(offline.cpu, 0);
});
