// `crabby vault` — §7's one-command surface for secrets: set (and rotate by setting again), get (the owner's own
// terminal, the one surface that shows a value), list (names only), delete (§7's revocation), lock/unlock and
// status (§7's "lock state is visible", answered locally and from the running Gateway when there is one).
//
// Two rules shape every verb. **A secret never rides argv**: the passphrase and the value are read from stdin —
// muted prompts on a TTY, plain lines on a pipe — because a process list is a serializer this file does not
// control. And **the weaker-store sentence travels with the file store**: the first `set` on a passphrase
// platform prints what the protection is and is not (§7's disclosure obligation), so the user knows which they
// have rather than inferring it from silence.

import { createInterface } from "node:readline";
import { EXIT, type ExitCode } from "@crabby/api-contracts";
import type { DataLayout } from "@crabby/platform";
import { FILE_STORE_DISCLOSURE, openVault, type Vault } from "@crabby/vault";
import { connect, reportNoGateway } from "../connect.ts";
import type { Renderer } from "../output.ts";

const VERBS = ["status", "set", "get", "list", "delete", "unlock", "lock"] as const;

export async function runVault(
  verb: string,
  args: string[],
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  if (!(VERBS as readonly string[]).includes(verb)) {
    renderer.line("vault", `which verb? one of ${VERBS.join(", ")}`);
    return EXIT.usage;
  }
  const vault = openVault({ vaultDir: layout.vaultDir, platform: process.platform });

  switch (verb) {
    case "status":
      return status(vault, layout, renderer);
    case "set":
      return set(args, vault, renderer);
    case "get":
      return get(args, vault, renderer);
    case "list":
      return list(vault, renderer);
    case "delete":
      return remove(args, vault, renderer);
    case "unlock":
      return transition("unlock", args, vault, layout, renderer);
    case "lock":
      return transition("lock", args, vault, layout, renderer);
  }
  return EXIT.usage;
}

async function status(vault: Vault, layout: DataLayout, renderer: Renderer): Promise<ExitCode> {
  const local = vault.status();
  renderer.line("store", local.kind);
  renderer.line("state", local.state);
  if (local.names !== undefined) renderer.line("entries", String(local.names.length));
  if (local.note !== undefined) renderer.fix(local.note);
  // The Gateway's session is a *different* lock state from the file's: this process unlocked nothing the
  // Gateway shares. When one is running, its answer is the one the interfaces act on, so it prints beside.
  const connection = await connect(layout);
  if (connection.state === "paired") {
    const answer = await connection.client.request("/api/v1/vault");
    if (answer.ok) {
      const gateway = answer.body as { kind: string; state: string };
      renderer.line("gateway", `${connection.client.url} · ${gateway.state}`);
      if (gateway.state === "locked") {
        renderer.fix("crabby vault unlock hands the running Gateway the passphrase it is missing");
      }
    }
  }
  return renderer.done({
    store: local.kind,
    state: local.state,
    ...(local.entries === undefined ? {} : { entries: local.entries }),
    ...(local.names === undefined ? {} : { names: [...local.names] }),
  });
}

async function set(args: string[], vault: Vault, renderer: Renderer): Promise<ExitCode> {
  const name = args[0];
  if (name === undefined || name === "") {
    renderer.line(
      "vault set",
      "which name? `crabby vault set <name>` (rotates by setting the name again)",
    );
    return EXIT.usage;
  }
  const before = vault.status().state;
  const passphrase =
    vault.kind === "file"
      ? await readSecret(before === "unset" ? "new vault passphrase" : "vault passphrase")
      : undefined;
  const secret = await readSecret(`secret for ${name}`);
  if (passphrase === null || secret === null || secret === "") {
    renderer.line(
      "vault set",
      "a passphrase and a value are both required — empty stdin sets nothing",
    );
    return EXIT.usage;
  }
  const answer = vault.set(name, secret, passphrase ?? undefined);
  if (!answer.ok) {
    renderer.fail({ code: "vault_set_refused", message: answer.reason });
    return EXIT.failure;
  }
  if (before === "unset" && vault.kind === "file") {
    // §7's disclosure, once, at the moment the weaker store is created — not buried in a doc page.
    renderer.fix(FILE_STORE_DISCLOSURE);
  }
  renderer.line(
    "vault set",
    `${name} ${before === "unset" ? "created the vault and" : ""} stored`.replace("  ", " "),
  );
  if (before !== "unset")
    renderer.line("rotate", "setting an existing name replaces its value — that was a rotation");
  renderer.line(
    "next",
    vault.kind === "file"
      ? "a running Gateway learns this name after `crabby vault unlock` (its session is still the old one)"
      : "a running Gateway picks this up on its next composition — `crabby gateway restart` to be sure",
  );
  return renderer.done({ name, rotated: before !== "unset" });
}

async function get(args: string[], vault: Vault, renderer: Renderer): Promise<ExitCode> {
  const name = args[0];
  if (name === undefined || name === "") {
    renderer.line("vault get", "which name? `crabby vault get <name>`");
    return EXIT.usage;
  }
  const passphrase = vault.kind === "file" ? await readSecret("vault passphrase") : undefined;
  if (passphrase === null) {
    renderer.line("vault get", "a passphrase is required");
    return EXIT.usage;
  }
  const answer = vault.get(name, passphrase ?? undefined);
  if (!answer.ok) {
    renderer.fail({ code: "vault_get_refused", message: answer.reason });
    return EXIT.failure;
  }
  // §7's stated asymmetry: the owner's own terminal is the one surface that does not scrub, because a value
  // they cannot see is a value they cannot paste where it belongs.
  renderer.raw(answer.secret);
  return renderer.done({ name, value: answer.secret });
}

async function list(vault: Vault, renderer: Renderer): Promise<ExitCode> {
  const passphrase = vault.kind === "file" ? await readSecret("vault passphrase") : undefined;
  if (passphrase === null) {
    renderer.line("vault list", "a passphrase is required");
    return EXIT.usage;
  }
  const answer = vault.list(passphrase ?? undefined);
  if (!answer.ok) {
    renderer.fail({ code: "vault_list_refused", message: answer.reason });
    return EXIT.failure;
  }
  for (const name of answer.names) renderer.line("entry", name);
  if (answer.names.length === 0)
    renderer.line("entries", "none — `crabby vault set <name>` stores the first");
  return renderer.done({ names: [...answer.names], count: answer.names.length });
}

async function remove(args: string[], vault: Vault, renderer: Renderer): Promise<ExitCode> {
  const name = args[0];
  if (name === undefined || name === "") {
    renderer.line(
      "vault delete",
      "which name? `crabby vault delete <name>` (§7's revocation is this command)",
    );
    return EXIT.usage;
  }
  const passphrase = vault.kind === "file" ? await readSecret("vault passphrase") : undefined;
  if (passphrase === null) {
    renderer.line("vault delete", "a passphrase is required");
    return EXIT.usage;
  }
  const answer = vault.delete(name, passphrase ?? undefined);
  if (!answer.ok) {
    renderer.fail({ code: "vault_delete_refused", message: answer.reason });
    return EXIT.failure;
  }
  renderer.line(
    "vault delete",
    `${name} removed — a provider entry that referenced it now refuses with that reason`,
  );
  return renderer.done({ name, removed: true });
}

/** Lock/unlock are the *Gateway session's* acts: the CLI's own copy of the file store dies with this process,
 *  so unlocking here would hand keys to nobody. The commands find the running Gateway and answer with what the
 *  re-composition decided (D-139), including the runner sentence when the process started locked. */
async function transition(
  action: "unlock" | "lock",
  _args: string[],
  vault: Vault,
  layout: DataLayout,
  renderer: Renderer,
): Promise<ExitCode> {
  if (vault.kind !== "file" && action === "unlock") {
    renderer.line("vault unlock", "a keychain store is never locked — nothing to unlock");
    return renderer.done({ state: "unlocked", note: "keychain" });
  }
  const connection = await connect(layout);
  if (connection.state !== "paired") return reportNoGateway(renderer, connection.state);
  const passphrase = action === "unlock" ? await readSecret("vault passphrase") : undefined;
  if (passphrase === null) {
    renderer.line("vault unlock", "a passphrase is required");
    return EXIT.usage;
  }
  const answer = await connection.client.request(`/api/v1/vault/${action}`, {
    method: "POST",
    ...(passphrase === undefined ? {} : { body: { passphrase } }),
  });
  if (!answer.ok) {
    const body = answer.body as { error?: { message?: string } };
    renderer.fail({
      code: `vault_${action}_refused`,
      message: body.error?.message ?? `the Gateway refused the ${action}`,
    });
    return EXIT.failure;
  }
  const body = answer.body as {
    state: string;
    providers: { composed: number; refused: { id: string; reason: string }[] };
    note?: string;
  };
  renderer.line("vault", body.state);
  renderer.line(
    "providers",
    `${body.providers.composed} composed, ${body.providers.refused.length} refused`,
  );
  for (const entry of body.providers.refused) renderer.line(`  ${entry.id}`, entry.reason);
  if (body.note !== undefined) renderer.fix(body.note);
  return renderer.done(body);
}

/** One secret, one line: muted prompt on a TTY (the terminal keeps the value off the scrollback), a plain line
 *  from stdin when piped — `crabby vault set groq < token-file` is the scripted path, and it needs no TTY. */
async function readSecret(prompt: string): Promise<string | null> {
  if (process.stdin.isTTY) {
    process.stderr.write(`${prompt}: `);
    const muted = new (await import("node:stream")).Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    const line = await new Promise<string>((resolve) => {
      rl.once("line", resolve);
    });
    rl.close();
    process.stderr.write("\n");
    return line;
  }
  // Piped: one lazy line per prompt, in order — `printf 'pass\nsecret\n' | crabby vault set groq` feeds the
  // passphrase first and the secret second, and a token file fed to `vault get` is its single line. The
  // interface is created once so two prompts in one command read two lines, not two reads of one buffer.
  lineReader ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const { value } = await lineReader.next();
  return typeof value === "string" && value.length > 0 ? value : null;
}

let lineReader: AsyncIterator<string> | undefined;
