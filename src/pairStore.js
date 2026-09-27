// Generic pairwise relationship store - MClite's "relations" table.
// Generalizes OpenChara's bonds.js: one tiny world-scoped property per
// pair, canonical (sorted) key ordering so A-to-B and B-to-A are the same
// row, sidestepping the O(n^2) single-array sharding problem entirely
// rather than deferring it.
"use strict";

const { readJsonProperty, writeJsonProperty } = require("./dataCore.js");

const kinds = new Map(); // kind -> { tracks }

/**
 * @param {string} kind - e.g. "bond"
 * @param {object} opts
 * @param {string[]} opts.tracks - the named {level, xp} tracks a pair of
 *   this kind maintains (e.g. ["friendship", "rivalry"]). A track added
 *   here later reads as {level:0, xp:0} for every existing pair - no
 *   migration needed.
 */
function registerPairKind(kind, { tracks = [] } = {}) {
    kinds.set(kind, { tracks });
}

function pairKey(kind, idA, idB) {
    const [a, b] = [idA, idB].sort();
    return `mclite:pair:${kind}:${a}:${b}`;
}

function defaultPair(kind) {
    const { tracks } = kinds.get(kind) ?? {};
    if (!tracks) throw new Error(`Unknown pair kind "${kind}" - call registerPairKind() first`);
    const pair = {};
    for (const track of tracks) pair[track] = { level: 0, xp: 0 };
    return pair;
}

function isValidPair(pair) {
    if (!pair || typeof pair !== "object") return false;
    return Object.values(pair).every(t => t && typeof t.level === "number" && typeof t.xp === "number");
}

function readPair(world, kind, idA, idB) {
    return { ...defaultPair(kind), ...readJsonProperty(world, pairKey(kind, idA, idB), {}) };
}

function writePair(world, kind, idA, idB, mutate) {
    const old = readPair(world, kind, idA, idB);
    const next = mutate(old);
    if (!next) return null;
    if (!writeJsonProperty(world, pairKey(kind, idA, idB), next, isValidPair)) return null;
    return next;
}

// Every pair id that appears alongside `id`, found by scanning world
// property ids for this kind's prefix - an occasional/admin-tool
// operation, never a per-tick one (mirrors OpenChara's own
// getDynamicPropertyIds() usage pattern for exactly this reason).
function listPairsFor(world, kind, id) {
    const prefix = `mclite:pair:${kind}:`;
    const out = [];
    for (const key of world.getDynamicPropertyIds()) {
        if (!key.startsWith(prefix)) continue;
        const [a, b] = key.slice(prefix.length).split(":");
        if (a === id) out.push(b);
        else if (b === id) out.push(a);
    }
    return out;
}

module.exports = { registerPairKind, readPair, writePair, listPairsFor };
