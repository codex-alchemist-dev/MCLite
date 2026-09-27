// VACUUM - SQLite's own operation reclaims/compacts the database file;
// there's no file to compact here (dynamic properties don't fragment the
// way a page-based file does), so MCLite's VACUUM does the two things that
// genuinely map over: re-serializing every record of a kind (a real
// writeRecord() pass, so a stale/oversized field a past schema version left
// behind is actually dropped, not just ignored), and finalizing whatever
// counters.js still has sitting in its in-memory buffered write queue into
// its canonical, committed form.
//
// See "OpenRock Ecosystem Expansion Roadmap", OR-Track E2, in the project
// plan document (the SQLite-concept mapping table).
"use strict";

const { readIndex } = require("./perOwnerIndex.js");
const { writeRecord } = require("./recordStore.js");
const { flushQueuedStats } = require("./counters.js");

/**
 * Re-serializes every record of `kind` this owner has, through the normal
 * copy-validate-commit path - each `dropFields` entry is deleted from the
 * record before it's re-validated and re-committed. A record that has none
 * of `dropFields` still gets a fresh deployment/checksum (a real write, not
 * a no-op) - cheap for records this small, and it's the only way to
 * actually reclaim a field a validator no longer requires.
 *
 * Enumerates ids via perOwnerIndex.js's index (same source query.js uses),
 * not a raw key scan - a record that was never indexed is invisible to
 * this pass. For a guaranteed-complete sweep regardless of index state,
 * use maintenance.js's discoverIds()/scanAndRepair() instead.
 * @param {string[]} [dropFields] - top-level field names to strip.
 * @returns {{ vacuumed: number, skipped: string[] }} skipped ids are ones
 *   whose write failed (e.g. dropping a required field made it invalid) -
 *   they're left completely untouched, never partially vacuumed.
 */
function vacuumRecords(owner, world, kind, { dropFields = [] } = {}) {
    const ids = readIndex(owner, kind).map(e => e.id);
    let vacuumed = 0;
    const skipped = [];
    for (const id of ids) {
        const result = writeRecord(owner, world, kind, id, old => {
            if (!old) return null;
            if (dropFields.length === 0) return { ...old }; // still a fresh commit, per the doc above
            const next = { ...old };
            for (const f of dropFields) delete next[f];
            return next;
        });
        if (result) vacuumed++;
        else skipped.push(id);
    }
    return { vacuumed, skipped };
}

/**
 * Thin pass-through to counters.js's flushQueuedStats() - included here so
 * "run a vacuum" is one call that covers both halves of "finalize anything
 * pending into canonical, durable form," matching what SQLite's own VACUUM
 * conceptually promises (no stray uncommitted state left lying around).
 */
function vacuumCounters(findOwner) {
    return flushQueuedStats(findOwner);
}

module.exports = { vacuumRecords, vacuumCounters };
