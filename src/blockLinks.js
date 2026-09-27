// Generic world-position -> record-id links. Generalized from OpenChara's
// blockLinks.js (already fully generic - only the field name was
// character-specific). Useful for anything that anchors a record to a
// place: a home, a shrine, a guard post. Keyed by position so it works
// whether or not the host game's block entities can carry their own
// dynamic properties.
"use strict";

const { readJsonProperty, writeJsonProperty } = require("./dataCore.js");

const PREFIX = "mclite:blockLink:";

function linkKey(dimensionId, pos) {
    return `${PREFIX}${dimensionId.replace("minecraft:", "")}:${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}`;
}

function setBlockLink(world, dimensionId, pos, recordId, kind = "generic") {
    return writeJsonProperty(world, linkKey(dimensionId, pos), { recordId, kind },
        v => typeof v?.recordId === "string" && typeof v?.kind === "string");
}

function getBlockLink(world, dimensionId, pos) {
    return readJsonProperty(world, linkKey(dimensionId, pos), null);
}

function clearBlockLink(world, dimensionId, pos) {
    world.setDynamicProperty(linkKey(dimensionId, pos), undefined);
}

// Every link, parsed: [{ key, dimension, x, y, z, recordId, kind }].
function listBlockLinks(world, filterRecordId = null) {
    const out = [];
    for (const key of world.getDynamicPropertyIds()) {
        if (!key.startsWith(PREFIX)) continue;
        const v = readJsonProperty(world, key, null);
        if (!v || (filterRecordId && v.recordId !== filterRecordId)) continue;
        const [dimension, x, y, z] = key.slice(PREFIX.length).split(":");
        out.push({ key, dimension, x: +x, y: +y, z: +z, ...v });
    }
    return out;
}

function clearLinksFor(world, recordId) {
    for (const link of listBlockLinks(world, recordId)) world.setDynamicProperty(link.key, undefined);
}

module.exports = { setBlockLink, getBlockLink, clearBlockLink, listBlockLinks, clearLinksFor };
