// A minimal stand-in for a Bedrock Player/world object: just the three
// dynamic-property methods every MClite module actually calls. Real
// Bedrock stores dynamic property values as strings - this mock does the
// same (JSON.stringify/parse happens in dataCore.js, not here), so a test
// against this mock exercises the exact same serialization path
// production code does.
"use strict";

function createMockOwner(typeId = "mock:owner") {
    const props = new Map();
    return {
        typeId,
        getDynamicProperty(key) { return props.get(key); },
        setDynamicProperty(key, value) {
            if (value === undefined) props.delete(key);
            else props.set(key, value);
        },
        getDynamicPropertyIds() { return [...props.keys()]; },
        _debugProps: props, // test-only escape hatch, never used by MClite itself
    };
}

module.exports = { createMockOwner };
