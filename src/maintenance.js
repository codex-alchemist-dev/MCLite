// Generic integrity scan/repair - MCLite's `PRAGMA integrity_check`
// equivalent. The generic structural checks (does the record validate,
// does the mirror agree with the primary) always run; a record kind
// registers additional checks specific to its own domain (a "character"
// kind might check bond partners still exist; MCLite itself has no idea
// what a "bond" is, so it never hardcodes that).
"use strict";

const { readJsonProperty, writeJsonProperty } = require("./dataCore.js");
const { readRecord, writeRecord, getKindConfig } = require("./recordStore.js");

const kindChecks = new Map(); // kind -> [{name, checkFn}, ...]

/**
 * @param {string} kind
 * @param {string|Function} nameOrCheckFn - a label for this check (shown in
 *   scanAndRepair()'s per-check pass/fail breakdown), or the check function
 *   itself if no label is needed (defaults to "check#<n>").
 * @param {(record: object, ctx: {owner, world}) => {ok: boolean, issue?: string, repair?: (record: object) => object}} [checkFn]
 */
function registerIntegrityCheck(kind, nameOrCheckFn, checkFn) {
    if (!kindChecks.has(kind)) kindChecks.set(kind, []);
    const list = kindChecks.get(kind);
    if (typeof nameOrCheckFn === "function") list.push({ name: `check#${list.length}`, checkFn: nameOrCheckFn });
    else list.push({ name: nameOrCheckFn, checkFn });
}

// Ids aren't assumed to be UUIDs - a record kind can use whatever id shape
// it wants (idRegistry.js's UUIDs are the recommended default, not a
// requirement). Any run of non-colon characters is accepted.
const ID = "[^:]+";

/**
 * Every id of `kind` this owner has any trace of - record slots on the
 * owner AND world mirrors, so a record the caller's index lost track of is
 * still found. Reuses whatever {keyPrefix, validate} `kind` was already
 * registered with in recordStore.js - no separate registration needed.
 */
function discoverIds(owner, world, kind) {
    const config = getKindConfig(kind);
    if (!config) throw new Error(`discoverIds("${kind}"): unknown record kind - call recordStore.js's registerRecordKind() first`);
    const recordRe = new RegExp(`^mclite:${config.keyPrefix}:(${ID}):(0|1|active|pinned)$`);
    const mirrorRe = new RegExp(`^mclite:mirror:${config.keyPrefix}:(${ID})$`);
    const ids = new Set();
    for (const key of owner.getDynamicPropertyIds()) {
        const m = recordRe.exec(key);
        if (m) ids.add(m[1]);
    }
    for (const key of world.getDynamicPropertyIds()) {
        const m = mirrorRe.exec(key);
        if (m) ids.add(m[1]);
    }
    return [...ids];
}

/**
 * Scans every discovered id of `kind` for this owner. With `repair: false`
 * this is a pure read - nothing is written at all.
 *
 * `checks` is the "PRAGMA integrity_check" part proper: a structured
 * pass/fail tally per check name (the two built-ins, "primaryValid" and
 * "mirrorConsistent", plus every name a kind registered via
 * registerIntegrityCheck) - so a caller can ask "which specific check is
 * failing across my whole roster," not just "here's a flat pile of issues."
 * `issues` keeps the original flat, human-readable list for display.
 *
 * @returns {{ checked: number, issues: Array<{id, problem, fixed}>, checks: Record<string, {pass: number, fail: number}> }}
 */
function scanAndRepair(owner, world, kind, { repair = false } = {}) {
    const config = getKindConfig(kind);
    if (!config) throw new Error(`scanAndRepair("${kind}"): unknown record kind - call recordStore.js's registerRecordKind() first`);
    const { keyPrefix, validate } = config;
    const issues = [];
    const checks = { primaryValid: { pass: 0, fail: 0 }, mirrorConsistent: { pass: 0, fail: 0 } };
    for (const { name } of kindChecks.get(kind) ?? []) checks[name] = { pass: 0, fail: 0 };
    const tally = (name, ok) => { checks[name][ok ? "pass" : "fail"]++; };
    const note = (id, problem, fixed = false) => issues.push({ id, problem, fixed: repair && fixed });
    const ids = discoverIds(owner, world, kind);

    for (const id of ids) {
        const current = owner.getDynamicProperty(`mclite:${keyPrefix}:${id}:active`);
        const deployment0 = readJsonProperty(owner, `mclite:${keyPrefix}:${id}:0`);
        const deployment1 = readJsonProperty(owner, `mclite:${keyPrefix}:${id}:1`);
        const mirror = readJsonProperty(world, `mclite:mirror:${keyPrefix}:${id}`);
        const primaryOk = (current === "0" && validate(deployment0)) || (current === "1" && validate(deployment1));
        tally("primaryValid", primaryOk);

        let rec = primaryOk ? (current === "0" ? deployment0 : deployment1) : (repair ? readRecord(owner, world, kind, id) : (validate(mirror) ? mirror : null));
        if (!rec) {
            note(id, "record unrecoverable: both deployments and the mirror are all missing or corrupt");
            tally("mirrorConsistent", false);
            continue;
        }
        if (!primaryOk) note(id, current ? `current deployment ${current} corrupt - recovered from mirror` : "primary copy missing - recovered from mirror", true);

        const mirrorOk = validate(mirror) && mirror._checksum === rec._checksum;
        tally("mirrorConsistent", mirrorOk);
        if (!mirrorOk) {
            note(id, mirror ? "mirror out of sync with primary" : "mirror missing", true);
            if (repair) writeJsonProperty(world, `mclite:mirror:${keyPrefix}:${id}`, rec, validate);
        }

        // Kind-specific checks, run in registration order, entirely opaque
        // to MCLite itself - a broken check never crashes the whole scan.
        for (const { name, checkFn } of kindChecks.get(kind) ?? []) {
            let result;
            try { result = checkFn(rec, { owner, world }); }
            catch (e) { console.warn(`[MCLite] integrity check "${name}" for "${kind}" threw: ${e}`); continue; }
            const ok = !result || result.ok !== false;
            tally(name, ok);
            if (result && !result.ok) {
                note(id, result.issue ?? `failed integrity check "${name}"`, Boolean(result.repair));
                if (repair && result.repair) {
                    const repaired = result.repair(rec);
                    if (repaired) { rec = repaired; writeRecord(owner, world, kind, id, () => repaired); }
                }
            }
        }
    }

    return { checked: ids.length, issues, checks };
}

module.exports = { registerIntegrityCheck, discoverIds, scanAndRepair };
