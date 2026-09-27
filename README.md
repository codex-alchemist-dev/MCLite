# MCLite

A free, open-source, fully atomic database designed for Minecraft Bedrock,
built entirely on Bedrock's own dynamic-property storage - no server, no
external service, no dependencies. Dependency-free Node, consumed by
sibling projects via plain `require()` (matching MinUI's own convention),
not published to npm.

## Why

Bedrock's `setDynamicProperty`/`getDynamicProperty` API gives you raw
key-value storage and nothing else - no atomicity guarantee beyond a
single key, no schema, no indexes, no backup mechanism. Every non-trivial
Bedrock addon ends up re-inventing some version of "how do I store real
data safely" from scratch. MCLite is that piece, built once, generically,
so it doesn't need reinventing again.

## What "fully atomic" means here

Every write goes through a **copy-validate-commit** pattern with real
**A/B deployment slots**, directly modeled on how immutable-OS updates
(like Fedora Silverblue/OSTree) apply a system update: never patch the
live copy in place. A write is fully built and validated in memory first;
committed into whichever slot **isn't** currently live; read back and
re-verified as a real commit check, not an assumption; and only then does
one tiny pointer flip make it live. A reader can never observe a
half-applied write - it's always either the complete old record or the
complete new one. And because the previous generation is never deleted,
just superseded, instant rollback is "flip the pointer back," no
reconstruction needed.

On top of that, every record kind can register a **world-scoped mirror
write** - a second, independent physical copy - so losing a record needs
losing *two* copies in two different places, not one.

## What's in the box (everything a database needs, scoped to what a
Bedrock addon actually needs)

| Concept | Module | What it does |
|---|---|---|
| **Tables** | `recordStore.js` | Atomic per-id record storage (`registerRecordKind`, `readRecord`, `writeRecord`) - the A/B-slot engine described above, for any record shape. |
| **Primary keys** | `idRegistry.js` | UUID generation + a world-scoped id→owner registry. |
| **Indexes** | `perOwnerIndex.js` | A small per-owner list of record summaries, so listing/searching never means loading every full record. |
| **Relations** | `pairStore.js` | Order-independent pairwise relationships between two ids (e.g. a friendship/rivalry track), one tiny property per pair - no O(n²) blowup. |
| **Aggregates** | `counters.js` | Open-ended two-level counters (category → subject → number), plus a buffered write queue for hot gameplay events. |
| **Spatial references** | `blockLinks.js` | World-position → record-id links. |
| **Integrity check & repair** | `maintenance.js` | A `PRAGMA integrity_check`-equivalent scan (structural validity + mirror sync, plus any checks a record kind registers) with an optional repair pass. |
| **Backup & restore** | `transfer.js` | A record serializes to one self-checksummed text string that survives total loss of the world save; import verifies before writing anything. |
| **Checksums & raw I/O** | `dataCore.js` | The primitives everything above is built on. |

Everything is **pluggable per record kind** - MCLite has no idea what a
"character," "pet," or "shop" is. A consuming project registers its own
record shape, validator, index projection, relation tracks, and any extra
integrity checks; MCLite just guarantees the storage underneath all of it
is atomic and recoverable.

## Non-goals

MCLite protects against script-level logic bugs, interrupted writes, and
accidental corruption. It does **not** protect against a player deleting
their whole world file, or the underlying LevelDB database itself becoming
corrupted at the engine level - those sit beneath anything a Script API
can reach.

## Usage

```js
const mclite = require("mclite"); // or require("./src/index.js") pre-npm-publish

mclite.registerRecordKind("pet", {
  keyPrefix: "pet",
  validate: rec => typeof rec.name === "string" && mclite.verifyChecksum(rec),
});

mclite.writeRecord(player, world, "pet", petId, old => ({ ...old, name: "Rex" }));
const pet = mclite.readRecord(player, world, "pet", petId);
```

See `test/mclite.test.js` for a worked example of every module.

## Development

```bash
npm test   # runs test/mclite.test.js against a mock Player/world object
```

## Origin

Extracted and generalized from
[OpenChara](https://github.com/Cookiesmuch/OpenChara)'s `dataCore.js`
family - see "OpenRock Mod Packager — Phased Implementation Plan",
OR-Phase 4, for the extraction design. OpenChara is MCLite's first real
consumer, wired in as a library through
[OpenRock](https://github.com/Cookiesmuch/OpenRock).

## Contributing

Issues and PRs welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) for the
process and ground rules (no runtime dependencies, `node --check` and
`npm test` before opening a PR, small focused changes).

## License

[MIT](LICENSE).
