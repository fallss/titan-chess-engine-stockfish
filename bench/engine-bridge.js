// ============================================================
// bench :: engine bridge — runs the extension's stockfish WASM
// under node for benchmarking.
// ============================================================
//
// nmrugg's stockfish.js exports a STOCKFISH factory in node:
//   const engine = STOCKFISH(wasmPath)
//   engine.onmessage = line => ...   (engine → us)
//   engine.postMessage(cmd)          (us → engine)
//
// this bridge wires that factory to stdin/stdout so the harness
// can speak plain UCI to the exact same binary the extension uses.
//
// usage: node bench/engine-bridge.js   (UCI on stdin/stdout)
//
// NODE 18+ FIX:
//   Node ≥18 ships a global fetch(), which triggers the emscripten
//   loader's instantiateAsync path; it calls fetch("/abs/path.wasm")
//   and throws "Failed to parse URL". Neutralize it BEFORE loading
//   stockfish.js. Without this the bridge dies at boot.
//
// EXIT POLICY:
//   'quit'/'exit' is forwarded to the engine, then the bridge waits
//   for the engine to go quiet before exiting (the engine queues
//   commands until WASM boot completes, so exiting right after
//   forwarding 'quit' raced the boot and dropped all output — the
//   original failure mode). On stdin EOF the bridge likewise waits
//   for quiet, with hard caps so a hung engine cannot hang the
//   harness. Tune via BENCH_* env vars.
// ============================================================

'use strict';

// --- Node ≥18 fetch workaround (must precede stockfish.js load) ---
global.fetch = undefined;

const path = require('path');
const readline = require('readline');

const QUIET_MS     = Number(process.env.BENCH_QUIET_MS      || 500);   // silence after 'quit' before exit
const EOF_QUIET_MS = Number(process.env.BENCH_EOF_QUIET_MS  || 1000);  // silence after stdin EOF before exit
const QUIT_CAP_MS  = Number(process.env.BENCH_QUIT_CAP_MS   || 5000);  // hard cap after 'quit'
const EOF_CAP_MS   = Number(process.env.BENCH_EOF_CAP_MS    || 10000); // hard cap after EOF

const STOCKFISH = require('../engine/stockfish.js');
const engine = STOCKFISH(path.join(__dirname, '..', 'engine', 'stockfish.wasm'));

let lastOutput = Date.now();
let sawOutput = false;
let sawError = false;

// engine → stdout
engine.onmessage = (line) => {
    lastOutput = Date.now();
    sawOutput = true;
    process.stdout.write(line + '\n');
};

// boot/runtime errors surface through console.error
const origError = console.error;
console.error = (...args) => {
    sawError = true;
    origError(...args);
};

let quitRequested = false;
let exitTimer = null;

function finish(code) {
    try { engine.postMessage('quit'); } catch (e) {}
    setTimeout(() => process.exit(code), 50);
}

function armExit(capMs) {
    if (exitTimer) clearInterval(exitTimer);
    const armStart = Date.now();
    exitTimer = setInterval(() => {
        const now = Date.now();
        const quietMs = quitRequested ? QUIET_MS : EOF_QUIET_MS;
        if (now - lastOutput >= quietMs) finish(0);
        if (now - armStart >= capMs) finish(sawOutput ? 0 : 1);
    }, 50);
    if (exitTimer.unref) exitTimer.unref();
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});

rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    if (line === 'quit' || line === 'exit') {
        quitRequested = true;
        engine.postMessage(line);
        armExit(QUIT_CAP_MS);
        return;
    }
    engine.postMessage(line);
});

rl.on('close', () => {
    if (!quitRequested) armExit(EOF_CAP_MS);
});
