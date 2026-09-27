// Generic export/import - MCLite's backup/restore mechanism. A record
// serializes to a single self-checksummed text string that survives even
// total loss of the world save; import verifies that checksum before
// writing anything, so a truncated or hand-edited string is rejected
// outright rather than half-applied. Generalizes OpenChara's dbTransfer.js,
// whose stripped/reset field names (stats, manifestedEntityId, squadId)
// were hardcoded - here a record kind registers its own rules.
"use strict";

const { computeChecksum } = require("./dataCore.js");
const { readRecord, writeRecord, getKindConfig } = require("./recordStore.js");

const PREFIX = "MCL1";
const kindRules = new Map(); // kind -> { stripOnExport, resetOnImport }

/**
 * @param {string} kind
 * @param {object} opts
 * @param {string[]} [opts.stripOnExport] - field names to delete before
 *   export (instance-only/world-specific fields that would be wrong in
 *   any other world anyway).
 * @param {object} [opts.resetOnImport] - field -> value to force on import
 *   (e.g. { squadId: null } - a fresh import never keeps a stale
 *   membership from the world it came from).
 */
function registerTransferRules(kind, { stripOnExport = [], resetOnImport = {} } = {}) {
    kindRules.set(kind, { stripOnExport, resetOnImport });
}

function exportRecord(owner, world, kind, id, record) {
    const rec = record ?? readRecord(owner, world, kind, id);
    if (!rec) throw new Error(`exportRecord("${kind}", ${id}): no such record`);
    const { stripOnExport = [] } = kindRules.get(kind) ?? {};
    const portable = { ...rec };
    delete portable._checksum;
    for (const field of stripOnExport) delete portable[field];
    const payload = JSON.stringify({ kind, id, record: portable });
    const sum = computeChecksum({ payload });
    return `${PREFIX}|${sum}|${payload}`;
}

/**
 * Parses + verifies without writing anything.
 * @returns {{ kind: string, id: string, record: object }}
 */
function parseExport(text) {
    const trimmed = (text ?? "").trim();
    const first = trimmed.indexOf("|");
    const second = trimmed.indexOf("|", first + 1);
    if (first < 0 || second < 0 || trimmed.slice(0, first) !== PREFIX) throw new Error("Not an MCLite backup string.");
    const sum = trimmed.slice(first + 1, second);
    const payload = trimmed.slice(second + 1);
    if (computeChecksum({ payload }) !== sum) throw new Error("Backup checksum mismatch - the text was cut off or edited.");
    let data;
    try { data = JSON.parse(payload); } catch (e) { throw new Error("Backup text is damaged (bad JSON)."); }
    if (typeof data?.kind !== "string" || typeof data?.id !== "string" || !data.record) throw new Error("Backup is missing its kind, id, or record.");
    return data;
}

/**
 * Import semantics are "restore", not "clone": the record keeps its
 * original id. Refuses if that id already resolves to a real record for
 * this owner/kind - importing is for recovering a lost/backed-up record,
 * not duplicating an existing one.
 * @param {(id: string) => boolean} [exists] - optional pre-check; if
 *   omitted, writeRecord()'s own mutate() still won't overwrite silently
 *   since the caller decides what "already exists" means for their kind.
 * @returns {{ ok: boolean, reason?: string, id?: string }}
 */
function importRecord(owner, world, text, { exists } = {}) {
    const { kind, id, record } = parseExport(text);
    const config = getKindConfig(kind);
    if (!config) return { ok: false, reason: `Unknown record kind "${kind}" - is the right library loaded?` };
    if (exists && exists(id)) return { ok: false, reason: `A record with id ${id} already exists.` };

    const { resetOnImport = {} } = kindRules.get(kind) ?? {};
    const restored = { ...record, ...resetOnImport, _checksum: "" };
    const committed = writeRecord(owner, world, kind, id, () => restored);
    if (!committed) return { ok: false, reason: "Write failed - the backup record failed validation, nothing was changed." };
    return { ok: true, id, kind };
}

module.exports = { registerTransferRules, exportRecord, parseExport, importRecord };
