import { createMetricsProxy } from "./src/metrics-proxy.mjs";

const port = Number(process.env.PORT || 8080);

createMetricsProxy().listen(port, () => {
  console.log(JSON.stringify({ event: "start", service: "metrics-proxy", port }));
});
