# MClite

A lightweight, generic Minecraft Bedrock storage system - dependency-free
Node, consumed by sibling repos via relative `require()` (matching MinUI's
own convention), not published to npm.

**Status: seeded, empty (OR-Phase 2).** This repo exists now so it can be
wired as a git submodule inside OpenRock before any real code moves into
it. The actual generalized extraction from OpenChara's `dataCore.js`
family (record storage, id/owner registries, per-owner indexes, pairwise
relationship stores, counters, block links, and the pluggable scan/repair/
export/import mechanisms) happens in **OR-Phase 4** - see "OpenRock Mod
Packager — Phased Implementation Plan" in the project plan document for
the full design (concrete function signatures, what does/doesn't move
here from OpenChara).

## Target public API (OR-Phase 4, not implemented yet)

- `recordStore.js` - `registerRecordKind`, `readRecord`, `writeRecord`,
  plus `computeChecksum`/`withChecksum`/`verifyChecksum` and
  `readJsonProperty`/`writeJsonProperty` (moved verbatim from
  `dataCore.js`, already fully generic today).
- `idRegistry.js` - `generateId`, `registerOwner`, `resolveOwner`.
- `perOwnerIndex.js` - `registerIndexKind`, `readIndex`,
  `upsertIndexEntry`, `removeIndexEntry`, `findByField`.
- `pairStore.js` - `registerPairKind`, `readPair`, `writePair`,
  `listPairsFor`.
- `counters.js`, `blockLinks.js` - moved verbatim, already fully generic.
- `maintenance.js` - `registerIntegrityCheck`, `scanAndRepair`.
- `transfer.js` - `registerTransferRules`, `exportRecord`, `importRecord`.

## Consumed by

- `OpenChara` (as an OpenRock plugin, `dependsOn.mclite`, wired in
  OR-Phase 5) - the reference/only consumer for now.
