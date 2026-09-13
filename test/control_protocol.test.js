"use strict";

// Lightweight host-level test. It loads the browser host with a fake
// WebSocket and checks the same envelopes that the native host emits.
const assert = require("assert");
const path = require("path");
process.chdir(path.join(__dirname, ".."));

const sent = [];
class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        FakeWebSocket.instance = this;
    }
    send(message) { sent.push(JSON.parse(message)); }
}
FakeWebSocket.OPEN = 1;

global.window = {
    location: {
        search: "?control=ws://127.0.0.1:8765",
        hash: "",
    },
};
global.WebSocket = FakeWebSocket;
require("../src/app.js");

assert.strictEqual(global.MlREGL.debugEnabled(), true);
global.MlREGL.emitDebug({ kind: "state", level: "info",
    payload: '{"scene":"intro","frame":12}' });
FakeWebSocket.instance.onopen();
global.MlREGL.emitDebug({ kind: "log", level: "warning",
    payload: "slow frame" });

assert.deepStrictEqual(sent[0], {
    type: "state",
    state: { scene: "intro", frame: 12 },
});
assert.strictEqual(sent[1].type, "hello");
assert.strictEqual(sent[1].protocol, 1);
assert.strictEqual(sent[2].type, "log");
assert.strictEqual(sent[2].level, "warning");
assert.strictEqual(sent[2].message, "slow frame");
console.log("control_protocol.test: ok");
