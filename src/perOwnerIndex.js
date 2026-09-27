// Generic per-owner index - MClite's answer to "list every record of kind
// X this owner has" without loading every record's full body. Generalizes
// OpenChara's characterIndex.js, whose entry shape ({id, nickname,
// species}) was hardcoded; here the caller supplies a `project(record)`
// function that produces whatever small summary object is worth indexing.
"use strict";

const { readJsonProperty, writeJsonProperty } = require("./dataCore.js");

const kinds = new Map(); // kind -> { project }

/**
 * @param {string} kind
 * @param {object} opts
 * @param {(record: object) => object} opts.project - record -> small
 *   summary object to store in the index (must always include an `id`).
 */
function registerIndexKind(kind, { project } = {}) {
    if (typeof project !== "function") throw new Error(`registerIndexKind("${kind}"): project is required`);
    kinds.set(kind, { project });
}

function indexKey(kind) { return `mclite:index:${kind}`; }

function isValidIndex(list) {
    return Array.isArray(list) && list.every(e => e && typeof e.id === "string");
}

function readIndex(owner, kind) {
    return readJsonProperty(owner, indexKey(kind), []);
}

function writeIndex(owner, kind, list) {
    if (list.length === 0) {
        owner.setDynamicProperty(indexKey(kind), undefined); // never store an empty array
        return true;
    }
    return writeJsonProperty(owner, indexKey(kind), list, isValidIndex);
}

function upsertIndexEntry(owner, kind, id, record) {
    const { project } = kinds.get(kind) ?? {};
    if (!project) throw new Error(`Unknown index kind "${kind}" - call registerIndexKind() first`);
    const entry = { ...project(record), id };
    const list = readIndex(owner, kind);
    const exists = list.some(e => e.id === id);
    const next = exists ? list.map(e => (e.id === id ? entry : e)) : [...list, entry];
    writeIndex(owner, kind, next);
    return entry;
}

function removeIndexEntry(owner, kind, id) {
    writeIndex(owner, kind, readIndex(owner, kind).filter(e => e.id !== id));
}

function findByField(owner, kind, field, value) {
    return readIndex(owner, kind).find(e => e[field] === value) ?? null;
}

// Self-healing rebuild: drop any index entry whose backing record no
// longer resolves. `recordExists(id) -> boolean` is supplied by the
// caller so this module never needs to know how a record kind is stored.
function reconcileIndex(owner, kind, recordExists) {
    const list = readIndex(owner, kind);
    const clean = list.filter(e => recordExists(e.id));
    if (clean.length !== list.length) writeIndex(owner, kind, clean);
    return clean;
}

module.exports = { registerIndexKind, readIndex, upsertIndexEntry, removeIndexEntry, findByField, reconcileIndex };
