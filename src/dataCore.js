// Generic data-integrity core: checksums and copy-validate-commit
// dynamic-property read/write. Moved verbatim from OpenChara's
// dataCore.js - this part was already fully generic there (no
// character-specific imports at all). See "OpenRock Mod Packager —
// Phased Implementation Plan", OR-Phase 4, in the project plan document.
"use strict";

const TAG = "MCLite";

// ---- Generic checksum --------------------------------------------------
// Cheap, non-cryptographic. Computed over the JSON of the record with
// `_checksum` itself excluded (it can't include its own value).
function computeChecksum(obj) {
    const { _checksum, ...rest } = obj;
    const str = JSON.stringify(rest, Object.keys(rest).sort());
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
}

function withChecksum(obj) {
    const clone = { ...obj };
    clone._checksum = computeChecksum(clone);
    return clone;
}

function verifyChecksum(obj) {
    if (!obj || typeof obj !== "object" || typeof obj._checksum !== "string") return false;
    return obj._checksum === computeChecksum(obj);
}

// ---- Generic copy-validate-commit dynamic-property helpers -------------
// Any structure at all - a record, an index, a counters blob - can use
// these two directly for its own read/write; nothing here assumes any
// particular key shape or record kind.

function readJsonProperty(owner, key, fallback = undefined) {
    const raw = owner.getDynamicProperty(key);
    if (raw === undefined) return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.warn(`[${TAG}] Corrupt JSON at property "${key}" on ${owner?.typeId ?? "world"}: ${e}`);
        return fallback;
    }
}

// validate: (value) => true/false. Throws away the write (leaves the key
// completely untouched) if validation fails - never a partial write.
function writeJsonProperty(owner, key, value, validate) {
    if (validate && !validate(value)) {
        console.warn(`[${TAG}] Rejected write to "${key}": failed validation.`);
        return false;
    }
    const raw = value === undefined ? undefined : JSON.stringify(value);
    // Bedrock's own per-string-property ceiling; fail loudly rather than
    // silently truncating data.
    if (raw !== undefined && raw.length > 32000) {
        console.warn(`[${TAG}] Rejected write to "${key}": ${raw.length} bytes exceeds safe ceiling.`);
        return false;
    }
    owner.setDynamicProperty(key, raw);
    return true;
}

module.exports = { TAG, computeChecksum, withChecksum, verifyChecksum, readJsonProperty, writeJsonProperty };
