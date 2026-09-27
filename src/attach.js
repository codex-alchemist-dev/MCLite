// ATTACH - SQLite lets a query join across two otherwise-separate database
// files. MCLite's analogous split is real: pairStore.js's relationships
// live in world-scoped properties (a pair can span two different owners'
// records entirely), while recordStore.js's records live under each
// record's own owner. Resolving "the pair between A and B, plus both of
// their actual records" today means three separate lookups (the pair, each
// id's owner via idRegistry.js, then each owner's record) - this module is
// that join done once, in one call.
//
// `findOwner(ownerId) -> owner|null` is supplied by the caller (mirrors
// counters.js's flushQueuedStats(findOwner) convention) - MCLite itself
// never knows how to turn an owner id into a real owner object; only the
// consuming project/environment does (e.g. `world.getAllPlayers()` in
// real Bedrock).
//
// See "OpenRock Ecosystem Expansion Roadmap", OR-Track E2, in the project
// plan document (the SQLite-concept mapping table).
"use strict";

const { readPair } = require("./pairStore.js");
const { resolveOwner } = require("./idRegistry.js");
const { readRecord } = require("./recordStore.js");

/**
 * @param {object} world
 * @param {string} pairKind - a kind registered with pairStore.registerPairKind()
 * @param {string} recordKind - a kind registered with recordStore.registerRecordKind()
 *   (and, for owner resolution to work, one whose ids were registered via
 *   idRegistry.registerOwner() at creation time)
 * @param {string} idA
 * @param {string} idB
 * @param {(ownerId: string) => object|null} findOwner
 * @returns {{
 *   pair: object,
 *   a: { id: string, ownerId: string|null, record: object|null },
 *   b: { id: string, ownerId: string|null, record: object|null },
 * }}
 */
function attachPair(world, pairKind, recordKind, idA, idB, findOwner) {
    const pair = readPair(world, pairKind, idA, idB);
    const side = id => {
        const ownerId = resolveOwner(world, recordKind, id);
        const owner = ownerId ? findOwner(ownerId) : null;
        const record = owner ? readRecord(owner, world, recordKind, id) : null;
        return { id, ownerId, record };
    };
    return { pair, a: side(idA), b: side(idB) };
}

module.exports = { attachPair };
