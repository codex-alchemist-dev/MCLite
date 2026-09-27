// The storage-adapter contract (OR-Track E3) - documented here, not
// enforced by a base class, because every function in dataCore.js/
// recordStore.js/etc. already takes its "owner"/"world" parameter as
// nothing more than an object shaped like this. That's not a coincidence:
// this project's tests have always passed a plain mock object (see
// test/mockOwner.js) in place of a real Bedrock Player/world - the
// synchronous, plug-in-anything nature of "owner"/"world" throughout this
// codebase IS the storage adapter interface. This file exists to name that
// contract explicitly, give it a home, and host the one adapter that's
// safe to ship today.
//
// Required, SYNCHRONOUS methods (every one of these matches an existing
// real Player/world method in @minecraft/server today - see
// https://learn.microsoft.com/minecraft/creator/scriptapi):
//   - getDynamicProperty(key: string): string | number | boolean | undefined
//   - setDynamicProperty(key: string, value: string | number | boolean | undefined): void
//   - getDynamicPropertyIds(): string[]
//
// Optional, for adapters that want to report more about themselves:
//   - status(): object   - adapter-specific health/diagnostic info
//   - capabilities(): { synchronous: boolean, persistent: boolean, [k]: any }
//
// ---- Why there is only ONE real adapter in this file --------------------
//
// OR-Track E3 called for a second adapter here, SqliteHttpAdapter, backing
// records with a small first-party HTTP+SQLite service for dedicated
// servers. Attempting to actually build it surfaced a real, load-bearing
// problem worth recording rather than papering over: `getDynamicProperty`/
// `setDynamicProperty` are SYNCHRONOUS in every real Bedrock script -
// callers throughout this entire codebase (readRecord, writeRecord,
// queryRecords, vacuumRecords, scanAndRepair...) call them inline and use
// the return value immediately, with no `await` anywhere. An HTTP call is
// inherently asynchronous - there is no correct way to make
// `getDynamicProperty` block on a network round-trip without either (a)
// a synchronous-XHR-style busy-wait, which is genuinely bad practice and
// would stall the whole server tick, or (b) rewriting this entire
// synchronous core (recordStore.js and everything built on it) into an
// async one, which is a real, substantial rearchitecture - not something
// to half-do as a side effect of adding one adapter.
//
// Given that, `SqliteHttpAdapter` is NOT implemented in this pass. Building
// it for real needs its own dedicated design pass, almost certainly
// producing a parallel `asyncRecordStore.js` (or equivalent) rather than
// trying to force the existing synchronous API to serve both cases -
// flagged here, and in the project plan's Open Questions, rather than
// shipped as a shape that looks pluggable but silently doesn't work
// correctly under real network latency. See also OR-Track E4 (backend
// auto-detection), which is written to select between "the real thing"
// and "not available yet" rather than a working HTTP backend.
"use strict";

/**
 * The trivial, zero-behavior-change adapter: wraps a real (or mock) object
 * that already implements getDynamicProperty/setDynamicProperty/
 * getDynamicPropertyIds directly - a real Bedrock Player or world object
 * needs no wrapping at all to be used as "owner"/"world" throughout this
 * codebase; this factory exists so the contract is explicit and
 * `capabilities()`/`status()` are available uniformly, without changing
 * what gets passed to readRecord()/writeRecord()/etc. (still just the
 * native object, or the result of this wrapper - both work identically
 * everywhere, since the wrapper is a pure pass-through).
 */
function createDynamicPropertyAdapter(native) {
    if (typeof native?.getDynamicProperty !== "function" || typeof native?.setDynamicProperty !== "function") {
        throw new Error("createDynamicPropertyAdapter(): native object must implement getDynamicProperty/setDynamicProperty");
    }
    return {
        getDynamicProperty: (key) => native.getDynamicProperty(key),
        setDynamicProperty: (key, value) => native.setDynamicProperty(key, value),
        getDynamicPropertyIds: () => (typeof native.getDynamicPropertyIds === "function" ? native.getDynamicPropertyIds() : []),
        status() { return { kind: "dynamic-property", synchronous: true }; },
        capabilities() { return { synchronous: true, persistent: true, networked: false }; },
    };
}

module.exports = { createDynamicPropertyAdapter };
