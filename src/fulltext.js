// Full-text search - the closest honest analog to SQLite's FTS5 achievable
// over a flat dynamic-property key-value store, NOT a real search engine:
// a lightweight, opt-in inverted-index-style record (token -> matching
// ids), maintained per owner/kind/field, updated incrementally as records
// are (re)indexed. No ranking/BM25, no phrase queries, no fuzzy matching -
// a search for several words returns records containing ALL of them (a
// simple AND-of-tokens match), nothing more.
//
// Confirmed in scope by explicit request (OR-Track E2b) despite this
// structural mismatch - a real KV store has no B-tree/inverted-index
// storage engine underneath it the way SQLite's FTS5 virtual table does,
// so this is a pragmatic scan-reduction structure layered on top, not a
// port of FTS5 itself.
//
// See "OpenRock Ecosystem Expansion Roadmap", OR-Track E2b, in the project
// plan document.
"use strict";

const { readJsonProperty, writeJsonProperty } = require("./dataCore.js");
const { readRecord } = require("./recordStore.js");
const { matchesFilter } = require("./query.js");

const fields = new Map(); // `${kind}|${field}` -> true (registered marker)

/**
 * Opt in one field of a record kind to full-text indexing. Call once per
 * (kind, field) pair before indexFulltextRecord() is ever used for it -
 * multiple fields per kind are fine, each gets its own independent index.
 */
function registerFulltextField(kind, field) {
    fields.set(`${kind}|${field}`, true);
}

function isRegistered(kind, field) { return fields.has(`${kind}|${field}`); }

function indexKey(kind, field) { return `mclite:fulltext:${kind}:${field}`; }
function membershipKey(kind, field) { return `mclite:fulltext:${kind}:${field}:membership`; }

// Deliberately simple: lowercase, split on anything that isn't a letter or
// digit, drop empty tokens. No stemming, no stopword removal - "the closest
// HONEST analog," not a claim of linguistic sophistication.
function tokenize(text) {
    if (typeof text !== "string") return [];
    return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function isValidIndex(obj) {
    return obj && typeof obj === "object" && Object.values(obj).every(list => Array.isArray(list) && list.every(x => typeof x === "string"));
}

/**
 * (Re)indexes one record's field. Correctly removes stale token entries if
 * the field's content changed since the last time this id was indexed (via
 * a small membership map recording which tokens this id currently
 * occupies) - a record whose name changes from "Old Name" to "New Name" no
 * longer matches a search for "old" afterward.
 *
 * Not automatic: mirrors perOwnerIndex.js's own upsertIndexEntry()
 * convention - call this explicitly right after a successful writeRecord(),
 * rather than recordStore.js silently reaching into unrelated modules on
 * every write.
 */
function indexFulltextRecord(owner, kind, field, id, record) {
    if (!isRegistered(kind, field)) throw new Error(`indexFulltextRecord("${kind}", "${field}"): not registered - call registerFulltextField() first`);
    const newTokens = new Set(tokenize(record?.[field]));

    const membership = readJsonProperty(owner, membershipKey(kind, field), {});
    const oldTokens = new Set(membership[id] ?? []);
    const index = readJsonProperty(owner, indexKey(kind, field), {});

    for (const token of oldTokens) {
        if (newTokens.has(token)) continue;
        index[token] = (index[token] ?? []).filter(x => x !== id);
        if (index[token].length === 0) delete index[token];
    }
    for (const token of newTokens) {
        if (!index[token]) index[token] = [];
        if (!index[token].includes(id)) index[token].push(id);
    }

    writeJsonProperty(owner, indexKey(kind, field), index, isValidIndex);
    const nextMembership = { ...membership, [id]: [...newTokens] };
    if (newTokens.size === 0) delete nextMembership[id];
    writeJsonProperty(owner, membershipKey(kind, field), nextMembership, v => v && typeof v === "object");
}

/** Removes an id from a field's index entirely (call when a record is deleted/released). */
function removeFulltextRecord(owner, kind, field, id) {
    if (!isRegistered(kind, field)) return;
    indexFulltextRecord(owner, kind, field, id, {}); // reindexing against an empty record clears all of this id's tokens
}

/**
 * Tokenizes `searchTerm` the same way records were indexed, and returns
 * every id whose indexed tokens are a SUPERSET of the search tokens (a
 * plain AND-of-terms match - no ranking, no partial-word matching beyond
 * whatever tokenize() already does).
 * @param {object} [opts.filter] - an optional query.js-style declarative
 *   filter tree, applied to each candidate's FULL record after the
 *   fulltext match narrows the candidate set.
 * @returns {object[]} matching full records
 */
function queryFulltext(owner, world, kind, field, searchTerm, { filter } = {}) {
    if (!isRegistered(kind, field)) throw new Error(`queryFulltext("${kind}", "${field}"): not registered - call registerFulltextField() first`);
    const searchTokens = tokenize(searchTerm);
    if (searchTokens.length === 0) return [];

    const index = readJsonProperty(owner, indexKey(kind, field), {});
    let candidateIds = null;
    for (const token of searchTokens) {
        const idsForToken = new Set(index[token] ?? []);
        candidateIds = candidateIds === null ? idsForToken : new Set([...candidateIds].filter(id => idsForToken.has(id)));
        if (candidateIds.size === 0) return [];
    }

    const out = [];
    for (const id of candidateIds) {
        const rec = readRecord(owner, world, kind, id);
        if (rec && matchesFilter(rec, filter)) out.push(rec);
    }
    return out;
}

module.exports = { registerFulltextField, indexFulltextRecord, removeFulltextRecord, queryFulltext, tokenize };
