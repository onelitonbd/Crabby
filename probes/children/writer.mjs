// P3's subject: a writer that can be killed mid-transaction. Two drivers, same script, so the comparison in the plan
// ("compare against `node:sqlite` for the same case") is literally the same code path.
//   node writer.mjs --driver better|node --db <file> [--rows N] [--batch N]
const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}
const driver = flag("driver", "better");
const file = flag("db", "/tmp/crabby-p3.db");
const rows = Number(flag("rows", 20000));
const batch = Number(flag("batch", 100));

let db, insert, close;
if (driver === "better") {
  const { default: Database } = await import("better-sqlite3");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(
    "create table if not exists t (i integer primary key, payload text not null, checksum integer not null)",
  );
  const stmt = db.prepare("insert into t (i, payload, checksum) values (?, ?, ?)");
  insert = (from, to) => {
    const items = range(from, to);
    const runMany = db.transaction((rows) => {
      for (const it of rows) stmt.run(it.i, it.payload, it.checksum);
    });
    runMany(items);
  };
  close = () => db.close();
} else {
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(file);
  db.exec("pragma journal_mode = WAL");
  db.exec(
    "create table if not exists t (i integer primary key, payload text not null, checksum integer not null)",
  );
  const stmt = db.prepare("insert into t (i, payload, checksum) values (?, ?, ?)");
  insert = (from, to) => {
    db.exec("begin");
    for (const it of range(from, to)) stmt.run(it.i, it.payload, it.checksum);
    db.exec("commit");
  };
  close = () => db.close();
}

function range(from, to) {
  const out = [];
  for (let i = from; i < to; i++)
    out.push({ i, payload: `row ${i} ${"x".repeat(64)}`, checksum: i * 7919 });
  return out;
}

console.log("READY");
let written = 0;
while (written < rows) {
  const next = Math.min(written + batch, rows);
  insert(written, next);
  written = next;
  console.log(`WROTE ${written}`);
}
close();
console.log(`DONE ${written}`);
