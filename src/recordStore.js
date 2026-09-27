// The atomic record store - MClite's "table" engine. Generalizes
// OpenChara's dataCore.js readCharacter()/writeCharacter() (the A/B
// deployment-slot pattern: a write is fully built and validated in memory,
// committed into the currently-INACTIVE slot, read back and re-verified,
// and only THEN does a single scalar pointer flip make it live) into a
// store for any record kind, not just "character".
//
// Atomicity guarantee: a reader never observes a partially-written record.
// Either the pointer still says the old (fully valid) slot, or it says the
// new (fully valid, read-back-confirmed) slot - there is no state in
// between where a reader could see a half-applied write. This is the
// "atomic" in "fully atomic database": not a multi-key transaction (there
// is only ever one record per write here), but a genuine guarantee that a
// single record's write is all-or-nothing from every reader's point of
// view, plus a redundant off-record copy (the mirror) for recovery if the
// primary is ever lost or corrupted outright.
"use strict";

const { withChecksum, readJsonProperty, writeJsonProperty } = require("./dataCore.js");

const kinds = new Map(); // kind -> { keyPrefix, validate }

/**
 * Declares a record kind ("table") before any read/write against it.
 * @param {string} kind - e.g. "character", "pet", "shop"
 * @param {object} opts
 * @param {string} opts.keyPrefix - the dynamic-property key segment this
 *   kind's records live under (kept short - Bedrock's key length matters).
 * @param {(record: object) => boolean} opts.validate - structural + checksum
 *   validity check. A record that fails this is never committed and never
 *   returned as "the" record (recovery from the mirror is attempted first).
 */
function registerRecordKind(kind, { keyPrefix, validate } = {}) {
    if (typeof keyPrefix !== "string" || !keyPrefix) throw new Error(`registerRecordKind("${kind}"): keyPrefix is required`);
    if (typeof validate !== "function") throw new Error(`registerRecordKind("${kind}"): validate is required`);
    kinds.set(kind, { keyPrefix, validate });
}

function kindOf(kind) {
    const k = kinds.get(kind);
    if (!k) throw new Error(`Unknown record kind "${kind}" - call registerRecordKind() first`);
    return k;
}

// Exposed so other modules (maintenance.js) can reuse the same
// {keyPrefix, validate} a kind was registered with, instead of requiring a
// second, easy-to-forget registration call for the same kind.
function getKindConfig(kind) { return kinds.get(kind) ?? null; }

function slotKey(prefix, id, slot) { return `mclite:${prefix}:${id}:${slot}`; }
function activeKey(prefix, id) { return `mclite:${prefix}:${id}:active`; }
function mirrorKey(prefix, id) { return `mclite:mirror:${prefix}:${id}`; }

/**
 * Reads the current record for one id. Self-healing: if the primary slot
 * fails validation, transparently recovers from the world-scoped mirror
 * and repairs the primary in place before returning - a caller never has
 * to know recovery happened.
 * @param {object} owner - anything with getDynamicProperty/setDynamicProperty
 *   (a Player, in Bedrock terms)
 * @param {object} world - the world-scoped store for the mirror (in
 *   Bedrock terms, the real `world` object - passed explicitly rather than
 *   imported, so this module has zero dependency on `@minecraft/server`
 *   and is fully unit-testable with a plain mock)
 * @param {string} kind
 * @param {string} id
 * @returns {object|null}
 */
function readRecord(owner, world, kind, id) {
    const { keyPrefix, validate } = kindOf(kind);
    const active = owner.getDynamicProperty(activeKey(keyPrefix, id));
    const slot = active === "A" || active === "B" ? active : null;
    const everExisted = slot !== null;

    if (slot) {
        const rec = readJsonProperty(owner, slotKey(keyPrefix, id, slot));
        if (rec && validate(rec)) return rec;
        console.warn(`[MClite] "${kind}" ${id} primary slot ${slot} failed validation - attempting mirror recovery.`);
    }

    const mirrored = readJsonProperty(world, mirrorKey(keyPrefix, id));
    if (mirrored && validate(mirrored)) {
        if (everExisted) console.warn(`[MClite] "${kind}" ${id} recovered from mirror; repairing primary.`);
        const recoverSlot = slot === "A" ? "B" : "A";
        writeJsonProperty(owner, slotKey(keyPrefix, id, recoverSlot), mirrored, validate);
        owner.setDynamicProperty(activeKey(keyPrefix, id), recoverSlot);
        return mirrored;
    }

    if (everExisted) console.error(`[MClite] "${kind}" ${id} unrecoverable: primary and mirror both missing/corrupt.`);
    return null;
}

/**
 * Full copy-validate-commit + A/B swap + mirror write, in one call.
 * `mutate(oldRecord) -> newRecord` must return a brand-new object (or a
 * falsy value to abort); oldRecord is never mutated in place.
 * @returns {object|null} the committed record, or null if the write was
 *   aborted (mutate threw/returned falsy, the result failed validation, or
 *   the commit-verification read-back didn't match).
 */
function writeRecord(owner, world, kind, id, mutate) {
    const { keyPrefix, validate } = kindOf(kind);
    const oldRecord = readRecord(owner, world, kind, id);
    let newRecord;
    try {
        newRecord = mutate(oldRecord);
    } catch (e) {
        console.warn(`[MClite] writeRecord("${kind}", ${id}) mutate() threw, aborting write: ${e}`);
        return null;
    }
    if (!newRecord) return null;

    newRecord = withChecksum(newRecord);
    if (!validate(newRecord)) {
        console.warn(`[MClite] writeRecord("${kind}", ${id}) produced an invalid record, aborting write.`);
        return null;
    }

    const activeSlot = owner.getDynamicProperty(activeKey(keyPrefix, id));
    const targetSlot = activeSlot === "A" ? "B" : "A";

    // (1) Write the fully-finished record into the currently-INACTIVE slot
    // only - the live slot is untouched, so an interruption here changes
    // nothing a reader can see.
    if (!writeJsonProperty(owner, slotKey(keyPrefix, id, targetSlot), newRecord, validate)) return null;

    // (2) Read it back and confirm - a real commit check, not an assumption.
    const readBack = readJsonProperty(owner, slotKey(keyPrefix, id, targetSlot));
    if (!readBack || !validate(readBack) || readBack._checksum !== newRecord._checksum) {
        console.error(`[MClite] writeRecord("${kind}", ${id}) commit verification failed - live record left untouched.`);
        return null;
    }

    // (3) Flip the pointer - the ONE moment a reader's view actually
    // changes. A plain scalar write, never JSON-wrapped.
    owner.setDynamicProperty(activeKey(keyPrefix, id), targetSlot);

    // (4) Mirror, authoritative-first: the primary is already live and
    // correct by the time this runs, so an interruption here at worst
    // leaves a stale mirror, which readRecord()'s own validation would
    // simply reject in favor of the (already-good) primary.
    writeJsonProperty(world, mirrorKey(keyPrefix, id), newRecord, validate);

    return newRecord;
}

module.exports = { registerRecordKind, readRecord, writeRecord, getKindConfig };
