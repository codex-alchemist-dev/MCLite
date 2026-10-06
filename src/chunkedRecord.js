// Chunked records - one logical payload (a string of any size) stored as many small atomic records, so it
// survives the 32 KB-per-property ceiling without leaving the record layer (every part keeps its own A/B
// deployments, checksum and world mirror, and a future storage backend sees only ordinary records).
//
// Layout for a chunked kind K with id I:
//   manifest   record kind K,          id I                -> { gen, parts, length, sum, prevGen, prevParts }
//   part       record kind K~part,     id I.<gen>.<index>  -> { data }
// A write stores ALL parts of a new generation first and the manifest LAST; the manifest write is the commit
// point. The previous generation's parts stay until the next write, so a corrupt current generation can fall
// back to the previous manifest (rollback) and still read complete data.
"use strict";

const { computeChecksum, verifyChecksum } = require("./dataCore.js");
const { registerRecordKind, readRecord, writeRecord, deleteRecord, rollback, getKindConfig } = require("./recordStore.js");
const { discoverIds } = require("./maintenance.js");

const SERIALIZED_LIMIT = 30000; // under dataCore's 32000 ceiling, leaving room for the record envelope
const DEFAULT_PART_CHARS = 24000;

const partKindOf = kind => `${kind}~part`;
const partId = (id, gen, i) => `${id}.${gen}.${i}`;
const payloadSum = payload => computeChecksum({ d: payload });

function isValidManifest(m) {
    return Boolean(m) && Number.isInteger(m.gen) && Number.isInteger(m.parts) && m.parts >= 0 && Number.isInteger(m.length)
        && typeof m.sum === "string" && Number.isInteger(m.prevGen) && Number.isInteger(m.prevParts) && verifyChecksum(m);
}
const isValidPart = p => Boolean(p) && typeof p.data === "string" && verifyChecksum(p);

/** Declares chunked kind `kind` (its manifest) and `kind~part` (its parts). Call once at startup. */
function registerChunkedKind(kind, { keyPrefix } = {}) {
    if (typeof keyPrefix !== "string" || !keyPrefix) throw new Error(`registerChunkedKind("${kind}"): keyPrefix is required`);
    registerRecordKind(kind, { keyPrefix, validate: isValidManifest });
    registerRecordKind(partKindOf(kind), { keyPrefix: `${keyPrefix}~`, validate: isValidPart });
}

function requireChunked(kind) {
    if (!getKindConfig(kind) || !getKindConfig(partKindOf(kind))) throw new Error(`Unknown chunked kind "${kind}" - call registerChunkedKind() first`);
}

function split(payload, partChars) {
    const parts = [];
    let pos = 0;
    while (pos < payload.length) {
        let size = Math.min(partChars, payload.length - pos);
        // JSON escaping can make a slice longer than its raw length; shrink until the serialized part fits.
        while (JSON.stringify({ data: payload.slice(pos, pos + size), _checksum: "ffffffff" }).length > SERIALIZED_LIMIT && size > 1) size = Math.floor(size * 0.9);
        parts.push(payload.slice(pos, pos + size));
        pos += size;
    }
    return parts;
}

function deleteParts(owner, world, kind, id, gen, count) {
    for (let i = 0; i < count; i++) deleteRecord(owner, world, partKindOf(kind), partId(id, gen, i));
}

/**
 * @returns {object|null} the committed manifest, or null if nothing changed (a part or the manifest failed to commit).
 */
function writeChunked(owner, world, kind, id, payload, { partChars = DEFAULT_PART_CHARS } = {}) {
    requireChunked(kind);
    if (typeof payload !== "string") throw new Error(`writeChunked("${kind}", ${id}): payload must be a string`);
    const old = readRecord(owner, world, kind, id);
    const gen = (old?.gen ?? 0) + 1;
    const pieces = split(payload, partChars);

    for (let i = 0; i < pieces.length; i++) {
        const written = writeRecord(owner, world, partKindOf(kind), partId(id, gen, i), () => ({ data: pieces[i] }));
        if (!written) { deleteParts(owner, world, kind, id, gen, i + 1); return null; }
    }
    const manifest = writeRecord(owner, world, kind, id, () => ({
        gen, parts: pieces.length, length: payload.length, sum: payloadSum(payload),
        prevGen: old?.gen ?? 0, prevParts: old?.parts ?? 0,
    }));
    if (!manifest) { deleteParts(owner, world, kind, id, gen, pieces.length); return null; }

    // The generation before the previous one can no longer be rolled back to.
    if (old && old.prevGen > 0) deleteParts(owner, world, kind, id, old.prevGen, old.prevParts);
    return manifest;
}

function assemble(owner, world, kind, id, manifest) {
    const chunks = [];
    for (let i = 0; i < manifest.parts; i++) {
        const part = readRecord(owner, world, partKindOf(kind), partId(id, manifest.gen, i));
        if (!part) return null;
        chunks.push(part.data);
    }
    const payload = chunks.join("");
    return payload.length === manifest.length && payloadSum(payload) === manifest.sum ? payload : null;
}

/** @returns {string|null} the payload; on corruption falls back to the previous generation (via manifest rollback) once. */
function readChunked(owner, world, kind, id) {
    requireChunked(kind);
    const manifest = readRecord(owner, world, kind, id);
    if (!manifest) return null;
    const payload = assemble(owner, world, kind, id, manifest);
    if (payload !== null) return payload;
    console.warn(`[MCLite] chunked "${kind}" ${id} generation ${manifest.gen} is incomplete or corrupt - rolling back to the previous generation.`);
    const previous = rollback(owner, world, kind, id);
    return previous ? assemble(owner, world, kind, id, previous) : null;
}

/** Permanently removes the payload, both retained generations of parts, and the manifest. */
function deleteChunked(owner, world, kind, id) {
    requireChunked(kind);
    const manifest = readRecord(owner, world, kind, id);
    if (manifest) {
        deleteParts(owner, world, kind, id, manifest.gen, manifest.parts);
        if (manifest.prevGen > 0) deleteParts(owner, world, kind, id, manifest.prevGen, manifest.prevParts);
    }
    deleteRecord(owner, world, kind, id);
    return Boolean(manifest);
}

/**
 * Integrity helper: part records that no manifest references (an interrupted write, or a manifest that vanished).
 * @returns {number} how many orphan parts were removed (or would be, with {repair:false}).
 */
function sweepOrphanParts(owner, world, kind, { repair = true } = {}) {
    requireChunked(kind);
    const keep = new Set();
    for (const id of discoverIds(owner, world, kind)) {
        const m = readRecord(owner, world, kind, id);
        if (!m) continue;
        for (let i = 0; i < m.parts; i++) keep.add(partId(id, m.gen, i));
        for (let i = 0; i < m.prevParts; i++) keep.add(partId(id, m.prevGen, i));
    }
    let orphans = 0;
    for (const pid of discoverIds(owner, world, partKindOf(kind))) {
        if (keep.has(pid)) continue;
        orphans++;
        if (repair) deleteRecord(owner, world, partKindOf(kind), pid);
    }
    return orphans;
}

module.exports = { registerChunkedKind, writeChunked, readChunked, deleteChunked, sweepOrphanParts };
