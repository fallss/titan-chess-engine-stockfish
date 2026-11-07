// ============================================================
// bench/test-leak-gates.js
// regression test proving NO engine recommendation/eval leaks into
// a denied context (live human match) across the full data path:
//
//   analyze() → preAnalyze() → showMove()   (engine.js)
//   updateEvalDisplay()                      (widget.js)
//   renderBoardEval() / setBoardEval(true)   (drawing.js)
//
// Strategy: load the real modules into a VM with a mocked DOM.
// `window.TitanContext.isAllowed()` is stubbed false (denied) for the
// leak tests and true for the control tests. We then assert:
//   - analyze()/preAnalyze() early-return (engineOn stays false, no
//     worker spawned)
//   - showMove() clears arrows and never draws
//   - updateEvalDisplay() renders the neutral state, not real eval
//   - renderBoardEval() hides the bar in denied context
//   - setBoardEval(true) is a no-op in denied context
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// --- minimal DOM mock ------------------------------------------
function makeEl(id) {
    return {
        id: id || '',
        style: {},
        textContent: '',
        innerHTML: '',
        children: [],
        querySelector() { return null; },
        querySelectorAll() { return []; },
        appendChild() {}, removeChild() {}, contains() { return false; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; },
        classList: { add() {}, remove() {}, contains() { return false; } },
        addEventListener() {}, setAttribute() {}, getAttribute() { return null; }
    };
}

const widgetEl = makeEl('titan-widget');
widgetEl.querySelector = function (sel) {
    // return a tiny element for the fields widget.js touches
    if (sel === '#eval-strip') return makeEl();
    if (sel === '#eval-best') return makeEl();
    if (sel === '#eval-score') return makeEl();
    return null;
};

function makeDocument() {
    const els = { 'titan-widget': widgetEl };
    return {
        getElementById(id) { return els[id] || null; },
        querySelector(sel) {
            if (sel === '#titan-widget' || sel === '#titan-widget .eval-strip') return widgetEl;
            return null;
        },
        querySelectorAll() { return []; },
        createElement() { return makeEl(); },
        createElementNS() { return makeEl(); },
        body: makeEl('body'),
        contains() { return false; }
    };
}

// --- sandbox ----------------------------------------------------
let allowed = true; // flipped by tests via setAllowed()

function buildSandbox() {
    const documentMock = makeDocument();
    const sandbox = {
        window: null,
        document: documentMock,
        location: { href: 'https://www.chess.com/game/live/123' },
        navigator: { userAgent: 'node' },
        Date,
        setTimeout: (fn) => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        console,
        chrome: {
            storage: { local: { get() {}, set() {} } },
            runtime: { onMessage: { addListener() {} }, sendMessage() {}, lastError: null }
        },
        Worker: function () { throw new Error('Worker must NOT be spawned in denied context'); },
        fetch: function () { return Promise.reject(new Error('fetch must not run in denied context')); },
        URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
        Blob: function () {},
        requestAnimationFrame: () => 0,
        addEventListener() {}, removeEventListener() {},
        getComputedStyle: () => ({ getPropertyValue: () => '' })
    };
    sandbox.window = sandbox;
    // TitanContext stub: gate controlled by test
    sandbox.TitanContext = {
        update() {},
        isAllowed() { return allowed; },
        getContext() { return allowed ? 'computer' : 'denied'; }
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadModule(sandbox, file) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(src, sandbox, { filename: file });
}

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) pass++;
    else { fail++; console.error(`  FAIL  ${name}`); }
}

// --- Test: engine.js analyze/preAnalyze gates --------------------
console.log('engine.js analyze()/preAnalyze()/showMove() gates:');
{
    const sb = buildSandbox();
    loadModule(sb, 'content/state.js');
    loadModule(sb, 'content/board.js');
    loadModule(sb, 'content/drawing.js');
    loadModule(sb, 'content/widget.js');
    loadModule(sb, 'content/engine.js');

    const T = sb.window.TitanState;
    const Eng = sb.window.TitanEngine;

    // simulate a ready engine so analyze() can reach the context gate
    T.engineReady = true;
    T.stockfishWorker = { postMessage() {} };
    T.engineOn = true;
    T.evalBarOn = true;

    // denied context
    allowed = false;
    T.analyzing = false;
    Eng.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    check('analyze() blocked (analyzing stays false) in denied ctx', T.analyzing === false);

    Eng.preAnalyze('e4', 'fen');
    check('preAnalyze() no-op in denied ctx', T.analyzing === false);

    // showMove must clear arrows and not draw in denied context
    T.arrows = [{ move: 'e2e4' }];
    T.pendingArrows = [{ move: 'e2e4' }];
    Eng.showMove('e2e4', true);
    check('showMove() clears arrows in denied ctx', T.arrows.length === 0);
    check('showMove() clears pendingArrows in denied ctx', T.pendingArrows.length === 0);

    // control: allowed context lets analyze() run (sets analyzing=true)
    allowed = true;
    T.analyzing = false;
    Eng.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    check('analyze() runs (analyzing=true) in allowed ctx', T.analyzing === true);
}

// --- Test: widget.js updateEvalDisplay neutralizes in denied -----
console.log('widget.js updateEvalDisplay() neutralization:');
{
    const sb = buildSandbox();
    loadModule(sb, 'content/state.js');
    loadModule(sb, 'content/board.js');
    loadModule(sb, 'content/drawing.js');
    loadModule(sb, 'content/widget.js');

    const T = sb.window.TitanState;
    const W = sb.window.TitanWidget;

    // simulate a real engine eval having arrived earlier
    T.evalCp = 125; T.evalMate = null; T.evalDepth = 22;
    allowed = false;
    // capture what renderBoardEval receives via the stub
    let capturedHasEval = null;
    sb.window.TitanDraw.renderBoardEval = (wdl, scoreText, hasEval) => { capturedHasEval = hasEval; };
    W.updateEvalDisplay();
    check('updateEvalDisplay() passes hasEval=false in denied ctx', capturedHasEval === false);

    // control: allowed ctx passes real eval through
    allowed = true;
    capturedHasEval = null;
    W.updateEvalDisplay();
    check('updateEvalDisplay() passes hasEval=true in allowed ctx', capturedHasEval === true);
}

// --- Test: drawing.js renderBoardEval / setBoardEval -------------
console.log('drawing.js renderBoardEval()/setBoardEval() gates:');
{
    // denied context — spy on body.appendChild BEFORE first render so we
    // catch the lazily-created eval bar element and read its style.
    {
        const sb = buildSandbox();
        let barEl = null;
        sb.document.body.appendChild = (el) => { if (el && el.className === 'titan-board-eval') barEl = el; return el; };
        loadModule(sb, 'content/state.js');
        loadModule(sb, 'content/board.js');
        loadModule(sb, 'content/drawing.js');
        const T = sb.window.TitanState;
        const D = sb.window.TitanDraw;
        T.evalBarOn = true; // user toggle ON
        allowed = false;
        D.renderBoardEval({ white: 50, draw: 50, black: 0 }, '+0.5', true);
        check('renderBoardEval() hides bar in denied ctx', barEl !== null && barEl.style.display === 'none');

        // setBoardEval(true) must be a no-op in denied context
        D.setBoardEval(true);
        check('setBoardEval(true) no-op in denied ctx (bar stays hidden)', barEl.style.display === 'none');
    }

    // allowed context — fresh sandbox so the bar is created while allowed.
    {
        const sb = buildSandbox();
        let barEl = null;
        sb.document.body.appendChild = (el) => { if (el && el.className === 'titan-board-eval') barEl = el; return el; };
        loadModule(sb, 'content/state.js');
        loadModule(sb, 'content/board.js');
        loadModule(sb, 'content/drawing.js');
        const T = sb.window.TitanState;
        const D = sb.window.TitanDraw;
        T.evalBarOn = true; // user toggle ON
        allowed = true;
        D.renderBoardEval({ white: 60, draw: 30, black: 10 }, '+0.5', true);
        check('renderBoardEval() shows bar in allowed ctx', barEl !== null && barEl.style.display === 'flex');

        // setBoardEval(false) still hides in allowed ctx
        D.setBoardEval(false);
        check('setBoardEval(false) hides bar in allowed ctx', barEl.style.display === 'none');
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
