// ============================================================
// bench/test-context-gating.js
// regression test for content/context.js — mode classification & gating.
//
// mocks window/document/location, loads context.js, and asserts
// allow/deny + context label for every URL/DOM combination across
// all supported Chess.com modes:
//
//   1. Play vs Computer  → chess.com/play/computer, /game/computer, or bot DOM
//   2. Live Human Match  → chess.com/game/live, /play/online (ALLOWED)
//   3. Daily Chess       → chess.com/game/daily (ALLOWED)
//   4. Game Review       → chess.com/game/review/{id} (ALLOWED)
//   5. Analysis Board    → chess.com/analysis (ALLOWED)
//   6. Practice & Puzzle → chess.com/practice, /puzzles (ALLOWED)
//   7. Non-game pages    → chess.com/articles/... → DENIED
//   8. Non-chess.com host→ evil-chess.com → DENIED
//
// run: node bench/test-context-gating.js
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../content/context.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, actual, expected) {
    const ok = actual === expected;
    if (ok) pass++;
    else { fail++; console.error(`  FAIL  ${name}\n        expected: ${expected}\n        actual:   ${actual}`); }
}

// --- mock DOM -------------------------------------------------
let playerCardsHtml = '';
const documentMock = {
    querySelector(sel) {
        if (sel === '#board-layout-player-top, #board-layout-player-bottom' ||
            sel === '.player-card-top, .player-card-bottom') {
            return playerCardsHtml ? { querySelector: scopedQuery } : null;
        }
        return null;
    }
};
function scopedQuery(sel) {
    if (sel.includes('/bot/')) return playerCardsHtml.includes('/bot/') ? {} : null;
    if (sel.includes('/play/computer/')) return playerCardsHtml.includes('/play/computer/') ? {} : null;
    if (sel.includes('bot-badge')) return playerCardsHtml.includes('bot-badge') ? {} : null;
    return null;
}

// --- mock location --------------------------------------------
let currentUrl = 'https://www.chess.com/';

// --- sandbox ----------------------------------------------------
const sandbox = {
    window: {},
    document: documentMock,
    location: { get href() { return currentUrl; } },
    Date,
    console
};
sandbox.window = sandbox; // context.js does window.TitanContext = ...
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

const Ctx = sandbox.window.TitanContext;
if (!Ctx) { console.error('FATAL: window.TitanContext not created'); process.exit(1); }

function setPage(url, cardsHtml) {
    currentUrl = url;
    playerCardsHtml = cardsHtml || '';
    Ctx.update();
    return { allowed: Ctx.isAllowed(), context: Ctx.getContext() };
}

// --- 1. URL rules ------------------------------------------------
console.log('URL rules:');
let r;

r = setPage('https://www.chess.com/analysis');
check('analysis board', r.allowed + ':' + r.context, 'true:analysis');

r = setPage('https://www.chess.com/analysis?tab=analysis');
check('analysis board w/ query', r.allowed + ':' + r.context, 'true:analysis');

r = setPage('https://www.chess.com/game/review/123456789');
check('game review', r.allowed + ':' + r.context, 'true:review');

r = setPage('https://www.chess.com/game/computer/123456789');
check('vs bot (/game/computer)', r.allowed + ':' + r.context, 'true:computer');

r = setPage('https://www.chess.com/play/computer');
check('vs bot (/play/computer)', r.allowed + ':' + r.context, 'true:computer');

r = setPage('https://www.chess.com/play/computer?moveList=e2e4&fen=standard');
check('vs bot deep link', r.allowed + ':' + r.context, 'true:computer');

r = setPage('https://www.chess.com/practice/custom?fen=standard');
check('practice vs computer', r.allowed + ':' + r.context, 'true:computer');

r = setPage('https://www.chess.com/practice');
check('practice mode', r.allowed + ':' + r.context, 'true:practice');

r = setPage('https://www.chess.com/puzzles');
check('puzzle mode', r.allowed + ':' + r.context, 'true:puzzle');

r = setPage('https://www.chess.com/puzzle-rush');
check('puzzle rush', r.allowed + ':' + r.context, 'true:puzzle');

r = setPage('https://www.chess.com/game/live/123456789');
check('live human game ALLOWED', r.allowed + ':' + r.context, 'true:live');

r = setPage('https://www.chess.com/game/186710743490');
check('direct game ID URL (/game/:id) ALLOWED', r.allowed + ':' + r.context, 'true:live');

r = setPage('https://www.chess.com/game/186710743490?tab=analysis');
check('direct game ID URL w/ query ALLOWED', r.allowed + ':' + r.context, 'true:live');

r = setPage('https://www.chess.com/game/daily/123456789');
check('daily human game ALLOWED', r.allowed + ':' + r.context, 'true:daily');

r = setPage('https://www.chess.com/play/online');
check('play online ALLOWED', r.allowed + ':' + r.context, 'true:live');

r = setPage('https://www.chess.com/articles/some-post');
check('articles page DENIED', r.allowed + ':' + r.context, 'false:denied');

r = setPage('https://www.chess.com/play/computers-and-engines');
check('non-bot /play/computers* DENIED', r.allowed + ':' + r.context, 'false:denied');

r = setPage('https://evil-chess.com/analysis');
check('non-chess.com host DENIED', r.allowed + ':' + r.context, 'false:denied');

// --- 2. DOM bot signal -------------------------------------------
console.log('DOM bot signal:');
r = setPage('https://www.chess.com/game/live/555', '<a href="/bot/MagnusCarlsen">Bot</a>');
check('bot cards on live URL → computer', r.allowed + ':' + r.context, 'true:computer');

r = setPage('https://www.chess.com/game/live/556', '<a href="/member/HumanPlayer">Human</a>');
check('human cards on live URL → live', r.allowed + ':' + r.context, 'true:live');

r = setPage('https://www.chess.com/game/live/557', '<span class="player-card-bot-badge">BOT</span>');
check('bot badge class → computer', r.allowed + ':' + r.context, 'true:computer');

r = setPage('https://www.chess.com/game/live/558', '');
check('no player cards on live URL → live', r.allowed + ':' + r.context, 'true:live');

// --- 3. SPA cache-reset behaviour --------------------------------
console.log('SPA transitions:');
r = setPage('https://www.chess.com/game/computer/1', '<a href="/bot/Bot1">B</a>');
check('bot game allowed', r.allowed, true);

r = setPage('https://www.chess.com/game/live/999', '<a href="/bot/SomeBot">B</a>');
check('nav to live w/ bot cards re-checks DOM', r.allowed + ':' + r.context, 'true:computer');

r = setPage('https://www.chess.com/game/live/998', '<a href="/member/Human">H</a>');
check('nav to live w/ human cards → live', r.allowed + ':' + r.context, 'true:live');

r = setPage('https://www.chess.com/articles/help', '');
check('nav to article page denies', r.allowed + ':' + r.context, 'false:denied');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
