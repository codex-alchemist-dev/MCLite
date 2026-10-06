# MCLite

A free, open-source, fully atomic database designed for Minecraft Bedrock,
built entirely on Bedrock's own dynamic-property storage - no server, no
external service, no dependencies. Dependency-free Node, consumed by
sibling projects via plain `require()` (matching MinUI's own convention),
not published to npm.

A [Codex Alchemist](https://github.com/codex-alchemist-dev) project, under
Fireball Everything. See [AUTHORS.md](AUTHORS.md) and
[CREDITS.md](CREDITS.md).

## Why

Bedrock's `setDynamicProperty`/`getDynamicProperty` API gives you raw
key-value storage and nothing else - no atomicity guarantee beyond a
single key, no schema, no indexes, no backup mechanism. Every non-trivial
Bedrock addon ends up re-inventing some version of "how do I store real
data safely" from scratch. MCLite is that piece, built once, generically,
so it doesn't need reinventing again.

## What "fully atomic" means here

Every write goes through a **copy-validate-commit** pattern with real
**deployments**, directly modeled on how Fedora Silverblue's OSTree
actually applies a system update: never patch the live copy in place. A
write is fully built and validated in memory first; committed into
whichever of the two deployments (`0`/`1`) **isn't** currently live; read
back and re-verified as a real commit check, not an assumption; and only
then does one tiny pointer (the "current deployment," OSTree's bootloader
entry) flip to make it live. A reader can never observe a half-applied
write - it's always either the complete old record or the complete new
one. And because the previous generation is never deleted, just
superseded, `rollback()` is "flip the pointer back," no reconstruction
needed - exactly OSTree's own rollback. `pin()`/`unpin()` mirror OSTree's
own pin: mark the currently-inactive deployment "don't overwrite on the
next write" until explicitly released. `status()` mirrors `ostree admin
status` - a read-only summary of which deployment is current, which (if
any) is pinned, and whether the mirror agrees with the primary.

On top of that, every record kind can register a **world-scoped mirror
write** - a second, independent physical copy - so losing a record needs
losing *two* copies in two different places, not one.

## What's in the box (everything a database needs, scoped to what a
Bedrock addon actually needs)

| Concept | Module | What it does |
|---|---|---|
| **Tables** | `recordStore.js` | Atomic per-id record storage (`registerRecordKind`, `readRecord`, `writeRecord`, `pin`, `unpin`, `rollback`, `status`) - the OSTree-style deployment engine described above, for any record shape. |
| **Primary keys** | `idRegistry.js` | UUID generation + a world-scoped id→owner registry. |
| **Indexes** | `perOwnerIndex.js` | A small per-owner list of record summaries, so listing/searching never means loading every full record. |
| **Relations** | `pairStore.js` | Order-independent pairwise relationships between two ids (e.g. a friendship/rivalry track), one tiny property per pair - no O(n²) blowup. |
| **Aggregates** | `counters.js` | Open-ended two-level counters (category → subject → number), plus a buffered write queue for hot gameplay events. |
| **Spatial references** | `blockLinks.js` | World-position → record-id links. |
| **Integrity check & repair** | `maintenance.js` | A `PRAGMA integrity_check`-equivalent scan (structural validity + mirror sync, plus any checks a record kind registers), with a structured pass/fail tally per named check, and an optional repair pass. |
| **Backup & restore** | `transfer.js` | A record serializes to one self-checksummed text string that survives total loss of the world save; import verifies before writing anything. |
| **Query & filter** | `query.js` | A `WHERE`-equivalent: a small declarative filter tree (`{field,op,value}`, `all`/`any`/`not`) over the cheap index summaries (`queryIndex`), or a predicate function over full records (`queryRecords`) - an honest full scan, no B-tree underneath it. |
| **VACUUM** | `vacuum.js` | Re-serializes every indexed record of a kind through a real write (dropping stale fields a validator no longer requires), plus finalizing `counters.js`'s buffered write queue. |
| **ATTACH** | `attach.js` | Joins a `pairStore.js` relationship with both sides' actual owner-scoped records in one call, resolving each id's owner via `idRegistry.js`. |
| **Full-text search** | `fulltext.js` | An opt-in inverted-index analog to FTS5 (`registerFulltextField`, `indexFulltextRecord`, `queryFulltext`) - AND-of-tokens matching only, no ranking/BM25/phrase queries. See the section below for why it's an *analog*, not FTS5 itself. |
| **Large payloads** | `chunkedRecord.js` | One string of any size stored as many small atomic records (`registerChunkedKind`, `writeChunked`, `readChunked`, `deleteChunked`, `sweepOrphanParts`): parts first, a manifest LAST as the commit point, previous generation kept for rollback. Also `deleteRecord()` in `recordStore.js` for permanent purge. |
| **Checksums & raw I/O** | `dataCore.js` | The primitives everything above is built on. |

**Deliberate non-goals** (credited to SQLite by name, not reimplemented): a real B-tree page format and a write-ahead log file (the deployment mechanism above serves WAL's actual durability purpose differently) - neither maps onto a flat key-value dynamic-property store at all. Virtual tables in general are also out of scope (they'd mean building a query planner MCLite has no use for at this scale); `fulltext.js` is the one deliberate exception, attempted despite the mismatch because it was explicitly requested (see below).

### Full-text search: an honest analog, not FTS5 (OR-Track E2b)

A real KV store has no inverted-index storage engine underneath it the way
SQLite's FTS5 virtual table does - `fulltext.js` is a pragmatic
scan-reduction structure layered on top, not a port of FTS5:

- `registerFulltextField(kind, field)` opts one field of a record kind in.
- `indexFulltextRecord(owner, kind, field, id, record)` tokenizes the
  field (lowercase, split on non-letter/digit runs, no stemming or
  stopword removal) and updates a per-owner inverted index (token → matching
  ids), correctly dropping stale token entries via a small membership map
  if the field's content changed since the last index. Not automatic -
  mirrors `perOwnerIndex.js`'s own `upsertIndexEntry()` convention: call it
  explicitly right after a successful `writeRecord()`.
- `queryFulltext(owner, world, kind, field, searchTerm, {filter})` tokenizes
  the search the same way and returns records containing **every** search
  token (a plain AND, not OR) - optionally narrowed further by a
  `query.js`-style declarative filter over the matched records' other
  fields.
- **What this deliberately does not do**: no relevance ranking/BM25, no
  phrase queries, no fuzzy/partial-word matching, no stemming. It answers
  "which records mention all of these words," nothing more.
- **Scaling honesty**: the inverted index and membership map are one
  property each per (owner, kind, field) - fine for a typical roster
  (tens of records, short strings), but a very large roster with a big
  vocabulary could approach the per-property size ceiling. Sharding by
  token prefix is the documented future extension if that's ever actually
  threatened, same discipline as `counters.js`'s own sharding note - not
  needed today.

Everything is **pluggable per record kind** - MCLite has no idea what a
"character," "pet," or "shop" is. A consuming project registers its own
record shape, validator, index projection, relation tracks, and any extra
integrity checks; MCLite just guarantees the storage underneath all of it
is atomic and recoverable.

## Storage adapters (OR-Track E3)

Every function that touches storage (`readRecord`, `writeRecord`, `readPair`,
...) takes its `owner`/`world` parameter as a plain object shaped like
`{getDynamicProperty, setDynamicProperty, getDynamicPropertyIds}` - a real
Bedrock `Player`/`world` object already satisfies this natively, and so
does the plain mock `test/mockOwner.js` uses. That's the storage-adapter
contract, formalized in `src/adapters/StorageAdapter.js`.

**Only one real adapter ships today**: `createDynamicPropertyAdapter()`, a
pure pass-through wrapper (zero behavior change) around a native object,
provided so the contract is explicit and `capabilities()`/`status()` are
available uniformly.

A second adapter - `SqliteHttpAdapter`, backing records with a small
first-party HTTP+SQLite service for dedicated servers (OR-Track E3's
original design) - is **not implemented**. Building it surfaced a real
problem worth recording rather than working around badly:
`getDynamicProperty`/`setDynamicProperty` are **synchronous** everywhere in
this codebase (and in real Bedrock), but an HTTP call is inherently
asynchronous. There is no correct way to make an HTTP-backed adapter
satisfy this interface without either a synchronous-XHR-style busy-wait
(bad practice, stalls the server tick) or rewriting this entire
synchronous core into an async one (a real, substantial rearchitecture,
not a side effect of adding one adapter). See `StorageAdapter.js`'s own
header comment for the full writeup. Backend auto-detection (OR-Track E4,
`openrock.server.json` + a health check) is deferred until this is
actually resolved - there's nothing to detect yet.

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
[OpenChara](https://github.com/codex-alchemist-dev/OpenChara)'s `dataCore.js`
family - see "OpenRock Mod Packager — Phased Implementation Plan",
OR-Phase 4, for the extraction design. OpenChara is MCLite's first real
consumer, wired in as a library through
[OpenRock](https://github.com/codex-alchemist-dev/OpenRock).

## Contributing

Issues and PRs welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) for the
process and ground rules (no runtime dependencies, `node --check` and
`npm test` before opening a PR, small focused changes).

## License

[MPL-2.0](LICENSE).
