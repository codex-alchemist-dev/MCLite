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

test("recordStore: deployments 0/1 alternate on every write (real atomicity, not overwrite-in-place)", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w2", () => ({ name: "v1" }));
    const deployment1 = owner.getDynamicProperty("mclite:widget:w2:active");
    mclite.writeRecord(owner, world, "widget", "w2", old => ({ name: "v2", _prev: old.name }));
    const deployment2 = owner.getDynamicProperty("mclite:widget:w2:active");
    assert.notStrictEqual(deployment1, deployment2, "the current deployment should flip between 0 and 1 on every write");
    // The PREVIOUS deployment is still sitting there fully intact (instant-
    // rollback guarantee) - only the pointer changed.
    const otherDeploymentKey = `mclite:widget:w2:${deployment1}`;
    const rolledBack = JSON.parse(owner.getDynamicProperty(otherDeploymentKey));
    assert.strictEqual(rolledBack.name, "v1", "the previous generation must still be readable, untouched");
});

// ---- recordStore: pin / unpin / rollback / status (OR-Track E1) -----------

test("recordStore: rollback() flips back to the previous generation without a new write", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w6", () => ({ name: "v1" }));
    mclite.writeRecord(owner, world, "widget", "w6", () => ({ name: "v2" }));
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "w6").name, "v2");
    const rolled = mclite.rollback(owner, world, "widget", "w6");
    assert.strictEqual(rolled.name, "v1");
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "w6").name, "v1");
});

test("recordStore: rollback() with only one generation refuses (nothing to roll back to)", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w7", () => ({ name: "only" }));
    assert.strictEqual(mclite.rollback(owner, world, "widget", "w7"), null);
});

test("recordStore: pin() blocks the next write into the pinned deployment, unpin() releases it", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "w8", () => ({ name: "v1" }));
    const pinnedDeployment = mclite.pin(owner, "widget", "w8"); // pins the currently-inactive deployment
    assert.ok(pinnedDeployment === "0" || pinnedDeployment === "1");
    const blocked = mclite.writeRecord(owner, world, "widget", "w8", () => ({ name: "v2" }));
    assert.strictEqual(blocked, null, "a write targeting the pinned deployment must be refused");
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "w8").name, "v1", "the record must be untouched by the refused write");
    mclite.unpin(owner, "widget", "w8");
    const allowed = mclite.writeRecord(owner, world, "widget", "w8", () => ({ name: "v2" }));
    assert.ok(allowed, "a write must succeed again once unpinned");
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "w8").name, "v2");
});

test("recordStore: status() reports deployment/pin/mirror state", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    assert.deepStrictEqual(mclite.status(owner, world, "widget", "w9"), {
        exists: false, currentDeployment: null, pinnedDeployment: null, primaryValid: null, mirrorConsistent: null,
    });
    mclite.writeRecord(owner, world, "widget", "w9", () => ({ name: "v1" }));
    const s = mclite.status(owner, world, "widget", "w9");
    assert.strictEqual(s.exists, true);
    assert.ok(s.currentDeployment === "0" || s.currentDeployment === "1");
    assert.strictEqual(s.pinnedDeployment, null);
    assert.strictEqual(s.primaryValid, true);
    assert.strictEqual(s.mirrorConsistent, true);
    mclite.pin(owner, "widget", "w9");
    assert.notStrictEqual(mclite.status(owner, world, "widget", "w9").pinnedDeployment, null);
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

test("maintenance: scanAndRepair reports a structured pass/fail tally per named check", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    mclite.writeRecord(owner, world, "widget", "m3", () => ({ name: "healthy" }));
    mclite.writeRecord(owner, world, "widget", "m4", () => ({ name: "" }));
    mclite.registerIntegrityCheck("widget", "nonEmptyName", rec => rec.name === "" ? { ok: false, issue: "empty name" } : { ok: true });

    const result = mclite.scanAndRepair(owner, world, "widget", { repair: false });
    assert.ok(result.checks.primaryValid.pass >= 2);
    assert.ok(result.checks.mirrorConsistent.pass >= 2);
    assert.strictEqual(result.checks.nonEmptyName.pass, 1);
    assert.strictEqual(result.checks.nonEmptyName.fail, 1);
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

// ---- query (OR-Track E2) --------------------------------------------------

function makeIndexedWidget(owner, world, id, fields) {
    const rec = mclite.writeRecord(owner, world, "widget", id, () => ({ name: id, ...fields }));
    mclite.upsertIndexEntry(owner, "widget", id, rec);
    return rec;
}

test("query: queryIndex filters the cheap per-owner summaries with a declarative filter", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    makeIndexedWidget(owner, world, "q1", { power: 5 });
    makeIndexedWidget(owner, world, "q2", { power: 15 });
    // Only { name } is in "widget"'s registered index projection - filter on that.
    const matches = mclite.queryIndex(owner, "widget", { field: "name", op: "=", value: "q2" });
    assert.deepStrictEqual(matches.map(e => e.id), ["q2"]);
});

test("query: queryIndex supports all/any/not combinators", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    makeIndexedWidget(owner, world, "q3", {});
    makeIndexedWidget(owner, world, "q4", {});
    const anyMatch = mclite.queryIndex(owner, "widget", { any: [{ field: "name", op: "=", value: "q3" }, { field: "name", op: "=", value: "q4" }] });
    assert.strictEqual(anyMatch.length, 2);
    const notMatch = mclite.queryIndex(owner, "widget", { not: { field: "name", op: "=", value: "q3" } });
    assert.strictEqual(notMatch.some(e => e.id === "q3"), false);
});

test("query: queryRecords loads full records and filters on any field, indexed or not", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    makeIndexedWidget(owner, world, "q5", { power: 5 });
    makeIndexedWidget(owner, world, "q6", { power: 99 });
    const highPower = mclite.queryRecords(owner, world, "widget", rec => rec.power > 50);
    assert.deepStrictEqual(highPower.map(r => r.name), ["q6"]);
});

test("query: queryRecordsWhere applies the declarative filter to full records", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    makeIndexedWidget(owner, world, "q7", { power: 5 });
    makeIndexedWidget(owner, world, "q8", { power: 99 });
    const highPower = mclite.queryRecordsWhere(owner, world, "widget", { field: "power", op: ">=", value: 50 });
    assert.deepStrictEqual(highPower.map(r => r.name), ["q8"]);
});

// ---- vacuum (OR-Track E2) ---------------------------------------------------

test("vacuumRecords: strips dropFields from every indexed record via a real re-commit", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    const rec = mclite.writeRecord(owner, world, "widget", "v1", () => ({ name: "v1", legacyField: "stale" }));
    mclite.upsertIndexEntry(owner, "widget", "v1", rec);
    const { vacuumed, skipped } = mclite.vacuumRecords(owner, world, "widget", { dropFields: ["legacyField"] });
    assert.strictEqual(vacuumed, 1);
    assert.deepStrictEqual(skipped, []);
    const after = mclite.readRecord(owner, world, "widget", "v1");
    assert.strictEqual("legacyField" in after, false);
    assert.strictEqual(after.name, "v1");
});

test("vacuumRecords: a record that becomes invalid after dropping a field is skipped, left untouched", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    const rec = mclite.writeRecord(owner, world, "widget", "v2", () => ({ name: "v2" }));
    mclite.upsertIndexEntry(owner, "widget", "v2", rec);
    // "name" is required by isValidWidget - dropping it must abort the write, not corrupt the record.
    const { vacuumed, skipped } = mclite.vacuumRecords(owner, world, "widget", { dropFields: ["name"] });
    assert.strictEqual(vacuumed, 0);
    assert.deepStrictEqual(skipped, ["v2"]);
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "v2").name, "v2", "the record must be untouched, not half-vacuumed");
});

test("vacuumCounters: flushes the buffered queue exactly like counters.js's own flushQueuedStats", () => {
    const owner = createMockOwner();
    mclite.queueStat("widget", "owner-vac", "v3", "hits", "sword", 3);
    const flushed = mclite.vacuumCounters(id => (id === "owner-vac" ? owner : null));
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(mclite.readCounter(owner, "widget", "v3", "hits", "sword"), 3);
});

// ---- attach (OR-Track E2) ---------------------------------------------------

test("attachPair: joins a pairStore relationship with both sides' actual owner-scoped records", () => {
    const world = createMockOwner("mock:world");
    const ownerA = createMockOwner("mock:ownerA");
    const ownerB = createMockOwner("mock:ownerB");
    const recA = mclite.writeRecord(ownerA, world, "widget", "atA", () => ({ name: "Alpha" }));
    const recB = mclite.writeRecord(ownerB, world, "widget", "atB", () => ({ name: "Beta" }));
    mclite.registerOwner(world, "widget", "atA", "ownerA-id");
    mclite.registerOwner(world, "widget", "atB", "ownerB-id");
    mclite.writePair(world, "friendship", "atA", "atB", old => ({ ...old, closeness: { level: 2, xp: 10 } }));

    const findOwner = id => ({ "ownerA-id": ownerA, "ownerB-id": ownerB }[id] ?? null);
    const joined = mclite.attachPair(world, "friendship", "widget", "atA", "atB", findOwner);
    assert.strictEqual(joined.pair.closeness.level, 2);
    assert.strictEqual(joined.a.record.name, "Alpha");
    assert.strictEqual(joined.b.record.name, "Beta");
    assert.strictEqual(joined.a.ownerId, "ownerA-id");
});

test("attachPair: an id with no registered owner resolves to a null record, not a throw", () => {
    const world = createMockOwner("mock:world");
    const joined = mclite.attachPair(world, "friendship", "widget", "unregisteredA", "unregisteredB", () => null);
    assert.strictEqual(joined.a.record, null);
    assert.strictEqual(joined.b.record, null);
    assert.strictEqual(joined.a.ownerId, null);
});

// ---- adapters (OR-Track E3) -------------------------------------------------

test("createDynamicPropertyAdapter: a pure pass-through, usable anywhere owner/world is", () => {
    const owner = createMockOwner();
    const adapter = mclite.createDynamicPropertyAdapter(owner);
    assert.deepStrictEqual(adapter.capabilities(), { synchronous: true, persistent: true, networked: false });
    // The wrapped adapter works as a drop-in "owner" for the real record API
    // ("widget" is already registered with isValidWidget at the top of this file).
    const world = createMockOwner("mock:world");
    mclite.writeRecord(adapter, world, "widget", "ad1", () => ({ name: "via-adapter" }));
    assert.strictEqual(mclite.readRecord(owner, world, "widget", "ad1").name, "via-adapter", "a write through the adapter must be visible reading the native object directly");
});

test("createDynamicPropertyAdapter: rejects an object missing the required methods", () => {
    assert.throws(() => mclite.createDynamicPropertyAdapter({}), /must implement/);
});

// ---- fulltext (OR-Track E2b) ------------------------------------------------

mclite.registerFulltextField("widget", "name");

function makeSearchableWidget(owner, world, id, name) {
    const rec = mclite.writeRecord(owner, world, "widget", id, () => ({ name }));
    mclite.indexFulltextRecord(owner, "widget", "name", id, rec);
    return rec;
}

test("fulltext: queryFulltext finds a record by a single indexed token", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    makeSearchableWidget(owner, world, "f1", "Frost Marksman Rifle");
    makeSearchableWidget(owner, world, "f2", "Fire Axe");
    const results = mclite.queryFulltext(owner, world, "widget", "name", "frost");
    assert.deepStrictEqual(results.map(r => r.name), ["Frost Marksman Rifle"]);
});

test("fulltext: multiple search tokens are ANDed, not ORed", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    makeSearchableWidget(owner, world, "f3", "Frost Marksman Rifle");
    makeSearchableWidget(owner, world, "f4", "Frost Axe");
    const both = mclite.queryFulltext(owner, world, "widget", "name", "frost marksman");
    assert.deepStrictEqual(both.map(r => r.name), ["Frost Marksman Rifle"]);
    const neither = mclite.queryFulltext(owner, world, "widget", "name", "frost sword");
    assert.deepStrictEqual(neither, []);
});

test("fulltext: reindexing after a content change drops stale token matches", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    makeSearchableWidget(owner, world, "f5", "Old Name");
    assert.strictEqual(mclite.queryFulltext(owner, world, "widget", "name", "old").length, 1);
    makeSearchableWidget(owner, world, "f5", "New Name"); // re-index in place
    assert.strictEqual(mclite.queryFulltext(owner, world, "widget", "name", "old").length, 0);
    assert.strictEqual(mclite.queryFulltext(owner, world, "widget", "name", "new").length, 1);
});

test("fulltext: removeFulltextRecord clears an id out of every token it occupied", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    makeSearchableWidget(owner, world, "f6", "Removable Widget");
    assert.strictEqual(mclite.queryFulltext(owner, world, "widget", "name", "removable").length, 1);
    mclite.removeFulltextRecord(owner, "widget", "name", "f6");
    assert.strictEqual(mclite.queryFulltext(owner, world, "widget", "name", "removable").length, 0);
});

test("fulltext: queryFulltext accepts an additional query.js-style filter on the matched records", () => {
    const owner = createMockOwner();
    const world = createMockOwner("mock:world");
    const recA = mclite.writeRecord(owner, world, "widget", "f7", () => ({ name: "Frost Bow", power: 5 }));
    mclite.indexFulltextRecord(owner, "widget", "name", "f7", recA);
    const recB = mclite.writeRecord(owner, world, "widget", "f8", () => ({ name: "Frost Sword", power: 50 }));
    mclite.indexFulltextRecord(owner, "widget", "name", "f8", recB);
    const strong = mclite.queryFulltext(owner, world, "widget", "name", "frost", { filter: { field: "power", op: ">=", value: 20 } });
    assert.deepStrictEqual(strong.map(r => r.name), ["Frost Sword"]);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
