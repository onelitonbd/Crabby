# M0 probes

Seven throwaway programs that answer the seven questions `docs/ROADMAP.md` §2 says must be answered before any real
code is written. They are not tests: a test asks whether code the project wrote behaves, a probe asks whether an
**assumption the project inherited** behaves, on the machine that will actually run it.

```bash
npm run probe            # all seven, one verdict table
npm run probe:p3         # just one, while you are iterating on it
npm run probe:p3 -- --json  # the same run as one machine-readable line
node probes/to-results.mjs  # rewrite probes/RESULTS.md's measured block from probes/out/*.json
npm run test:termux      # run the whole set on the phone and print the copy-paste checklist
```

## The contract, which is the whole point

`probes/lib.mjs` is small because its rules are load-bearing, not because it is finished.

| outcome | exit code | when |
| --- | --- | --- |
| `pass` | 0 | every check measured something and held |
| `fail` | 1 | a check measured something and it did not hold — the plan's assumption is wrong, which is a result |
| `blocked` | 2 | a precondition was missing: no toolchain, no device, no network for Node headers. **Never reported as a pass, and never a failure either** |

Three consequences, all enforced in code:

- a probe that cannot start does not exit 0. The first draft of P3 printed ✓ next to "source build succeeded" when npm
  had in fact taken a bundled prebuild and compiled nothing — a check may only be named for what it measured;
- every probe prints its environment line, and outside Termux it adds `this proves the probe, not the assumption`.
  A laptop green table is not M0 progress — see the device column in `probes/RESULTS.md`;
- `probes/manual()` steps are part of the record. A probe whose automated half passes has not passed while a
  device-only question in the same row sits unanswered.

## Where the scratch goes, and why it is not in the manifest

`ensureDep()` installs into `probes/.deps/` (`--no-save`, no lockfile) and stages child scripts *inside* it, because ESM
resolves bare specifiers from the importing file's directory upward. That keeps `better-sqlite3`, `fastify`, `ink` and
`react` out of the product's `package.json`: M0 is allowed to prove things about a dependency without adopting it.
`probes/.deps/` and `probes/out/` are gitignored; `tests/unit/m0.test.ts` asserts that they stay that way, and that no
`engines` field appeared in the manifest before P1 produced a device number (D-070).

## Adding a probe

Name it after the roadmap row (`p8.mjs` for the next one), and keep these four lines:

```js
const probe = new Probe("P8", "one sentence that says what is being measured");
probe.check("a claim with a number or a byte count in it", measured === expected, `${measured} vs ${expected}`);
probe.manual("the half only a person on the phone can answer", "the exact command to run there");
report(probe, parseArgs());
```

Then add the id to `ALL` in `probes/run.mjs`, a `probe:p8` script, and a row in `probes/RESULTS.md`'s checklist — the
unit test fails if those drift apart, and `docs/ROADMAP.md` §2 stays the place the pass conditions are written down.
A check's name should read like a claim about the product, not like an assertion about the fixture: the sentence is what
ends up in `DECISIONS.md` when the number contradicts it.
