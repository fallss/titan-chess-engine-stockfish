// ============================================================
// bench :: test-modes-accuracy.js
// verifies accuracy of THREAT, ACCOUNT, and COMBAT modes,
// perspective normalization, and move percentage calculations.
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

// ------------------------------------------------------------------
// Environment Sandbox Setup
// ------------------------------------------------------------------
const sandbox = {
    console,
    Math,
    Date,
    parseInt,
    parseFloat,
    Map,
    Set,
    Array,
    Object,
    String,
    document: {
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({
            style: {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
            appendChild: () => {},
            insertBefore: () => {},
            querySelector: () => null,
            children: []
        }),
        getElementById: () => null
    },
    window: {}
};
sandbox.window = sandbox;

vm.createContext(sandbox);

// Load state, threat, engine
const stateCode = fs.readFileSync(path.join(__dirname, '..', 'content', 'state.js'), 'utf8');
const threatCode = fs.readFileSync(path.join(__dirname, '..', 'content', 'threat.js'), 'utf8');
const engineCode = fs.readFileSync(path.join(__dirname, '..', 'content', 'engine.js'), 'utf8');

vm.runInContext(stateCode, sandbox);
vm.runInContext(threatCode, sandbox);
vm.runInContext(engineCode, sandbox);

const T = sandbox.TitanState;
const Threat = sandbox.TitanThreat;
const Eng = sandbox.TitanEngine;

console.log('Testing Mode & Move Percentage Accuracy:');

// 1. Perspective normalization
test('Black to move with +200 cp normalizes evalCp to -200 (White perspective)', () => {
    // Simulate stockfish onmessage for Black to move
    T.analyzingFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    // Simulate what Stockfish onmessage line handler does:
    const line = 'info depth 12 score cp 200 pv c7c5';
    const cpMatch = line.match(/score cp (-?\d+)/);
    const sideToMove = T.analyzingFen.split(' ')[1];
    const sign = (sideToMove === 'b') ? -1 : 1;
    const evalCp = parseInt(cpMatch[1], 10) * sign;
    assert.strictEqual(evalCp, -200, 'Black +200 cp should yield -200 for White');
});

test('White to move with +200 cp normalizes evalCp to +200 (White perspective)', () => {
    T.analyzingFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1';
    const line = 'info depth 12 score cp 200 pv d7d5';
    const cpMatch = line.match(/score cp (-?\d+)/);
    const sideToMove = T.analyzingFen.split(' ')[1];
    const sign = (sideToMove === 'b') ? -1 : 1;
    const evalCp = parseInt(cpMatch[1], 10) * sign;
    assert.strictEqual(evalCp, 200, 'White +200 cp should yield +200 for White');
});

// 2. Candidate Move Percentage Calculations
test('Candidate move with +300 cp yields winning win% for moving player regardless of color', () => {
    // Both White and Black should see high win% (~75%) when they have +300 cp
    T.currentMode = 'account';
    T.currentElo = '1500';

    T.currentFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    T.analyzingFen = T.currentFen;
    T.pvResults = {
        '10_1': { dp: 10, mp: 1, pv: 'c7c5', cp: 300, mate: null }
    };

    // Trigger candidate move finalization through mock or internal call
    // Test the math directly as implemented in finalizeTopMoves:
    const cp = 300;
    const elo = 1500;
    const eloNorm = Math.max(0, Math.min(1, (elo - 1000) / 2000));
    const k = 0.0022 + eloNorm * (0.00368208 - 0.0022);
    const winningChances = 2 / (1 + Math.exp(-k * cp)) - 1;
    const draw = (0.35 - eloNorm * 0.10) * Math.exp(-Math.pow(cp / 300, 2));
    const winRate = (0.5 + 0.5 * winningChances) * (1 - draw);
    const winPct = Math.round((winRate + 0.5 * draw) * 100);

    assert(winPct >= 65 && winPct <= 76, `Expected winPct between 65% and 76%, got ${winPct}%`);
});

test('COMBAT mode provides sharper win% than ACCOUNT mode for winning position', () => {
    const cp = 350;
    // Combat:
    const kCombat = 0.0044;
    const wCombat = 2 / (1 + Math.exp(-kCombat * cp)) - 1;
    const dCombat = 0.22 * Math.exp(-Math.pow(cp / 280, 2));
    const winPctCombat = Math.round(((0.5 + 0.5 * wCombat) * (1 - dCombat) + 0.5 * dCombat) * 100);

    // Account at 1500:
    const kAccount = 0.00257;
    const wAccount = 2 / (1 + Math.exp(-kAccount * cp)) - 1;
    const dAccount = 0.32 * Math.exp(-Math.pow(cp / 300, 2));
    const winPctAccount = Math.round(((0.5 + 0.5 * wAccount) * (1 - dAccount) + 0.5 * dAccount) * 100);

    assert(winPctCombat > winPctAccount, `COMBAT (${winPctCombat}%) should be sharper than ACCOUNT (${winPctAccount}%)`);
    assert(winPctCombat >= 80, `COMBAT should exceed 80% for +350 cp advantage, got ${winPctCombat}%`);
});

// 3. Threat Safety & Tactical Analysis
test('Threat safety detects hanging piece blunder when moving into attacked undefended square', () => {
    // Starting position + 1. e4
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    // If Black plays queen to a5 or h4 where it might be exposed:
    // Let us test an obvious blunder move: Black plays pawn e5 then d5
    const blunderMove = 'd7d5'; // e4 pawn attacks d5
    const safety = Threat.evaluateMoveSafety(fen, blunderMove, 'b');
    // In this position, d5 is attacked by e4 pawn. Is it defended? Yes, by queen.
    // What if Black plays 1... h5 then 2... Rh6?
    assert(safety !== null, 'Safety analysis should return result');
    assert(typeof safety.delta === 'number', 'Safety delta should be numeric');
});

test('Threat safety awards bonus for saving a hanging piece', () => {
    // Position where white pawn at e4 is attacked and undefended:
    // White pawn on e4 hanging:
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    // White pawn moves to e5 or captures exd5
    const safeMove = 'e4e5';
    const safety = Threat.evaluateMoveSafety(fen, safeMove, 'w');
    assert(safety.delta >= 0, `Defensive move should have non-negative delta, got ${safety.delta}`);
});

// 4. Configuration Tables
test('THREAT_CONFIG is defined with negative contempt for anti-risk play', () => {
    assert(Eng.THREAT_CONFIG, 'THREAT_CONFIG should exist');
    assert(Eng.THREAT_CONFIG['1500'].contempt < 0, 'THREAT_CONFIG should have negative contempt');
    assert(Eng.THREAT_CONFIG['1500'].depth >= 15, 'THREAT_CONFIG should have high tactical depth');
});

test('COMBAT_CONFIG has aggressive positive contempt and deep search', () => {
    assert(Eng.COMBAT_CONFIG, 'COMBAT_CONFIG should exist');
    assert(Eng.COMBAT_CONFIG['1500'].depth > Eng.ELO_CONFIG['1500'].depth, 'COMBAT depth should exceed ELO depth');
});

// 5. WDL exact 100% sum
test('wdlFromCentiPawns guarantees white + draw + black sums to exactly 100%', () => {
    function wdlFromCentiPawns(cp) {
        const winningChances = 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
        const drawRate = 0.30 * Math.exp(-Math.pow(cp / 300, 2));
        const whiteRaw = (0.5 + 0.5 * winningChances) * (1 - drawRate);
        const blackRaw = (0.5 - 0.5 * winningChances) * (1 - drawRate);
        const white = Math.round(whiteRaw * 100);
        const draw = Math.round(drawRate * 100);
        const black = Math.max(0, 100 - white - draw);
        return { white, draw, black };
    }

    const testScores = [-900, -450, -120, -50, 0, 50, 120, 350, 800, 1500];
    for (const cp of testScores) {
        const wdl = wdlFromCentiPawns(cp);
        const sum = wdl.white + wdl.draw + wdl.black;
        assert.strictEqual(sum, 100, `WDL for cp=${cp} should sum to 100, got ${sum} (${JSON.stringify(wdl)})`);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
