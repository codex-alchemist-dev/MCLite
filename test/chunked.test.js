#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { createMockOwner } = require("./mockOwner.js");
const mclite = require("../src/index.js");

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`ok - ${name}`); }
    catch (e) { console.error(`FAIL - ${name}`); console.error(e); process.exitCode = 1; }
}

mclite.registerChunkedKind("blob", { keyPrefix: "blob" });
const fresh = () => ({ owner: createMockOwner(), world: createMockOwner("mock:world") });
const big = n => Array.from({ length: n }, (_, i) => `row${i}:"quoted"\\n`).join("|");

test("chunked: round-trips a payload far over the 32KB per-property ceiling", () => {
    const { owner, world } = fresh();
    const payload = big(20000);
    assert.ok(payload.length > 200000);
    const m = mclite.writeChunked(owner, world, "blob", "a", payload);
    assert.ok(m.parts > 5);
    for (const key of owner.getDynamicPropertyIds()) assert.ok(String(owner.getDynamicProperty(key)).length <= 32000, key);
    assert.strictEqual(mclite.readChunked(owner, world, "blob", "a"), payload);
});

test("chunked: empty payload and tiny payload", () => {
    const { owner, world } = fresh();
    assert.ok(mclite.writeChunked(owner, world, "blob", "e", ""));
    assert.strictEqual(mclite.readChunked(owner, world, "blob", "e"), "");
    mclite.writeChunked(owner, world, "blob", "t", "x");
    assert.strictEqual(mclite.readChunked(owner, world, "blob", "t"), "x");
});

test("chunked: a failed write (storage throws mid-way) leaves the previous payload intact; orphan parts are found and swept", () => {
    const { owner, world } = fresh();
    mclite.writeChunked(owner, world, "blob", "k", "first");
    const realSet = owner.setDynamicProperty.bind(owner);
    let calls = 0;
    owner.setDynamicProperty = (k, v) => { if (v !== undefined && k.includes("blob~") && ++calls === 3) throw new Error("boom"); return realSet(k, v); };
    assert.throws(() => mclite.writeChunked(owner, world, "blob", "k", big(5000), { partChars: 3000 }));
    owner.setDynamicProperty = realSet;
    assert.strictEqual(mclite.readChunked(owner, world, "blob", "k"), "first");
    assert.ok(mclite.sweepOrphanParts(owner, world, "blob", { repair: true }) > 0);
    assert.strictEqual(mclite.sweepOrphanParts(owner, world, "blob", { repair: false }), 0);
});

test("chunked: corrupt current generation falls back to the previous one", () => {
    const { owner, world } = fresh();
    mclite.writeChunked(owner, world, "blob", "g", big(3000), { partChars: 2000 });
    const v1 = mclite.readChunked(owner, world, "blob", "g");
    mclite.writeChunked(owner, world, "blob", "g", big(3500), { partChars: 2000 });
    for (const key of [...owner.getDynamicPropertyIds()]) if (key.startsWith("mclite:blob~:g.2.1:")) owner.setDynamicProperty(key, "{garbage");
    for (const key of [...world.getDynamicPropertyIds()]) if (key.startsWith("mclite:mirror:blob~:g.2.1")) world.setDynamicProperty(key, "{garbage");
    assert.strictEqual(mclite.readChunked(owner, world, "blob", "g"), v1);
});

test("chunked: a damaged primary part is healed from its mirror transparently", () => {
    const { owner, world } = fresh();
    const payload = big(4000);
    mclite.writeChunked(owner, world, "blob", "h", payload, { partChars: 2500 });
    for (const key of [...owner.getDynamicPropertyIds()]) if (key.startsWith("mclite:blob~:h.1.0:") && key.endsWith(":0")) owner.setDynamicProperty(key, "{garbage");
    assert.strictEqual(mclite.readChunked(owner, world, "blob", "h"), payload);
});

test("chunked: overwrite keeps only two generations; delete removes everything", () => {
    const { owner, world } = fresh();
    for (let g = 1; g <= 4; g++) mclite.writeChunked(owner, world, "blob", "d", big(1000 * g), { partChars: 1500 });
    const gens = new Set(mclite.discoverIds(owner, world, "blob~part").map(id => id.split(".")[1]));
    assert.deepStrictEqual([...gens].sort(), ["3", "4"]);
    assert.strictEqual(mclite.deleteChunked(owner, world, "blob", "d"), true);
    assert.deepStrictEqual(owner.getDynamicPropertyIds(), []);
    assert.deepStrictEqual(world.getDynamicPropertyIds(), []);
    assert.strictEqual(mclite.readChunked(owner, world, "blob", "d"), null);
});

test("deleteRecord: removes both deployments, pointer, pin and mirror", () => {
    const { owner, world } = fresh();
    mclite.registerRecordKind("dr", { keyPrefix: "dr", validate: r => mclite.verifyChecksum(r) });
    mclite.writeRecord(owner, world, "dr", "x", () => ({ a: 1 }));
    mclite.writeRecord(owner, world, "dr", "x", () => ({ a: 2 }));
    mclite.deleteRecord(owner, world, "dr", "x");
    assert.deepStrictEqual([owner.getDynamicPropertyIds(), world.getDynamicPropertyIds()], [[], []]);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
