// P4's subject: the Gateway serving the Web UI as files it reads at request time — no bundler, no framework, no
// static-plugin dependency, so the shipped thing is the source. Prints READY <port>.
import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";

const root = process.argv[2];
if (!root) {
  console.error("usage: web-gateway.mjs <dir>");
  process.exit(2);
}
const app = Fastify({ logger: false });

app.get("/health", async () => ({ ok: true }));

app.get("/", async (_req, reply) => {
  const bytes = await readFile(path.join(root, "index.html"));
  // no immutable, no long max-age: the browser must be able to see a rebuild (C-W5's refresh rule)
  reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-cache");
  return reply.send(bytes);
});

app.get("/app.css", async (_req, reply) => {
  reply.header("content-type", "text/css; charset=utf-8").header("cache-control", "no-cache");
  return reply.send(await readFile(path.join(root, "app.css")));
});

app.get("/app.js", async (_req, reply) => {
  reply
    .header("content-type", "text/javascript; charset=utf-8")
    .header("cache-control", "no-cache");
  return reply.send(await readFile(path.join(root, "app.js")));
});

const server = app.listen({ host: "127.0.0.1", port: 0 });
server.then((addr) => console.log(`READY ${String(addr).split(":").pop()}`));
server.catch((err) => {
  console.error(`LISTEN_FAILED ${err.message}`);
  process.exit(1);
});
