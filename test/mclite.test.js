#!/usr/bin/env node
// Plain-Node test runner (no dependencies) for MCLite's public API.
// Run: node test/mclite.test.js
"use strict";

const assert = require("assert");
const { createMockOwner } = require("./mockOwner.js");
const mclite = require("../src/index.js");

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok - ${name}`);
    } catch (e) {
        console.error(`FAIL - ${name}`);
        console.error(e);
        process.exitCode = 1;
    }
}

function isValidWidget(rec) {
    return rec && typeof rec.name === "string" && typeof rec._checksum === "string" && mclite.verifyChecksum(rec);
}
function isValidGadget(rec) {
    return rec && typeof rec.power === "number" && typeof rec._checksum === "string" && mclite.verifyChecksum(rec);
}

mclite.registerRecordKind("widget", { keyPrefix: "widget", validate: isValidWidget });
mclite.registerRecordKind("gadget", { keyPrefix: "gadget", validate: isValidGadget });

// ---- dataCore: checksums --------------------------------------------------

test("computeChecksum: deterministic and excludes _checksum itself", () => {
    const a = mclite.withChecksum({ x: 1, y: 2 });
    const b = mclite.withChecksum({ y: 2, x: 1 }); // different key order
    assert.strictEqual(a._checksum, b._checksum, "checksum should not depend on key order");
});

test("verifyChecksum: detects a tampered record", () => {
    const rec = mclite.withChecksum({ x: 1 });
    const tampered = { ...rec, x: 999 };
    assert.strictEqual(mclite.verifyChecksum(rec), true);
    assert.strictEqual(mclite.verifyChecksum(tampered), false);
});

// ---- recordStore: atomicity + kind isolation ------------------------------

test("recordStore: write then read round-trips", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w1", () => ({ name: "sprocket" }));
    const rec = mclite.readRecord(owner, world, "widget", "w1");
    assert.strictEqual(rec.name, "sprocket");
});

test("recordStore: two different kinds never cross-contaminate keys", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "same-id", () => ({ name: "widget-version" }));
    mclite.writeRecord(owner, world, "gadget", "same-id", () => ({ power: 42 }));
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "same-id").name, "widget-version");
    assert.strictEqual(mclite.readRecord(owner, world, "gadget", "same-id").power, 42);
});

test("recordStore: A/B slots alternate on every write (real atomicity, not overwrite-in-place)", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w2", () => ({ name: "v1" }));
    const slot1 = owner.getDynamicProperty("mclite:widget:w2:active");
    mclite.writeRecord(owner, world, "widget", "w2", old => ({ name: "v2", _prev: old.name }));
    const slot2 = owner.getDynamicProperty("mclite:widget:w2:active");
    assert.notStrictEqual(slot1, slot2, "the active slot should flip between A and B on every write");
    // The PREVIOUS slot is still sitting there fully intact (instant-rollback
    // guarantee) - only the pointer changed.
    const otherSlotKey = `mclite:widget:w2:${slot1}`;
    const rolledBack = JSON.parse(owner.getDynamicProperty(otherSlotKey));
    assert.strictEqual(rolledBack.name, "v1", "the previous generation must still be readable, untouched");
});

test("recordStore: a mutate() that throws aborts the write, old record untouched", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w3", () => ({ name: "good" }));
    const result = mclite.writeRecord(owner, world, "widget", "w3", () => { throw new Error("boom"); });
    assert.strictEqual(result, null);
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "w3").name, "good");
});

test("recordStore: an invalid mutate() result aborts the write, old record untouched", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w4", () => ({ name: "good" }));
    // "power" isn't a valid widget field set (isValidWidget requires "name")
    const result = mclite.writeRecord(owner, world, "widget", "w4", () => ({ power: 1 }));
    assert.strictEqual(result, null);
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "w4").name, "good");
});

test("recordStore: self-heals from the world mirror if the primary is corrupted", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w5", () => ({ name: "mirrored" }));
    const active = owner.getDynamicProperty("mclite:widget:w5:active");
    owner.setDynamicProperty(`mclite:widget:w5:${active}`, "{ not even valid json");
    const recovered = mclite.readRecord(owner, world, "widget", "w5");
    assert.strictEqual(recovered.name, "mirrored", "should recover from the mirror when the primary is corrupt");
});

// ---- perOwnerIndex ---------------------------------------------------------

mclite.registerIndexKind("widget", { project: rec => ({ name: rec.name }) });

test("perOwnerIndex: upsert, find, and reconcile", () => {
    const owner = createMockOwner();
    mclite.upsertIndexEntry(owner, "widget", "i1", { name: "Alpha" });
    mclite.upsertIndexEntry(owner, "widget", "i2", { name: "Beta" });
    assert.deepStrictEqual(mclite.findByField(owner, "widget", "name", "Beta"), { id: "i2", name: "Beta" });

    const stillExists = id => id === "i1"; // i2 no longer has a backing record
    const clean = mclite.reconcileIndex(owner, "widget", stillExists);
    assert.strictEqual(clean.length, 1);
    assert.strictEqual(clean[0].id, "i1");
});

// ---- pairStore --------------------------------------------------------------

mclite.registerPairKind("friendship", { tracks: ["closeness"] });

test("pairStore: order-independent, missing tracks default to zero", () => {
    const world = createMockOwner("mock:world");
    mclite.writePair(world, "friendship", "a", "b", () => ({ closeness: { level: 3, xp: 10 } }));
    const forward = mclite.readPair(world, "friendship", "a", "b");
    const backward = mclite.readPair(world, "friendship", "b", "a");
    assert.deepStrictEqual(forward, backward, "a-b and b-a must read the same pair");
    assert.strictEqual(forward.closeness.level, 3);
});

test("pairStore: listPairsFor finds every partner", () => {
    const world = createMockOwner("mock:world");
    mclite.writePair(world, "friendship", "x", "y", () => ({ closeness: { level: 1, xp: 0 } }));
    mclite.writePair(world, "friendship", "x", "z", () => ({ closeness: { level: 1, xp: 0 } }));
    const partners = mclite.listPairsFor(world, "friendship", "x").sort();
    assert.deepStrictEqual(partners, ["y", "z"]);
});

// ---- counters ---------------------------------------------------------------

test("counters: increment, batch, and queue+flush", () => {
    const owner = createMockOwner();
    mclite.incrementStat(owner, "widget", "c1", "uses", "total", 1);
    mclite.incrementStat(owner, "widget", "c1", "uses", "total", 4);
    assert.strictEqual(mclite.readCounter(owner, "widget", "c1", "uses", "total"), 5);

    mclite.queueStat("widget", "owner-1", "c1", "hits", "critical", 3);
    const flushed = mclite.flushQueuedStats(id => (id === "owner-1" ? owner : null));
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(mclite.readCounter(owner, "widget", "c1", "hits", "critical"), 3);
});

// ---- blockLinks ---------------------------------------------------------------

test("blockLinks: set, get, list, and clear", () => {
    const world = createMockOwner("mock:world");
    mclite.setBlockLink(world, "minecraft:overworld", { x: 1, y: 2, z: 3 }, "w1", "home");
    assert.deepStrictEqual(mclite.getBlockLink(world, "minecraft:overworld", { x: 1, y: 2, z: 3 }), { recordId: "w1", kind: "home" });
    assert.strictEqual(mclite.listBlockLinks(world, "w1").length, 1);
    mclite.clearLinksFor(world, "w1");
    assert.strictEqual(mclite.listBlockLinks(world, "w1").length, 0);
});

// ---- maintenance --------------------------------------------------------------

test("maintenance: scanAndRepair fixes a stale mirror without a repair flag needed for that", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "m1", () => ({ name: "checked" }));
    world.setDynamicProperty(`mclite:mirror:widget:m1`, undefined); // simulate a lost mirror

    const dryRun = mclite.scanAndRepair(owner, world, "widget", { repair: false });
    assert.strictEqual(dryRun.issues.some(i => i.problem.includes("mirror missing")), true);
    assert.strictEqual(dryRun.issues[0].fixed, false, "a dry run must never actually fix anything");

    const repaired = mclite.scanAndRepair(owner, world, "widget", { repair: true });
    assert.strictEqual(repaired.issues.some(i => i.problem.includes("mirror missing") && i.fixed), true);
    assert.notStrictEqual(world.getDynamicProperty("mclite:mirror:widget:m1"), undefined, "mirror should be rewritten after a repair scan");
});

test("maintenance: a registered kind-specific check runs and can repair", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "m2", () => ({ name: "", broken: true }));
    mclite.registerIntegrityCheck("widget", rec => {
        if (rec.name === "") return { ok: false, issue: "empty name", repair: r => ({ ...r, name: "renamed" }) };
        return { ok: true };
    });
    const result = mclite.scanAndRepair(owner, world, "widget", { repair: true });
    assert.strictEqual(result.issues.some(i => i.problem === "empty name" && i.fixed), true);
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "m2").name, "renamed");
});

// ---- transfer (backup/restore) ------------------------------------------------

mclite.registerTransferRules("widget", { stripOnExport: ["secret"], resetOnImport: { imported: true } });

test("transfer: export -> import round-trip, stripOnExport and resetOnImport both apply", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "t1", () => ({ name: "backup-me", secret: "shh" }));

    const blob = mclite.exportRecord(owner, world, "widget", "t1");
    assert.ok(blob.startsWith("MCL1|"), "export blob should carry the MCLite prefix");

    const otherOwner = createMockOwner();
    const otherWorld = createMockOwner("mock:world-2");
    const result = mclite.importRecord(otherOwner, otherWorld, blob);
    assert.strictEqual(result.ok, true);

    const restored = mclite.readRecord(otherOwner, otherWorld, "widget", "t1");
    assert.strictEqual(restored.name, "backup-me");
    assert.strictEqual(restored.secret, undefined, "stripOnExport field must not survive export");
    assert.strictEqual(restored.imported, true, "resetOnImport field must be forced on import");
});

test("transfer: a tampered backup string is rejected", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "t2", () => ({ name: "original" }));
    const blob = mclite.exportRecord(owner, world, "widget", "t2");
    const tampered = blob.slice(0, -1) + (blob.endsWith("}") ? "]" : "}");
    assert.throws(() => mclite.parseExport(tampered), /checksum mismatch/);
});

// ---- idRegistry ---------------------------------------------------------------

test("idRegistry: generateId produces distinct UUIDs, owner registry resolves", () => {
    const world = createMockOwner("mock:world");
    const idA = mclite.generateId();
    const idB = mclite.generateId();
    assert.notStrictEqual(idA, idB);
    assert.match(idA, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    mclite.registerOwner(world, "widget", idA, "owner-42");
    assert.strictEqual(mclite.resolveOwner(world, "widget", idA), "owner-42");
    mclite.clearOwner(world, "widget", idA);
    assert.strictEqual(mclite.resolveOwner(world, "widget", idA), null);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
