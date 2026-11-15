import { createAiProxy } from "./src/ai-proxy.mjs";

const port = Number(process.env.PORT || 8080);

createAiProxy().listen(port, () => {
  console.log(JSON.stringify({ event: "start", service: "ai-proxy", port }));
});
