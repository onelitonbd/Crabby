// P6's subject: a process that must survive its parent and must flush when it is told to die. Android kills by
// signal, and a phone does it while the screen is off, so these two behaviours are the whole of what a shell can
// measure before anyone touches the device.
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const marker = process.argv[2];
const portFile = process.argv[3];
writeFileSync(marker, `up pid=${process.pid}\n`);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, pid: process.pid, since: started }));
});
const started = Date.now();
server.listen(0, "127.0.0.1", () => {
  writeFileSync(portFile, String(server.address().port));
  console.log(`READY ${server.address().port}`);
});

// the rule M-G has to keep: on SIGTERM stop accepting work, write what is pending, then exit 0 — never a stack
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    const ms = Date.now() - started;
    appendFileSync(marker, `${sig} after ${ms}ms — flushed pending writes\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
setInterval(() => appendFileSync(marker, "beat\n"), 400);
