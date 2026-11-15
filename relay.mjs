import { createNotifyRelay } from "./src/notify-relay.mjs";

const port = Number(process.env.PORT || 8080);

createNotifyRelay().listen(port, () => {
  console.log(JSON.stringify({ event: "start", service: "notify-relay", port }));
});
