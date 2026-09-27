// Query/filter - MCLite's answer to SQL's WHERE clause, honestly scoped to
// what a plain key-value store can actually offer: no index scan, no query
// planner, just a full iteration with a predicate. Two tiers, by cost:
//
// - queryIndex(): filters the CHEAP per-owner summaries perOwnerIndex.js
//   already keeps in one small property - no full record loads at all.
//   Use this whenever the fields you're filtering on are already in the
//   index's `project()` summary.
// - queryRecords(): loads every full record and filters with an arbitrary
//   predicate function - more expensive (one read per id), but works for
//   any field, indexed or not.
//
// See "OpenRock Ecosystem Expansion Roadmap", OR-Track E2, in the project
// plan document (the SQLite-concept mapping table).
"use strict";

const { readIndex } = require("./perOwnerIndex.js");
const { readRecord } = require("./recordStore.js");

const OPS = {
    "=": (a, b) => a === b,
    "!=": (a, b) => a !== b,
    ">": (a, b) => a > b,
    ">=": (a, b) => a >= b,
    "<": (a, b) => a < b,
    "<=": (a, b) => a <= b,
    "in": (a, b) => Array.isArray(b) && b.includes(a),
    "contains": (a, b) => typeof a === "string" && a.includes(b),
};

/**
 * A small declarative filter tree, evaluated against one object (an index
 * summary or a full record):
 *   { field, op, value }              - a single condition
 *   { all: [filter, filter, ...] }    - AND
 *   { any: [filter, filter, ...] }    - OR
 *   { not: filter }                   - NOT
 */
function matchesFilter(obj, filter) {
    if (!filter) return true;
    if (filter.all) return filter.all.every(f => matchesFilter(obj, f));
    if (filter.any) return filter.any.some(f => matchesFilter(obj, f));
    if (filter.not) return !matchesFilter(obj, filter.not);
    const opFn = OPS[filter.op];
    if (!opFn) throw new Error(`query: unknown operator "${filter.op}"`);
    return opFn(obj[filter.field], filter.value);
}

/**
 * Filters the cheap per-owner index summaries (perOwnerIndex.js) - no full
 * record loads. Only works for fields the kind's `project()` actually put
 * in the summary.
 * @returns {object[]} matching index entries (summaries, not full records)
 */
function queryIndex(owner, kind, filter) {
    return readIndex(owner, kind).filter(entry => matchesFilter(entry, filter));
}

/**
 * Loads every full record of `kind` this owner has (via the index's id
 * list) and returns the ones `predicate(record)` accepts. One readRecord()
 * per id - a genuine full scan, not an indexed lookup; this is the honest
 * cost of "query/filter" over a KV store with no B-tree underneath it.
 * @param {(record: object) => boolean} predicate
 * @returns {object[]} matching full records
 */
function queryRecords(owner, world, kind, predicate) {
    const ids = readIndex(owner, kind).map(e => e.id);
    const out = [];
    for (const id of ids) {
        const rec = readRecord(owner, world, kind, id);
        if (rec && predicate(rec)) out.push(rec);
    }
    return out;
}

/**
 * Same as queryRecords(), but the condition is the same declarative filter
 * tree queryIndex() uses, evaluated against the full record instead of the
 * summary - for filtering on a field that isn't in the index.
 */
function queryRecordsWhere(owner, world, kind, filter) {
    return queryRecords(owner, world, kind, rec => matchesFilter(rec, filter));
}

module.exports = { matchesFilter, queryIndex, queryRecords, queryRecordsWhere };
