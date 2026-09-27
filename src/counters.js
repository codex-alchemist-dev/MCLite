// Generic open-ended counters - MClite's "aggregates" table. Two levels
// deep (category, then subject), never enumerated ahead of time - a new
// category or subject is just a new key, no schema change. Generalized
// from OpenChara's counters.js, which was already fully generic (only the
// key naming was character-specific).
"use strict";

const { readJsonProperty, writeJsonProperty } = require("./dataCore.js");

function counterKey(kind, id) { return `mclite:counters:${kind}:${id}`; }

function isValidCounters(obj) {
    if (!obj || typeof obj !== "object") return false;
    return Object.values(obj).every(category =>
        category && typeof category === "object" &&
        Object.values(category).every(v => typeof v === "number")
    );
}

function readCounters(owner, kind, id) {
    return readJsonProperty(owner, counterKey(kind, id), {});
}

function readCounter(owner, kind, id, category, subject) {
    return readCounters(owner, kind, id)[category]?.[subject] ?? 0;
}

// The one canonical single-field write path - mirrors incrementStats()'s
// "one choke point" for the batched form.
function incrementStat(owner, kind, id, category, subject, amount = 1) {
    return incrementStats(owner, kind, id, { [category]: { [subject]: amount } })[category][subject];
}

// Batched form: `deltas` = { category: { subject: amount } }, applied in
// one read + one write. Every other write path should funnel into this one.
function incrementStats(owner, kind, id, deltas) {
    const all = readCounters(owner, kind, id);
    const next = { ...all };
    for (const [category, subjects] of Object.entries(deltas)) {
        next[category] = { ...(next[category] ?? {}) };
        for (const [subject, amount] of Object.entries(subjects)) {
            next[category][subject] = (next[category][subject] ?? 0) + amount;
        }
    }
    writeJsonProperty(owner, counterKey(kind, id), next, isValidCounters);
    return next;
}

// Raw replace, for import/purge only.
function replaceCounters(owner, kind, id, counters) {
    if (!counters || Object.keys(counters).length === 0) {
        owner.setDynamicProperty(counterKey(kind, id), undefined);
        return true;
    }
    return writeJsonProperty(owner, counterKey(kind, id), counters, isValidCounters);
}

// ---- Buffered write queue -----------------------------------------------
// Hot gameplay events (a hit landing many times a second in a real fight)
// must never each do a full property read+write. They queue here in
// memory; flushQueuedStats() commits each id's accumulated deltas in one
// batched write on a slow interval. A crash loses at most one interval's
// worth of counter increments - acceptable for aggregates, never used for
// anything load-bearing (that's what recordStore.js is for).
const queued = new Map(); // `${kind}|${ownerId}|${id}` -> { category: { subject: amount } }

function queueStat(kind, ownerId, id, category, subject, amount = 1) {
    if (!ownerId || !id || !amount) return;
    const key = `${kind}|${ownerId}|${id}`;
    let deltas = queued.get(key);
    if (!deltas) { deltas = {}; queued.set(key, deltas); }
    const cat = deltas[category] ?? (deltas[category] = {});
    cat[subject] = (cat[subject] ?? 0) + amount;
}

// `findOwner(ownerId) -> owner|null`. Entries whose owner is currently
// unreachable (e.g. offline) stay queued until they're back.
function flushQueuedStats(findOwner) {
    const flushed = [];
    for (const [key, deltas] of queued) {
        const [kind, ownerId, id] = key.split("|");
        const owner = findOwner(ownerId);
        if (!owner) continue;
        queued.delete(key);
        try {
            incrementStats(owner, kind, id, deltas);
            flushed.push({ owner, kind, id, deltas });
        } catch (e) { console.warn(`[MClite] Stat flush failed for ${kind}/${id}: ${e}`); }
    }
    return flushed;
}

module.exports = { readCounters, readCounter, incrementStat, incrementStats, replaceCounters, queueStat, flushQueuedStats };
