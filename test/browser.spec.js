import { test, expect } from "@playwright/test";

test("Bitcoin node readings survive a missing block feed and distinguish unknown verification", async ({ page }) => {
  await mockAPI(page);
  await page.route("**/api/bitcoin/node", route => route.fulfill({ json: {
    peers: 0, chainBytes: 874840231616, mempoolTransactions: 0,
    mempoolBytes: 0, uptimeSeconds: 156257, verification: null,
  } }));
  await page.route("**/api/bitcoin/block", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await visit(page, "bitcoin");
  const live = page.locator(".orbit-live");
  await expect(live).toContainText("874.8 GB");
  await expect(live).toContainText("0 txs · 0.0 MB");
  await expect(live).toContainText("1d 19h");
  await expect(live).toContainText("Unknown");
  await expect(live).toContainText("$79,546");
  const panel = await live.boundingBox();
  const body = await page.locator("#station-body").boundingBox();
  expect(panel.y + panel.height).toBeLessThanOrEqual(body.y + body.height + 1);
});

test("Bitcoin block readings survive a missing node exporter", async ({ page }) => {
  await mockAPI(page);
  await page.route("**/api/bitcoin/node", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await visit(page, "bitcoin");
  await expect(page.locator(".orbit-live")).toContainText("900,123");
  await expect(page.locator(".orbit-live")).toContainText("Not reporting");
});
const bodies = [
  "resume",
  "platform",
  "observe",
  "homelab",
  "bitcoin",
  "survey",
];
async function mockAPI(page, offline = false) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const values = {
      "/api/bitcoin/tip": { height: 900123 },
      "/api/bitcoin/price": { usd: 79546, time: 1788706805 },
      "/api/bitcoin/block": { height: 900123, timestamp: Math.floor(Date.now() / 1000) - 754, transactions: 5622 },
      "/api/insight/site": {
        playing: 2, reported: 40, flights: 119, avgFlightSeconds: 56, chats: 10,
        chatErrors: 0, throttled: 1, boosts: 33, buoys: 4,
        charts: 61, commOpens: 18, resume: 9, notes: 74, fallbacks: 2, readyP50: 640,
        destinations: [{ body: "homelab", docks: 7 }, { body: "resume", docks: 4 }],
        opened: [{ body: "homelab", reads: 12 }, { body: "resume", reads: 5 }],
      },
      "/api/insight/lab": { nodes: 4, pods: 269, cores: 144, namespaces: 100 },
      "/api/insight/nodes": {
        nodes: [
          { name: "worker-01", ready: true, cores: 8, cpu: 0.19, memoryUsed: 12e9, memoryTotal: 33e9, pods: 108 },
          { name: "worker-02", ready: true, cores: 8, cpu: 0.68, memoryUsed: 25e9, memoryTotal: 33e9, pods: 62 },
          // Present in the cluster, reporting nothing: the case the panel has
          // to draw differently from an idle machine.
          { name: "worker-05", ready: null, cores: 4, cpu: null, memoryUsed: null, memoryTotal: null, pods: null },
        ],
        updatedAt: new Date().toISOString(),
      },
      "/api/insight/scout": { configured: true, tracked: 251, lastMovement: new Date(Date.now() - 26 * 60_000).toISOString() },
      "/api/bitcoin/mempool": { count: 42, vsize: 2500000 },
      "/api/bitcoin/fees": { fastestFee: 0, halfHourFee: 1, hourFee: 1 },
      "/api/tip": { lightningAddress: "", btcpayUrl: "" },
      "/api/chat/models": {
        defaultModel: "chat-small",
        models: [
          { id: "chat-small", name: "Small" },
          { id: "chat-large", name: "Large" },
        ],
      },
    };
    await route.fulfill({
      status: offline && path.includes("/bitcoin/") ? 502 : 200,
      contentType: "application/json",
      body: JSON.stringify(values[path] || {}),
    });
  });
}
async function visit(page, id) {
  if (await page.locator("#intro").isVisible()) await page.locator("#launch").click();
  await page.locator("#map-toggle").click();
  await page.locator(`#chart-destinations [data-id="${id}"]`).click();
  await expect(page.locator("#station")).toBeVisible({ timeout: 9000 });
  await expect(page.locator("#dossier")).not.toBeVisible();
  await expect(page.locator("#scene")).toBeVisible();
}
test("fly, enter orbit, unlock instruments, toggle cockpit", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await mockAPI(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#launch")).toBeEnabled();
  await page.locator("#launch").click();
  for (const id of bodies) {
    await visit(page, id);
    await expect(page.locator("#station-body")).not.toBeEmpty();
    if (id === "survey") {
      // From the survey array every top-level destination is labelled, while
      // moons and the array you are standing on are not. Asserting the rule by
      // id survives catalog growth; the old bare count of 6 silently went
      // stale the moment relays were added.
      for (const labelled of ["resume", "platform", "observe", "homelab"])
        await expect(
          page.locator(`#body-labels button[data-id="${labelled}"]:visible`),
        ).toHaveCount(1);
      await expect(
        page.locator('#body-labels button[data-id="survey"]:visible'),
      ).toHaveCount(0);
      await expect(
        page.locator("#body-labels .moon-label:visible"),
      ).toHaveCount(0);
    }
    await page.locator("#station-undock").click();
    await expect(page.locator("#station")).toBeHidden();
  }
  await expect(page.locator("#visited-count")).toHaveText("06");
  // The instrument bar hides while flying; Console (I) brings it back.
  await page.keyboard.press("KeyI");
  // The toggle sits above the bar. The bar grows with its content, so a fixed
  // offset overlapped it; assert the two boxes actually clear each other.
  const toggleBox = await page.locator("#console-toggle").boundingBox();
  const cockpitBox = await page.locator("footer.cockpit").boundingBox();
  expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(cockpitBox.y);
  await page.locator("#instruments-toggle").click();
  await expect(page.locator("#gitops-toggle")).toBeEnabled();
  await expect(page.locator("#signal-toggle")).toBeEnabled();
  await expect(page.locator("#surveyor-badge")).toHaveText("UNLOCKED / 03");
  await page.locator("#signal-toggle").click();
  await expect(page.locator("#signal-detail")).toBeVisible();
  await expect(page.locator("#telemetry-block")).toHaveText("900,123");
  await expect(page.locator("#fee")).toHaveText("0");
  await expect(page.locator("#backlog")).toHaveText("2.5");
  await page.locator("#telemetry [data-close]").click();
  await page.locator("#scene").click({ position: { x: 40, y: 400 } });
  await expect(page.locator("body")).toHaveClass(/overhead-view/);
  await page.keyboard.press("KeyC");
  await page.keyboard.press("KeyC");
  await expect(page.locator("body")).toHaveClass(/cockpit-view/);
  await page.reload();
  await expect(page.locator("#visited-count")).toHaveText("06");
  expect(errors).toEqual([]);
});
function headingDeg(page) {
  return page
    .locator("#hud-heading")
    .evaluate((el) => Number(el.textContent.replace("°", "")));
}

test("launch is plan cam, C cycles, V always returns overhead", async ({
  page,
}) => {
  await mockAPI(page);
  await page.goto("/");
  await page.locator("#launch").click();
  await expect(page.locator("body")).toHaveClass(/overhead-view/);
  await page.locator("#scene").click({ position: { x: 40, y: 400 } });
  await page.keyboard.press("KeyC");
  await expect(page.locator("body")).not.toHaveClass(/overhead-view/);
  await expect(page.locator("body")).not.toHaveClass(/cockpit-view/);
  await page.keyboard.press("KeyC");
  await expect(page.locator("body")).toHaveClass(/cockpit-view/);
  await page.keyboard.press("KeyV");
  await expect(page.locator("body")).toHaveClass(/overhead-view/);
  await expect(page.locator("#overhead-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("KeyV");
  await expect(page.locator("body")).toHaveClass(/overhead-view/);
});

test("A yaws opposite of D", async ({ page }) => {
  await mockAPI(page);
  await page.goto("/");
  await page.locator("#launch").click();
  await page.locator("#scene").click({ position: { x: 20, y: 400 } });
  const start = await headingDeg(page);
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(500);
  await page.keyboard.up("KeyA");
  const afterA = await headingDeg(page);
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(1000);
  await page.keyboard.up("KeyD");
  const afterD = await headingDeg(page);
  const wrap = (a, b) => ((((b - a + 540) % 360) + 360) % 360) - 180;
  const dA = wrap(start, afterA);
  const dD = wrap(afterA, afterD);
  expect(Math.abs(dA)).toBeGreaterThan(8);
  expect(Math.abs(dD)).toBeGreaterThan(8);
  expect(Math.sign(dA)).toBe(-Math.sign(dD));
});

test("manual flight, brake, pause, map and input focus work", async ({
  page,
}, testInfo) => {
  await mockAPI(page);
  await page.goto("/");
  await page.locator("#launch").click();
  await page.locator("#map-toggle").click();
  const before = await page.locator("#chart-svg").innerHTML();
  await page.keyboard.press("Escape");
  if (testInfo.project.name === "phone") {
    const box = await page.locator("#joystick").boundingBox();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + 5 }],
    });
    await page.waitForTimeout(700);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } else {
    await page.locator("#scene").click({ position: { x: 20, y: 400 } });
    await page.keyboard.down("ArrowUp");
    await page.waitForTimeout(700);
    await page.keyboard.up("ArrowUp");
    await page.keyboard.down("KeyS");
    await page.waitForTimeout(250);
    await page.keyboard.up("KeyS");
  }
  await page.locator("#map-toggle").click();
  expect(await page.locator("#chart-svg").innerHTML()).not.toBe(before);
  await page.keyboard.press("Escape");
  await expect(page.locator("#chart")).not.toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
});
test("WebGL failure retains chart stories, honest offline data, tips and resume", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type.startsWith("webgl")) return null;
      return original.call(this, type, ...args);
    };
  });
  await mockAPI(page, true);
  await page.goto("/");
  await expect(page.locator("#fallback")).toBeVisible();
  await expect(page.locator(".resume-link")).toHaveAttribute(
    "href",
    "https://resume.giovanni.dev.br",
  );
  await page.locator("#fallback-chart").click();
  await page.locator('#chart-destinations [data-id="platform"]').click();
  await expect(page.locator("#dossier-title")).toHaveText("Platform");
  await page.locator("#undock").click();
  await page.locator("#bitcoin-toggle").click();
  await expect(page.locator("#bitcoin-state")).toHaveText("OFFLINE");
  await expect(page.locator("#telemetry-block")).toHaveText("—");
  await page.locator("#tip-button").click();
  await expect(page.locator("#tip-status")).toHaveText(
    "Tipping is not configured yet.",
  );
  expect(page.url()).toContain("8181");
});
test("reduced motion docks without an animated transit; unavailable storage is optional", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("disabled");
    };
    Storage.prototype.setItem = () => {
      throw new Error("disabled");
    };
  });
  await mockAPI(page);
  await page.goto("/");
  await expect(page.locator("#launch")).toBeEnabled();
  await visit(page, "homelab");
  await expect(page.locator("#visited-count")).toHaveText("01");
  await expect(page.locator("#station-title")).toHaveText("Homelab");
  await expect(page.locator("#dossier")).not.toBeVisible();
});
test("resume works with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:8181");
  await expect(page.locator(".resume-link")).toHaveAttribute(
    "href",
    "https://resume.giovanni.dev.br",
  );
  await expect(page.locator("noscript")).toBeVisible();
  await context.close();
});

test("orbit COMM streams safe Markdown, keeps scope history, stops and closes", async ({
  page,
}, testInfo) => {
  await mockAPI(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const requests = [];
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.prompt === "Wait for this")
      await new Promise((resolve) => setTimeout(resolve, 1200));
    const content =
      body.prompt === "Wait for this"
        ? "Late response must not appear"
        : `**${body.bodyId}**\n\n- Kubernetes\n- [Resume](https://resume.giovanni.dev.br)\n\n<img src=x onerror=alert(1)><script>alert(1)</script>[bad](javascript:alert(1))`;
    await route
      .fulfill({
        contentType: "text/event-stream",
        body: `event: delta\ndata: ${JSON.stringify({ text: content })}\n\nevent: done\ndata: {}\n\n`,
      })
      .catch(() => {});
  });
  await page.goto("/");
  await visit(page, "homelab");
  await expect(page.locator("#comm-hud")).toBeHidden();
  await expect(page.locator("body")).toHaveClass(/cockpit-view/);
  await page.screenshot({ path: testInfo.outputPath("orbit.png") });
  await page.locator("#comm-toggle").click();
  if (testInfo.project.name === "phone") await expect(page.locator("#comm-input")).not.toBeFocused();
  else await expect(page.locator("#comm-input")).toBeFocused();
  await page.locator(".comm-starters button").first().click();
  await page.locator("#comm-input").press("Enter");
  await expect(page.locator(".comm-markdown strong")).toHaveText("homelab");
  await expect(page.locator(".comm-markdown li")).toHaveCount(2);
  await expect(
    page.locator(".comm-markdown img,.comm-markdown script"),
  ).toHaveCount(0);
  await expect(
    page.locator(".comm-markdown a[href^='javascript:']"),
  ).toHaveCount(0);
  expect(requests[0].history).toEqual([]);
  await page.locator("#comm-input").fill("A second question");
  await page.locator("#comm-input").press("Shift+Enter");
  expect(requests).toHaveLength(1);
  await page.locator("#comm-input").press("Enter");
  await expect(page.locator(".comm-message.assistant")).toHaveCount(2);
  await expect(page.locator("#comm-stop")).toBeHidden();
  expect(requests[1].history).toHaveLength(2);
  await page.screenshot({ path: testInfo.outputPath("comm.png") });
  await page.locator("#comm-input").fill("Wait for this");
  await page.locator("#comm-input").press("Enter");
  await expect(page.locator("#comm-stop")).toBeVisible();
  await page.locator("#comm-stop").click();
  await expect(page.locator(".comm-message-state")).toHaveText(
    "Response stopped.",
  );
  await page.locator("#comm-close").click();
  await expect(page.locator("#comm-hud")).toBeHidden();
  await expect(page.locator("#comm-toggle")).toBeFocused();
  await visit(page, "observe-mcp");
  await page.locator("#comm-toggle").click();
  await expect(page.locator(".comm-message")).toHaveCount(0);
  await page.locator("#comm-input").fill("What is here?");
  await page.locator("#comm-input").press("Enter");
  await expect(page.locator(".comm-markdown strong")).toHaveText("observe-mcp");
  expect(requests.at(-1).bodyId).toBe("observe-mcp");
  expect(requests.at(-1).history).toEqual([]);
  await expect(page.locator("#comm-log")).not.toContainText("Late response");
  await page.locator("#comm-close").click();
  await visit(page, "homelab");
  await page.locator("#comm-toggle").click();
  await expect(page.locator(".comm-message.assistant")).toHaveCount(3);
  await page.locator("#comm-clear").click();
  await expect(page.locator(".comm-message")).toHaveCount(0);
  await page
    .locator(
      testInfo.project.name === "desktop" ? "#comm-toggle" : "#comm-close",
    )
    .click();
  await page.locator("#station-undock").click();
  await expect(page.locator("#comm-hud")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Resume chart focuses its four moons and notes leave orbit intact", async ({
  page,
}, testInfo) => {
  await mockAPI(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("#launch").click();
  await page.locator("#map-toggle").click();
  await page.locator('#chart-filters [data-focus="resume"]').click();
  await expect(page.locator("#chart-svg .chart-node")).toHaveCount(5);
  await expect(page.locator("#chart-destinations .moon-dest")).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("resume-chart.png") });
  await page.locator('#chart-destinations [data-id="ai-enablement"]').click();
  await expect(page.locator("#station-title")).toHaveText("AI enablement");
  await page.locator("#station-notes").click();
  await expect(page.locator("#orbit-notes")).toContainText("MCP");
  await expect(page.locator("#orbit-notes")).not.toContainText("Exodus");
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await expect(page.locator("#dossier")).toBeHidden();
  await page.locator("#station-notes").click();
  await expect(page.locator("#station")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/in-orbit/);
});

test("orbit info appears immediately and notes and COMM keep the world moving", async ({
  page,
}, testInfo) => {
  await mockAPI(page);
  await page.goto("/");
  await visit(page, "homelab");
  await expect(page.locator(".orbit-summary")).toContainText(
    "bare-metal Talos",
  );
  // Assert the chips render rather than pinning one string: OpenEBS was a
  // homelab topic until storage became its own moon, and a hardcoded tag
  // goes stale the moment the catalog is reorganised.
  await expect(page.locator(".orbit-topics span")).toHaveCount(4);
  await expect(page.locator(".orbit-topics")).toContainText("Talos");
  await expect(page.locator("#comm-toggle")).toBeInViewport();
  await expect(page.locator("#orbit-notes")).toBeHidden();
  await page.locator("#station-notes").click();
  await expect(page.locator("#orbit-notes")).toBeVisible();
  await expect(page.locator("#orbit-notes-title")).toHaveText("Homelab");
  await expect(page.locator("#station-undock")).toBeInViewport();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  const notesHeading = await headingDeg(page);
  await expect
    .poll(async () => Math.abs((await headingDeg(page)) - notesHeading))
    .toBeGreaterThan(2);
  await page.screenshot({ path: testInfo.outputPath("inline-notes.png") });
  await page.locator("#comm-toggle").click();
  await expect(page.locator("#comm-hud")).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  const commHeading = await headingDeg(page);
  await expect
    .poll(async () => Math.abs((await headingDeg(page)) - commHeading))
    .toBeGreaterThan(2);
  await page.screenshot({ path: testInfo.outputPath("live-comm.png") });
  if (testInfo.project.name === "phone") {
    const panel = await page.locator("#comm-hud").boundingBox();
    expect(panel.y).toBeGreaterThan(200);
    expect(panel.y + panel.height).toBeLessThanOrEqual(page.viewportSize().height);
  }
  await page.locator("#comm-input").press("Escape");
  await expect(page.locator("#comm-hud")).toBeHidden();
  await expect(page.locator("body")).toHaveClass(/in-orbit/);
});

test("model picker filters, selects by keyboard, and sends the choice without losing orbit or draft", async ({
  page,
}, testInfo) => {
  await mockAPI(page);
  let sent;
  await page.route("**/api/chat/models", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        defaultModel: "chat-small",
        models: [
          { id: "chat-small", name: "Small" },
          { id: "chat-large", name: "Large" },
          ...Array.from({ length: 30 }, (_, i) => ({
            id: `model-${i}`,
            name: `Model ${i}`,
          })),
        ],
      }),
    }),
  );
  await page.route("**/api/chat", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ content: "Talos runs here." }),
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await visit(page, "homelab");
  await page.locator("#comm-toggle").click();
  await expect(page.locator("#model-name")).toHaveText("Small");
  await page.locator("#comm-input").fill("Tell me about Talos");
  await page.locator("#model-toggle").click();
  await expect(page.locator("#model-search")).toBeFocused();
  await expect(page.locator("#model-search")).toBeInViewport();
  await expect(page.locator("#model-options [role=option]")).toHaveCount(32);
  await page.locator("#model-search").fill("missing model");
  await expect(page.locator("#model-status")).toHaveText("No matching models.");
  await page.locator("#model-search").fill("LARGE");
  await expect(page.locator("#model-options [role=option]")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("model-picker.png") });
  await page.locator("#model-search").press("ArrowDown");
  await page.locator("#model-search").press("Enter");
  await expect(page.locator("#model-name")).toHaveText("Large");
  await expect(page.locator("#comm-input")).toHaveValue("Tell me about Talos");
  await expect(page.locator("#comm-input")).toBeFocused();
  await page.locator("#comm-input").press("Enter");
  await expect(page.locator("#comm-log")).toContainText("Talos runs here.");
  expect(sent.model).toBe("chat-large");
  expect(sent.bodyId).toBe("homelab");
  await page.locator("#model-toggle").click();
  await page.locator("#model-search").press("Escape");
  await expect(page.locator("#model-picker")).toBeHidden();
  await expect(page.locator("#comm-hud")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/in-orbit/);
});

test("model discovery failure is retryable and offers no invented choices", async ({
  page,
}) => {
  await mockAPI(page);
  await page.route("**/api/chat/models", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await visit(page, "homelab");
  await page.locator("#comm-toggle").click();
  await page.locator("#model-toggle").click();
  await expect(page.locator("#model-retry")).toBeVisible();
  await expect(page.locator("#model-options [role=option]")).toHaveCount(0);
  await expect(page.locator("#model-name")).toHaveText("Service default");
  await page.unroute("**/api/chat/models");
  await page.locator("#model-retry").click();
  await expect(page.locator("#model-options [role=option]")).toHaveCount(2);
});

test("live readings appear in orbit and in the instrument bar", async ({ page }) => {
  await mockAPI(page);
  await page.goto("/");
  await expect(page.locator("#launch")).toBeEnabled();
  await page.locator("#launch").click();
  // The bar carries price and a ticking time since the last block.
  await expect(page.locator("#btc-price")).toHaveText("$79,546");
  await expect(page.locator("#btc-since")).toHaveText(/^\d+:\d\d since block$/);

  await visit(page, "metrics");
  const live = page.locator("#station-body .orbit-live");
  await expect(live).toBeVisible();
  // Labels are uppercased by CSS; the DOM text is title case.
  await expect(live).toContainText("Flights · 24h");
  await expect(live).toContainText("119");
  // The planet shows the funnel: arrived, launched, read, left for the CV.
  await expect(live).toContainText("Dossiers read · 24h");
  await expect(live).toContainText("74");
  await expect(live).toContainText("Resume opened · 24h");
  // The readings row must be inside the console, not clipped below its fold.
  const body = await page.locator("#station-body").boundingBox();
  const strip = await live.boundingBox();
  expect(strip.y + strip.height).toBeLessThanOrEqual(body.y + body.height + 1);
  await page.locator("#station-undock").click();

  // The desk publishes counts only. No title, company or status anywhere.
  await visit(page, "scout");
  const desk = page.locator("#station-body .orbit-live");
  await expect(desk).toContainText("251");
  await expect(desk).toContainText("Roles tracked");
  const orbitText = await page.locator("#station-body").innerText();
  for (const leak of ["applied", "triaged", "salary"])
    expect(orbitText.toLowerCase()).not.toContain(leak);
});

test("one flight spans destination changes and repeated touch steering", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockAPI(page);
  const events = [];
  await page.route("**/api/telemetry", async (route) => {
    events.push(route.request().postDataJSON().event);
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await page.locator("#launch").click();
  for (const id of ["metrics", "bitcoin"]) {
    await visit(page, id);
    await page.locator("#station-undock").click();
  }
  if (testInfo.project.name === "phone") {
    await page.locator("#joystick").tap();
    await page.locator("#joystick").tap();
  }
  expect(events.filter((event) => event === "play")).toHaveLength(1);
});

async function clearOf(page, a, b) {
  const x = await page.locator(a).boundingBox();
  const y = await page.locator(b).boundingBox();
  expect(x, a).not.toBeNull();
  expect(y, b).not.toBeNull();
  const overlaps = x.x < y.x + y.width && x.x + x.width > y.x && x.y < y.y + y.height && x.y + x.height > y.y;
  expect(overlaps, `${a} overlaps ${b}`).toBe(false);
}

test("relay opens on demand and phone controls and Bitcoin clock stay clear", async ({ page }, testInfo) => {
  await mockAPI(page);
  await page.route("**/api/relay", (route) => route.fulfill({ json: { ready: true } }));
  await page.goto("/");
  await page.locator("#launch").click();
  await expect(page.locator("#relay-toggle")).toBeVisible();
  await expect(page.locator("#relay-panel")).toBeHidden();
  if (testInfo.project.name === "phone") {
    for (const control of ["#joystick", "#touch-boost"]) {
      await clearOf(page, control, "#console-toggle");
      await clearOf(page, control, "#relay-toggle");
    }
  }
  await page.locator("#relay-toggle").click();
  await expect(page.locator("#relay-panel")).toBeVisible();
  if (testInfo.project.name === "phone") {
    for (const control of ["#joystick", "#touch-boost", "#console-toggle"])
      await clearOf(page, control, "#relay-panel");
  }
  await page.locator("#relay-close").click();
  await expect(page.locator("#relay-panel")).toBeHidden();
  await page.locator("#console-toggle").click();
  const clock = await page.locator("#btc-since").boundingBox();
  const width = page.viewportSize().width;
  expect(clock.x + clock.width).toBeLessThanOrEqual(width);
  if (testInfo.project.name === "phone") {
    await clearOf(page, "#console-toggle", "#touch-boost");
    await clearOf(page, "#console-toggle", "footer.cockpit");
    await clearOf(page, "#console-toggle", "#instruments-toggle");
    for (const control of ["#joystick", "#touch-boost"]) {
      for (const button of await page.locator(".cockpit-actions button:visible").all()) {
        await clearOf(page, control, `#${await button.getAttribute("id")}`);
      }
    }
  }
});

test("orbit readings refresh, recover, tick and stop fetching after departure", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await mockAPI(page);
  let reads = 0;
  await page.route("**/api/insight/lab", (route) => {
    reads++;
    return route.fulfill(reads === 2
      ? { status: 502, json: { error: "unavailable" } }
      : { json: { nodes: reads === 1 ? 4 : 5, pods: null, cores: 0, namespaces: 63 } });
  });
  await page.goto("/");
  await page.locator("#launch").click();
  await visit(page, "lab-grafana");
  const live = page.locator(".orbit-live");
  await expect(live).toContainText("Received");
  await expect(live.locator("dd")).toHaveText(["4", "—", "0", "63"]);
  await page.clock.fastForward(31_000);
  await expect(live).toContainText("Readings unavailable");
  await expect(live).toHaveClass(/stale/);
  await page.clock.fastForward(31_000);
  await expect(live.locator("dd")).toHaveText(["5", "—", "0", "63"]);
  await expect(live).not.toHaveClass(/stale/);
  await visit(page, "bitcoin");
  const clock = live.locator("dd").nth(2);
  await expect(clock).toHaveText(/^\d+:\d\d$/);
  const before = await clock.textContent();
  await page.clock.fastForward(2_000);
  await expect(clock).not.toHaveText(before);
  await visit(page, "resume");
  await page.locator("#station-undock").click();
  await expect(page.locator("#nearby")).toBeHidden();
  await page.clock.fastForward(31_000);
  expect(reads).toBe(3);
});

test("a delayed reading cannot populate another orbit", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockAPI(page);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/insight/lab", async (route) => {
    await pending;
    await route.fulfill({ json: { nodes: 999, pods: 999, cores: 999, namespaces: 999 } }).catch(() => {});
  });
  await page.goto("/");
  await page.locator("#launch").click();
  await visit(page, "lab-grafana");
  await expect(page.locator(".orbit-live")).toContainText("Connecting");
  await visit(page, "scout");
  await expect(page.locator(".orbit-live")).toContainText("251");
  release();
  await expect(page.locator(".orbit-live")).not.toContainText("999");
  await expect(page.locator(".orbit-live")).toContainText("Roles tracked");
});


test("Take the controls sends one visitor ping without delaying flight or firing on chart navigation", async ({ page }) => {
  await mockAPI(page);
  const launches = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route("**/api/launch", async route => {
    launches.push(route.request().postDataJSON());
    await pending;
    await route.fulfill({ status: 503, json: { error: "Relay dark." } });
  });
  await page.goto("/", { referer: "https://example.org/private?token=secret" });
  await expect(page.locator(".launch-notice")).toBeVisible();
  await page.locator("#launch").click();
  await expect(page.locator("body")).toHaveClass(/flying/);
  await expect.poll(() => launches.length).toBe(1);
  expect(launches[0].session.referrer).toBe("https://example.org");
  expect(launches[0].session.viewportWidth).toBe(page.viewportSize().width);
  expect(launches[0].visitor).toMatch(/^[a-zA-Z0-9_-]{8,64}$/);
  release();
  await visit(page, "homelab");
  expect(launches).toHaveLength(1);
  await page.goto("/");
  await page.locator("#map-toggle").click();
  await page.locator('#chart-destinations [data-id="resume"]').click();
  await expect(page.locator("#dossier")).toBeVisible();
  expect(launches).toHaveLength(1);
});


test("only the launch button enters exploration; canvas, keys and chart stay in preview", async ({ page }) => {
  await mockAPI(page);
  const launches = [], plays = [];
  await page.route("**/api/launch", route => { launches.push(route.request().postDataJSON()); return route.fulfill({json:{ok:true}}); });
  await page.route("**/api/telemetry", route => { const event = route.request().postDataJSON().event; if (event === "play") plays.push(event); return route.fulfill({status:204}); });
  await page.goto("/");
  await expect(page.locator("#intro-flight-state")).toContainText("Ready for flight");
  // A readiness indicator that says "Ready for flight" must never sit above a
  // dead button. A slow world build used to trip the 8s fallback timeout while
  // the scene was still coming up: the page went to chart mode, onReady still
  // enabled the button, and start() then returned early on `fallback`.
  await expect(page.locator("body")).not.toHaveClass(/chart-mode/);
  const { width, height } = page.viewportSize();
  for (const [x, y] of [[0.5,0.35],[0.5,0.45],[0.85,0.2]]) {
    await page.mouse.click(width*x,height*y);
    await expect(page.locator("#intro")).toBeVisible();
  }
  await page.locator("#intro-title").click();
  for (const key of ["w", "a", "ArrowUp", "Space", "Escape"]) await page.keyboard.press(key);
  await expect(page.locator("body")).not.toHaveClass(/flying/);
  await page.locator("#map-toggle").click();
  await page.locator('#chart-destinations [data-id="resume"]').click();
  await expect(page.locator("#dossier")).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/flying/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#dossier")).toBeHidden();
  await expect(page.locator("#map-toggle")).toBeFocused();
  expect(launches).toHaveLength(0);
  expect(plays).toHaveLength(0);
  await page.locator("#launch").focus();
  await expect(page.locator("#launch")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveClass(/flying/);
  await expect.poll(() => launches.length).toBe(1);
  await expect.poll(() => plays.length).toBe(1);
  await visit(page, "homelab");
  await expect(page.locator("#station")).toBeVisible();
});

test("phone controls: boost left, stick right, and Enter orbit is never covered", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "touch layout");
  await mockAPI(page);
  await page.goto("/");
  await page.locator("#launch").click();
  await expect(page.locator("#touch-boost")).toBeVisible();

  // Steering on the right, boost on the left.
  const stick = await page.locator("#joystick").boundingBox();
  const boost = await page.locator("#touch-boost").boundingBox();
  expect(boost.x + boost.width).toBeLessThanOrEqual(stick.x);
  expect(stick.x).toBeGreaterThan(page.viewportSize().width / 2);

  // Holding boost engages it and releasing lets go.
  await page.locator("#touch-boost").dispatchEvent("pointerdown", { pointerId: 1, isPrimary: true });
  await expect(page.locator("#touch-boost")).toHaveClass(/held/);
  await page.locator("#touch-boost").dispatchEvent("pointerup", { pointerId: 1, isPrimary: true });
  await expect(page.locator("#touch-boost")).not.toHaveClass(/held/);

  // The prompt only shows within docking range, and the running world rewrites
  // its hidden flag every frame, so assert the layout contract instead. This
  // was a stacking bug: the Console toggle has the higher z-index, and with the
  // instrument bar open it sits exactly where the prompt does.
  const contract = await page.evaluate(() => {
    const approach = document.querySelector("#approach");
    const toggle = document.querySelector("#console-toggle");
    const read = () => ({
      approachZ: Number(getComputedStyle(approach).zIndex),
      toggleZ: Number(getComputedStyle(toggle).zIndex),
      toggleOpacity: getComputedStyle(toggle).opacity,
      toggleEvents: getComputedStyle(toggle).pointerEvents,
    });
    document.body.classList.add("approaching");
    const near = read();
    document.body.classList.add("instruments-open");
    const nearWithInstruments = read();
    document.body.classList.remove("approaching", "instruments-open");
    return { near, nearWithInstruments, away: read() };
  });
  // The prompt always paints above the toggle.
  expect(contract.near.approachZ).toBeGreaterThan(contract.near.toggleZ);
  // And the toggle steps aside while a body is in range, instruments or not.
  expect(contract.near.toggleOpacity).toBe("0");
  expect(contract.near.toggleEvents).toBe("none");
  expect(contract.nearWithInstruments.toggleOpacity).toBe("0");
  // Away from a body it comes back.
  expect(contract.away.toggleOpacity).toBe("1");
});


test("orbit focus stays clear of the console, notes and COMM", async ({ page }) => {
  await mockAPI(page);
  await page.goto("/");
  await visit(page, "homelab");
  await expect.poll(async () => {
    const ring = await page.locator("#orbit-reticle i").boundingBox();
    const panel = await page.locator("#station").boundingBox();
    return ring.y + ring.height < panel.y;
  }).toBe(true);
  for (const [toggle, panel] of [["#station-notes", "#orbit-notes"], ["#comm-toggle", "#comm-hud"]]) {
    await page.locator(toggle).click();
    await expect(page.locator(panel)).toBeVisible();
    await expect.poll(async () => {
      const a = await page.locator("#orbit-reticle i").boundingBox();
      const b = await page.locator(panel).boundingBox();
      return a.x + a.width < b.x || a.x > b.x + b.width || a.y + a.height < b.y;
    }).toBe(true);
    await expect(page.locator("dialog:modal")).toHaveCount(0);
  }
});

test("phone COMM gives the transcript room and keeps its composer above the keyboard", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "Phone viewport contract");
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    viewport.height = innerHeight;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { value: viewport });
  });
  await mockAPI(page);
  await page.goto("/");
  await visit(page, "homelab");
  await page.locator("#comm-toggle").click();
  const panel = page.locator("#comm-hud");
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox()).height).toBeGreaterThan(580);
  expect((await page.locator("#comm-log").boundingBox()).height).toBeGreaterThan(220);
  await expect(page.locator("#comm-input")).not.toBeFocused();
  expect(await panel.evaluate(el => getComputedStyle(el).backgroundColor)).toContain("0.8");
  await page.locator("#comm-input").fill("What runs here?");
  await page.evaluate(() => {
    visualViewport.height = 390;
    visualViewport.offsetTop = 40;
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(panel).toHaveClass(/comm-keyboard/);
  const send = await page.locator("#comm-send").boundingBox();
  expect(send.y + send.height).toBeLessThan(430);
  expect((await page.locator("#comm-log").boundingBox()).height).toBeGreaterThan(100);
  await page.evaluate(() => {
    visualViewport.height = innerHeight;
    visualViewport.offsetTop = 0;
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(panel).not.toHaveClass(/comm-keyboard/);
  expect((await panel.boundingBox()).height).toBeGreaterThan(580);
  await expect(page.locator("dialog:modal")).toHaveCount(0);
});

test("the cluster schematic draws one machine per node and marks a silent one", async ({ page }) => {
  await mockAPI(page);
  await page.goto("/");
  await visit(page, "talos");
  const cards = page.locator(".node-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("worker-01");
  await expect(cards.nth(0)).toContainText("108 pods");
  await expect(cards.nth(0)).toContainText("19%");
  await expect(cards.nth(0)).toContainText("12/33 GB");
  await expect(cards.nth(0)).toHaveAttribute("data-state", "ready");

  // The machine the cluster lists but nothing reports for must not read as an
  // idle one: no invented 0%, and visibly a different state.
  const silent = cards.nth(2);
  await expect(silent).toHaveAttribute("data-state", "unknown");
  await expect(silent).toContainText("silent");
  await expect(silent).not.toContainText("0%");
  const fills = await silent.locator(".node-meter i span").evaluateAll((els) =>
    els.map((el) => el.style.width),
  );
  expect(fills.every((width) => width === "0%")).toBe(true);
});

test("nearby signals read while flying past and step aside in orbit", async ({ page }) => {
  await mockAPI(page);
  const insight = [];
  await page.route("**/api/insight/**", async (route) => {
    insight.push(new URL(route.request().url()).pathname);
    await route.fallback();
  });
  await page.goto("/");
  await page.locator("#launch").click();
  const nearby = page.locator("#nearby");
  await expect(nearby).toBeHidden();

  // Assisted flight to a body that emits: the scanner picks it up on approach,
  // before there is any question of entering orbit.
  await page.locator("#map-toggle").click();
  await page.locator('#chart-destinations [data-id="bitcoin"]').click();
  await expect(nearby).toBeVisible({ timeout: 25000 });
  await expect(page.locator("#nearby-rows div")).not.toHaveCount(0);
  await expect(page.locator("#nearby-name")).not.toBeEmpty();

  // The orbit panel is the expanded view; the scanner does not compete with it.
  await expect(page.locator("#station")).toBeVisible({ timeout: 25000 });
  await expect(nearby).toBeHidden();

  // Readings are cached and refreshed on a timer, never per frame.
  expect(insight.length).toBeLessThan(6);
});

test("nearby signals never cover the flight controls on a phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "touch layout");
  await mockAPI(page);
  await page.goto("/");
  await page.locator("#launch").click();
  await page.locator("#map-toggle").click();
  await page.locator('#chart-destinations [data-id="bitcoin"]').click();
  await expect(page.locator("#nearby")).toBeVisible({ timeout: 25000 });
  const panel = await page.locator("#nearby").boundingBox();
  for (const selector of ["#joystick", "#touch-boost", "#console-toggle"]) {
    const control = await page.locator(selector).boundingBox();
    if (!control) continue;
    expect(panel.y + panel.height, `${selector} overlaps the scanner`).toBeLessThanOrEqual(control.y);
  }
  // And the Enter orbit prompt, whose place at the bottom is reserved.
  // The prompt is hidden until a body is in range, and the running world
  // rewrites that flag every frame, so measure where it will be rather than
  // waiting to be near something.
  const approachTop = await page.evaluate(() => {
    const approach = document.querySelector("#approach");
    const wasHidden = approach.hidden;
    approach.hidden = false;
    document.body.classList.add("approaching");
    const box = approach.getBoundingClientRect();
    document.body.classList.remove("approaching");
    approach.hidden = wasHidden;
    return box.top;
  });
  expect(panel.y + panel.height).toBeLessThanOrEqual(approachTop);
});


test("cluster inventory loss explains the empty instrument", async ({ page }) => {
  await mockAPI(page);
  await page.route("**/api/insight/nodes", route => route.fulfill({ json: { nodes: [] } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await visit(page, "talos");
  await expect(page.locator(".orbit-live")).toContainText("The cluster is not reporting right now.");
  await expect(page.locator(".node-card")).toHaveCount(0);
});

test("node cards show explicit readiness, capacity and valid zero readings", async ({ page }) => {
  await mockAPI(page);
  await page.route("**/api/insight/nodes", route => route.fulfill({ json: { nodes: [
    { name: "node-a", ready: false, cores: 8, cpu: 0, memoryUsed: 0, memoryTotal: 32e9, pods: 0 },
    { name: "node-b", ready: null, cores: 4, cpu: null, memoryUsed: null, memoryTotal: null, pods: null },
  ] } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await visit(page, "talos");
  const first = page.locator(".node-card").first();
  await expect(first).toHaveAttribute("data-state", "not-ready");
  await expect(first).toContainText("Not ready · 8 cores");
  await expect(first).toContainText("0 pods");
  await expect(first).toContainText("0%");
  await expect(page.locator(".node-card").last()).toContainText("Readiness unknown");
});

test("reopening an orbit keeps the original cached reading age", async ({ page }) => {
  await mockAPI(page);
  let reads = 0;
  await page.route("**/api/insight/lab", async route => { reads++; await route.fallback(); });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await visit(page, "lab-grafana");
  await expect(page.locator(".orbit-live")).toContainText("Received");
  await page.clock.setFixedTime(new Date(Date.now() + 10000));
  await visit(page, "lab-grafana");
  await expect(page.locator(".orbit-live .live-freshness")).toContainText(/Received 1\ds ago/);
  expect(reads).toBe(1);
});


test("node list stays scrolled and keyboard-focused while freshness updates", async ({ page }) => {
  await mockAPI(page);
  await page.route("**/api/insight/nodes", route => route.fulfill({ json: { nodes: Array.from({ length: 8 }, (_, i) => (
    { name: `node-${i}`, ready: true, cores: 8, cpu: 0.2, memoryUsed: 8e9, memoryTotal: 32e9, pods: 2 }
  )) } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await visit(page, "talos");
  const grid = page.locator(".node-grid");
  await grid.focus();
  await grid.press("End");
  await expect.poll(() => grid.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator(".orbit-live .live-freshness")).toContainText(/Received [2-9]s ago/);
  expect(await grid.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await expect(grid).toBeFocused();
});

test("an answer is never labelled with a model that is not one", async ({ page }) => {
  await mockAPI(page);
  // The catalog is slow, the visitor is not: they open COMM and ask before the
  // model list has arrived. The chip reads "Service default" meanwhile, which
  // describes the picker — stamping it on the reply would name the answer
  // after something that is not a model.
  let releaseModels;
  const held = new Promise((resolve) => { releaseModels = resolve; });
  await page.route("**/api/chat/models", async (route) => {
    await held;
    await route.fulfill({ json: { defaultModel: "chat-small", models: [{ id: "chat-small", name: "Small" }] } }).catch(() => {});
  });
  await page.goto("/");
  await visit(page, "homelab");
  await page.locator("#comm-toggle").click();
  await expect(page.locator("#model-name")).toHaveText("Service default");
  await page.locator("#comm-input").fill("What runs here?");
  await page.locator("#comm-input").press("Enter");
  const header = page.locator(".comm-message.assistant .comm-author").first();
  await expect(header).toHaveText("ORBIT ASSISTANT");

  // Once the catalog lands, the model that answers is named.
  releaseModels();
  await expect(page.locator("#model-name")).toHaveText("Small");
  await page.locator("#comm-input").fill("And what about storage?");
  await page.locator("#comm-input").press("Enter");
  await expect(page.locator(".comm-message.assistant .comm-author").last()).toHaveText("ORBIT ASSISTANT · Small");
});

async function watchContact(page, offline = false) {
  await mockAPI(page);
  await page.route('**/api/insight/watch', route => route.fulfill({
    status: offline ? 503 : 200,
    json: offline ? { error: 'Unavailable' } : { monitors: 88, up: 77, down: 11, uptime30d: 0.9928, responseMs: 18, certDays: 40 },
  }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await visit(page, 'watchtower');
  await page.locator('#station-undock').click();
  await expect(page.locator('#nearby')).toBeVisible();
  await expect(page.locator('#nearby-name')).toHaveText('Uptime watch');
}

test('holotable expansion is explicit and Escape stows it before other flight actions', async ({ page }) => {
  await watchContact(page);
  const panel = page.locator('#nearby');
  await expect(panel).toHaveAttribute('data-state', 'contact');
  await expect(page.locator('#nearby-rows')).toContainText('77/88');
  await expect(page.locator('#nearby-rows')).toContainText('99.3%');
  await page.keyboard.press('f');
  await expect(panel).toHaveAttribute('data-state', 'locked');
  await expect(page.locator('#nearby-rows > div')).toHaveCount(4);
  await expect(page.locator('#nearby-toggle')).toHaveAttribute('aria-expanded', 'true');
  const toast = await page.locator('#toast').textContent();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveAttribute('data-state', 'contact');
  await expect(page.locator('#toast')).toHaveText(toast);
  await page.locator('#nearby-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveAttribute('data-state', 'locked');
});

test('holotable stows on thrust, brake and boost, including a held input', async ({ page }) => {
  await watchContact(page);
  const panel = page.locator('#nearby');
  for (const key of ['w', 's', 'Space']) {
    await page.keyboard.press('f');
    await expect(panel).toHaveAttribute('data-state', 'locked');
    await page.keyboard.down(key);
    await expect(panel).toHaveAttribute('data-state', 'contact');
    await page.keyboard.press('f');
    await expect(panel).toHaveAttribute('data-state', 'contact');
    await page.keyboard.up(key);
    await page.waitForTimeout(100);
  }
});

test('holotable stays collapsed outside free flight and ignores text entry', async ({ page }) => {
  await watchContact(page);
  const panel = page.locator('#nearby');
  for (const mode of ['in-orbit', 'notes-open', 'chart-mode', 'survey-view']) {
    await page.keyboard.press('f');
    await expect(panel).toHaveAttribute('data-state', 'locked');
    await page.evaluate(mode => document.body.classList.add(mode), mode);
    await expect(panel).toBeHidden();
    await expect(panel).toHaveAttribute('data-state', 'contact');
    await page.keyboard.press('f');
    await expect(panel).toHaveAttribute('data-state', 'contact');
    await page.evaluate(mode => document.body.classList.remove(mode), mode);
    await expect(panel).toBeVisible();
  }
  await page.locator('#map-toggle').click();
  await expect(panel).toBeHidden();
  await page.keyboard.press('f');
  await expect(panel).toHaveAttribute('data-state', 'contact');
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'scanner-typing';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press('f');
  await expect(page.locator('#scanner-typing')).toHaveValue('f');
  await expect(panel).toHaveAttribute('data-state', 'contact');
});

test('holotable bearing is labelled and reduced motion keeps the sweep still', async ({ page }, testInfo) => {
  await watchContact(page);
  await page.keyboard.press('f');
  const ring = page.locator('#nearby-bearing');
  if (testInfo.project.name === 'phone') {
    await expect(ring).toBeHidden();
  } else {
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute('aria-label', /Uptime watch, range [\d.]+, bearing /);
    await expect(page.locator('#nearby-blips .selected')).toHaveCount(1);
    await expect(page.locator('.bearing-sweep')).toHaveCSS('animation-name', 'none');
  }
});

test('holotable on a phone stays above every flight control and stows on touch boost', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch layout');
  await watchContact(page);
  await page.locator('#nearby-toggle').click();
  const panel = page.locator('#nearby');
  await expect(panel).toHaveAttribute('data-state', 'locked');
  const box = await panel.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height / 2);
  for (const selector of ['#joystick', '#touch-boost', '#console-toggle']) {
    const control = await page.locator(selector).boundingBox();
    expect(control).not.toBeNull();
    expect(box.y + box.height, selector).toBeLessThanOrEqual(control.y);
  }
  const approachTop = await page.evaluate(() => {
    const approach = document.querySelector('#approach');
    const hidden = approach.hidden;
    approach.hidden = false;
    document.body.classList.add('approaching');
    const top = approach.getBoundingClientRect().top;
    document.body.classList.remove('approaching');
    approach.hidden = hidden;
    return top;
  });
  expect(box.y + box.height).toBeLessThanOrEqual(approachTop);
  const boost = await page.locator('#touch-boost').boundingBox();
  await page.mouse.move(boost.x + boost.width / 2, boost.y + boost.height / 2);
  await page.mouse.down();
  await expect(panel).toHaveAttribute('data-state', 'contact');
  await page.mouse.up();
});

test('a lost holotable signal stays visibly unavailable', async ({ page }) => {
  await watchContact(page, true);
  await page.keyboard.press('f');
  await expect(page.locator('#nearby')).toHaveClass(/stale/);
  await expect(page.locator('#nearby-freshness')).toHaveText('Signal lost.');
  await expect(page.locator('#nearby-rows')).not.toContainText('0');
  await expect(page.locator('.bearing-sweep')).toHaveCSS('animation-name', 'none');
});

test('holotable cannot expand before launch or without WebGL', async ({ page }) => {
  await mockAPI(page);
  await page.goto('/');
  await page.keyboard.press('f');
  await expect(page.locator('#nearby')).toBeHidden();
  await expect(page.locator('#nearby')).toHaveAttribute('data-state', 'contact');
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.includes('webgl') ? null : getContext.call(this, type, ...args);
    };
  });
  await page.reload();
  await expect(page.locator('#fallback')).toBeVisible();
  await page.keyboard.press('f');
  await expect(page.locator('#nearby')).toBeHidden();
  await expect(page.locator('#nearby')).toHaveAttribute('data-state', 'contact');
});
