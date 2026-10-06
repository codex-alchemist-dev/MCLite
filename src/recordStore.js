// The atomic record store - MCLite's "table" engine. Generalizes
// OpenChara's dataCore.js readCharacter()/writeCharacter() (the two-
// deployment pattern: a write is fully built and validated in memory,
// committed into the currently-INACTIVE deployment, read back and
// re-verified, and only THEN does a single scalar pointer flip make it
// live) into a store for any record kind, not just "character".
//
// Terminology (OR-Track E1): modeled directly on how Fedora Silverblue's
// OSTree actually works - an update is never applied by patching the live
// system in place. A complete new tree is fully assembled and content-
// verified as its own independent "deployment" first; only then does a
// tiny pointer (OSTree's bootloader entry, here a single dynamic-property
// scalar) switch over to it, and the PREVIOUS deployment is kept around
// fully intact, specifically so rollback is just pointing back at it, no
// reconstruction needed. What this file used to call "slot A/B" is
// "deployment 0/1"; the pointer is the "current deployment."
//
// Atomicity guarantee: a reader never observes a partially-written record.
// Either the pointer still says the old (fully valid) deployment, or it
// says the new (fully valid, read-back-confirmed) deployment - there is no
// state in between where a reader could see a half-applied write. This is
// the "atomic" in "fully atomic database": not a multi-key transaction
// (there is only ever one record per write here), but a genuine guarantee
// that a single record's write is all-or-nothing from every reader's point
// of view, plus a redundant off-record copy (the mirror) for recovery if
// the primary is ever lost or corrupted outright.
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

// A record's two physical generations are "0" and "1" - OSTree's own
// deployment numbering, not an arbitrary choice. `deploymentKey` addresses
// one of them directly; `currentDeploymentKey` is the pointer scalar;
// `pinnedDeploymentKey` (E1) optionally marks one generation "don't
// overwrite next write" (see pin()/unpin() below).
function deploymentKey(prefix, id, deployment) { return `mclite:${prefix}:${id}:${deployment}`; }
function currentDeploymentKey(prefix, id) { return `mclite:${prefix}:${id}:active`; }
function pinnedDeploymentKey(prefix, id) { return `mclite:${prefix}:${id}:pinned`; }
function mirrorKey(prefix, id) { return `mclite:mirror:${prefix}:${id}`; }

function otherDeployment(deployment) { return deployment === "0" ? "1" : "0"; }

/**
 * Reads the current record for one id. Self-healing: if the primary
 * deployment fails validation, transparently recovers from the world-
 * scoped mirror and repairs the primary in place before returning - a
 * caller never has to know recovery happened.
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
    const current = owner.getDynamicProperty(currentDeploymentKey(keyPrefix, id));
    const deployment = current === "0" || current === "1" ? current : null;
    const everExisted = deployment !== null;

    if (deployment) {
        const rec = readJsonProperty(owner, deploymentKey(keyPrefix, id, deployment));
        if (rec && validate(rec)) return rec;
        console.warn(`[MCLite] "${kind}" ${id} current deployment ${deployment} failed validation - attempting mirror recovery.`);
    }

    const mirrored = readJsonProperty(world, mirrorKey(keyPrefix, id));
    if (mirrored && validate(mirrored)) {
        if (everExisted) console.warn(`[MCLite] "${kind}" ${id} recovered from mirror; repairing primary.`);
        const recoverDeployment = deployment ? otherDeployment(deployment) : "0";
        writeJsonProperty(owner, deploymentKey(keyPrefix, id, recoverDeployment), mirrored, validate);
        owner.setDynamicProperty(currentDeploymentKey(keyPrefix, id), recoverDeployment);
        return mirrored;
    }

    if (everExisted) console.error(`[MCLite] "${kind}" ${id} unrecoverable: primary and mirror both missing/corrupt.`);
    return null;
}

/**
 * Full copy-validate-commit + deployment swap + mirror write, in one call.
 * `mutate(oldRecord) -> newRecord` must return a brand-new object (or a
 * falsy value to abort); oldRecord is never mutated in place.
 * @returns {object|null} the committed record, or null if the write was
 *   aborted (mutate threw/returned falsy, the result failed validation,
 *   the target deployment is pinned (E1 - see pin()), or the commit-
 *   verification read-back didn't match).
 */
function writeRecord(owner, world, kind, id, mutate) {
    const { keyPrefix, validate } = kindOf(kind);
    const oldRecord = readRecord(owner, world, kind, id);
    let newRecord;
    try {
        newRecord = mutate(oldRecord);
    } catch (e) {
        console.warn(`[MCLite] writeRecord("${kind}", ${id}) mutate() threw, aborting write: ${e}`);
        return null;
    }
    if (!newRecord) return null;

    newRecord = withChecksum(newRecord);
    if (!validate(newRecord)) {
        console.warn(`[MCLite] writeRecord("${kind}", ${id}) produced an invalid record, aborting write.`);
        return null;
    }

    const current = owner.getDynamicProperty(currentDeploymentKey(keyPrefix, id));
    const target = current === "0" || current === "1" ? otherDeployment(current) : "0";

    const pinned = owner.getDynamicProperty(pinnedDeploymentKey(keyPrefix, id));
    if (pinned === target) {
        console.warn(`[MCLite] writeRecord("${kind}", ${id}) aborted: deployment ${target} is pinned - unpin() before writing a new generation.`);
        return null;
    }

    // (1) Write the fully-finished record into the currently-INACTIVE
    // deployment only - the live one is untouched, so an interruption here
    // changes nothing a reader can see.
    if (!writeJsonProperty(owner, deploymentKey(keyPrefix, id, target), newRecord, validate)) return null;

    // (2) Read it back and confirm - a real commit check, not an assumption.
    const readBack = readJsonProperty(owner, deploymentKey(keyPrefix, id, target));
    if (!readBack || !validate(readBack) || readBack._checksum !== newRecord._checksum) {
        console.error(`[MCLite] writeRecord("${kind}", ${id}) commit verification failed - live record left untouched.`);
        return null;
    }

    // (3) Flip the pointer - the ONE moment a reader's view actually
    // changes. A plain scalar write, never JSON-wrapped.
    owner.setDynamicProperty(currentDeploymentKey(keyPrefix, id), target);

    // (4) Mirror, authoritative-first: the primary is already live and
    // correct by the time this runs, so an interruption here at worst
    // leaves a stale mirror, which readRecord()'s own validation would
    // simply reject in favor of the (already-good) primary.
    writeJsonProperty(world, mirrorKey(keyPrefix, id), newRecord, validate);

    return newRecord;
}

/**
 * OSTree's `pin` - marks the CURRENTLY INACTIVE deployment "don't overwrite
 * on the next write." Since a record only ever keeps two generations
 * (bounded, by design - see the file header), pinning the inactive one
 * means the next writeRecord() call is refused until unpin() is called;
 * there is no third slot to fall back to. Returns the pinned deployment id,
 * or null if there's no record yet (nothing to pin).
 */
function pin(owner, kind, id) {
    const { keyPrefix } = kindOf(kind);
    const current = owner.getDynamicProperty(currentDeploymentKey(keyPrefix, id));
    if (current !== "0" && current !== "1") return null;
    const inactive = otherDeployment(current);
    owner.setDynamicProperty(pinnedDeploymentKey(keyPrefix, id), inactive);
    return inactive;
}

/** Clears whatever pin() set - the next write can target either deployment again. */
function unpin(owner, kind, id) {
    const { keyPrefix } = kindOf(kind);
    owner.setDynamicProperty(pinnedDeploymentKey(keyPrefix, id), undefined);
}

/**
 * OSTree's `rollback` - flips the current-deployment pointer back to
 * whichever generation isn't currently active, WITHOUT writing anything.
 * Unlike a plain pointer swap, this validates the target deployment first
 * (an OSTree rollback still refuses to boot a broken deployment) - refuses
 * and returns null rather than pointing at a generation that won't read
 * back cleanly.
 * @returns {object|null} the now-current record, or null if there's
 *   nothing to roll back to (no record yet, or the other generation is
 *   missing/corrupt).
 */
function rollback(owner, world, kind, id) {
    const { keyPrefix, validate } = kindOf(kind);
    const current = owner.getDynamicProperty(currentDeploymentKey(keyPrefix, id));
    if (current !== "0" && current !== "1") return null;
    const target = otherDeployment(current);
    const candidate = readJsonProperty(owner, deploymentKey(keyPrefix, id, target));
    if (!candidate || !validate(candidate)) {
        console.warn(`[MCLite] rollback("${kind}", ${id}) refused: deployment ${target} is missing or fails validation.`);
        return null;
    }
    owner.setDynamicProperty(currentDeploymentKey(keyPrefix, id), target);
    writeJsonProperty(world, mirrorKey(keyPrefix, id), candidate, validate);
    return candidate;
}

/**
 * OSTree's `admin status` - a read-only summary of a record's deployment
 * state, for diagnostics/tooling rather than normal read/write code paths.
 */
function status(owner, world, kind, id) {
    const { keyPrefix, validate } = kindOf(kind);
    const current = owner.getDynamicProperty(currentDeploymentKey(keyPrefix, id));
    const exists = current === "0" || current === "1";
    const pinned = owner.getDynamicProperty(pinnedDeploymentKey(keyPrefix, id));
    const primary = exists ? readJsonProperty(owner, deploymentKey(keyPrefix, id, current)) : null;
    const mirrored = readJsonProperty(world, mirrorKey(keyPrefix, id));
    return {
        exists,
        currentDeployment: exists ? current : null,
        pinnedDeployment: pinned === "0" || pinned === "1" ? pinned : null,
        primaryValid: exists ? Boolean(primary && validate(primary)) : null,
        mirrorConsistent: exists ? Boolean(primary && mirrored && primary._checksum === mirrored._checksum) : null,
    };
}

/**
 * Permanently removes every physical trace of one record: both deployments,
 * the current pointer, any pin, and the world mirror. Irreversible - callers
 * that want a trash window keep a soft-delete flag in the record and only
 * call this at purge time.
 */
function deleteRecord(owner, world, kind, id) {
    const { keyPrefix } = kindOf(kind);
    for (const key of [deploymentKey(keyPrefix, id, "0"), deploymentKey(keyPrefix, id, "1"), currentDeploymentKey(keyPrefix, id), pinnedDeploymentKey(keyPrefix, id)]) {
        owner.setDynamicProperty(key, undefined);
    }
    world.setDynamicProperty(mirrorKey(keyPrefix, id), undefined);
}

module.exports = { registerRecordKind, readRecord, writeRecord, deleteRecord, pin, unpin, rollback, status, getKindConfig };
