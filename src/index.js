// MClite's public entry point - a free, open-source, fully atomic
// database for Minecraft Bedrock. Require this one file to get everything;
// each piece is also requireable on its own (e.g. `require("mclite/src/recordStore.js")`)
// if a consumer only needs part of it.
"use strict";

module.exports = {
    ...require("./dataCore.js"),
    ...require("./recordStore.js"),
    ...require("./idRegistry.js"),
    ...require("./perOwnerIndex.js"),
    ...require("./pairStore.js"),
    ...require("./counters.js"),
    ...require("./blockLinks.js"),
    ...require("./maintenance.js"),
    ...require("./transfer.js"),
};
