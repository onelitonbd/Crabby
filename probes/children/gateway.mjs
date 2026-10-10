// P2's subject: the smallest thing that exercises the two claims D-069 made about Fastify — that a Gateway can bind
// loopback on Termux, and that `reply.hijack()` is a workable SSE channel. Prints `READY <port>` and keeps serving.
import Fastify from "fastify";

const port = Number(process.env.PROBE_PORT ?? 0);
const app = Fastify({ logger: false });

app.get("/health", async () => ({ ok: true, pid: process.pid, node: process.version }));

app.get("/events", (req, reply) => {
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  let n = 0;
  const total = Number(process.env.PROBE_EVENTS ?? 5);
  const tick = setInterval(() => {
    n += 1;
    raw.write(`id: ${n}\nevent: message\ndata: {"seq":${n},"text":"chunk ${n}"}\n\n`);
    if (n >= total) {
      clearInterval(tick);
      raw.end();
    }
  }, 40);
  req.raw.on("close", () => clearInterval(tick));
});

const server = app.listen({ host: "127.0.0.1", port });
server.then((address) => {
  console.log(`READY ${String(address).split(":").pop()}`);
});
server.catch((err) => {
  console.error(`LISTEN_FAILED ${err.message}`);
  process.exit(1);
});
