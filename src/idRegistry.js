// Generic id generation + world-scoped owner registry. Generalizes
// OpenChara's characterId.js: a record's id is a real UUID v4, globally
// unique by construction - no per-owner counter, no owner-prefix
// concatenation needed anywhere else. The one thing a bare UUID can't tell
// you on its own is *whose* data it lives under (in Bedrock, dynamic
// properties are only readable by asking the actual owning Player object
// for them) - this tiny registry closes that gap for the occasional
// cross-owner lookup.
"use strict";

// No native crypto.randomUUID guaranteed in every Bedrock scripting
// environment - this is the standard Math.random()-based UUID v4
// fallback. Not cryptographically secure, and doesn't need to be: this is
// an identifier, not a secret.
function generateId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function ownerKey(kind, id) { return `mclite:owner:${kind}:${id}`; }

function registerOwner(world, kind, id, ownerId) {
    world.setDynamicProperty(ownerKey(kind, id), ownerId);
}

function resolveOwner(world, kind, id) {
    return world.getDynamicProperty(ownerKey(kind, id)) ?? null;
}

function clearOwner(world, kind, id) {
    world.setDynamicProperty(ownerKey(kind, id), undefined);
}

module.exports = { generateId, registerOwner, resolveOwner, clearOwner };
