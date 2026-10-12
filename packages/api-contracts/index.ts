// The shared shape of Crabby: what a task is, what an event looks like, what an error must carry, and what number a
// process exits with. Nothing in here knows about Fastify, SQLite, Ink or Telegram — that is the point, because four
// interfaces plus a CLI have to agree on these bytes before any of them exists.
import "./formats.ts";

export { type Static, Type } from "@sinclair/typebox";
export { Value } from "@sinclair/typebox/value";
export * from "./approvals.ts";
export * from "./checkpoint.ts";
export * from "./clients.ts";
export * from "./error.ts";
export * from "./events.ts";
export * from "./exit-codes.ts";
export * from "./formats.ts";
export * from "./ids.ts";
export * from "./job.ts";
export * from "./task.ts";
export * from "./tools.ts";
export * from "./validate.ts";
