// ============================================================
// titan-free :: shared runtime state
// ============================================================
//
// every module reads and writes to this object. if you're adding
// a new feature, register your variables here so other modules
// can access them without circular imports.
//
// heads up: don't rename these keys without updating every module
// that references them — there's no typescript here to catch you.
//
// load order matters! this file MUST be first in manifest.json
// so that window.TitanState exists before anything else runs.
// ============================================================

window.TitanState = {
    // canvas overlay (sits on top of the board, pointer-events: none)
    canvas: null,
    ctx: null,

    // position tracking
    currentFen: '',       // last FEN we processed
    previousFen: '',      // FEN before that (for new-game detection)
    arrows: [],           // active arrows to render [{move: 'e2e4'}, ...]
    pendingArrows: [],    // backup copy for redraw after resize
    forceRedraw: false,

    // display preferences (persisted in chrome.storage)
    arrowColor: '#00f2ff',
    arrowMode: 'arrow',   // 'arrow' or 'highlight'

    // master power switch — when false, the engine does not analyze
    // at all (no arrows, no move%, no eval). toggled via the OFF button.
    engineOn: true,

    // board DOM references (cached to avoid re-querying every 100ms)
    boardElement: null,
    boardCache: null,      // { board: DOMElement, rect: {x,y,width,height,orientation} }
    playerColor: null,     // 'w' or 'b'

    // polling & observation
    monitorInterval: null,
    boardObserver: null,

    // stockfish engine (runs in a blob Worker)
    stockfishWorker: null,
    engineReady: false,
    currentElo: '1000',   // string key into ELO_CONFIG / COMBAT_CONFIG
    analyzing: false,      // true while waiting for bestmove
    myTurnColor: null,     // which color we're playing this game

    // mode flags
    combatMode: false,     // deeper analysis, higher depth/skill
    queueMode: false,      // pre-analyze on opponent's turn
    moveQueue: [],          // queued moves when queueMode is on
    currentMode: 'account', // 'account' | 'combat' | 'threat'

    // live evaluation (parsed from stockfish 'info' lines)
    // evalCp: centipawns from White's perspective (null = unknown)
    // evalMate: signed mate-in-N from White's perspective (null = not mate)
    //   positive = White mates, negative = Black mates
    evalCp: null,
    evalMate: null,
    evalDepth: null,       // last reported search depth
    evalBarOn: true,       // whether the persistent eval strip is shown

    // two-stage adaptive analysis (see engine.js analyze/startStage2)
    analysisStage: 0,      // 0 = idle, 1 = provisional fast pass, 2 = final deep pass
    analyzingFen: null,    // FEN currently being analyzed (staleness guard)

    // context gating (see context.js) — default-deny policy
    contextBlocked: false,     // true while on a denied page (live human game etc.)
    engineInitStarted: false,  // lazy engine init: only in allowed contexts

    // move percentage badges on the board (top moves overlay)
    movePctOn: true,       // whether win% badges are displayed over squares
    topMoves: [],          // current top moves: [{from, to, winPct}] sorted best first
    pvResults: null,       // internal buffer during analysis (cleared on new game)

    // Inovasi 1 - 5 Next-Gen features
    threatRadarOn: true,   // Inovasi 1: Blunder Radar & Threat Shield
    stealthOn: false,      // Inovasi 2: Humanize Stealth Engine (Anti-Cheat)
    voiceCoachOn: false,   // Inovasi 3: AI Voice Coach & Natural Explanation
    phantomOn: true,       // Inovasi 4: Ghost Board / Phantom Piece Projection
    hapticFeedbackOn: true,// Inovasi 5: Mobile Haptic & Thumb HUD (Xiaomi)

    // castling tracking — set to true once king/rook leaves
    // starting square during a game. reset on new game detection.
    // this prevents false castling rights in the FEN when a piece
    // has moved and returned to its original square.
    castleWhiteKingMoved: false,
    castleBlackKingMoved: false,
    castleWhiteRookAMoved: false,  // a1 rook
    castleWhiteRookHMoved: false,  // h1 rook
    castleBlackRookAMoved: false,  // a8 rook
    castleBlackRookHMoved: false   // h8 rook
};

// ============================================================
// safe chrome.* wrapper
// ============================================================
//
// when you reload the extension from chrome://extensions, any page
// that still has the OLD content script running will throw
// "Extension context invalidated" on every chrome.* call. chrome
// doesn't clean the old script up, so we have to defend against it.
//
// these wrappers catch that specific error and keep the widget
// alive visually (persistence just silently stops). if you add a
// new chrome API call, route it through here instead of calling
// chrome.* directly.
window.TitanChrome = {
    _broken: false,     // true once the context has been invalidated
    _warned: false,     // only warn once to avoid console spam

    _handleError() {
        this._broken = true;
        if (!this._warned) {
            this._warned = true;
            console.warn('[Titan] Extension was reloaded — refresh this page (F5) to reconnect.');
        }
    },

    // chrome.runtime.getURL — returns '' on failure so callers can bail out
    getURL(path) {
        try { return chrome.runtime.getURL(path); }
        catch (e) { this._handleError(); return ''; }
    },

    // chrome.storage.local.set — fires and forgets
    set(obj) {
        try { chrome.storage.local.set(obj); }
        catch (e) { this._handleError(); }
    },

    // chrome.storage.local.get — calls cb({}) on failure so the
    // restore logic still runs with defaults instead of hanging
    get(keys, cb) {
        try { chrome.storage.local.get(keys, cb); }
        catch (e) { this._handleError(); if (cb) cb({}); }
    },

    // chrome.runtime.onMessage.addListener — no-op on failure
    onMessage(listener) {
        try { chrome.runtime.onMessage.addListener(listener); }
        catch (e) { this._handleError(); }
    },

    // quick check: can we still talk to the extension?
    get alive() {
        if (this._broken) return false;
        try { return !!(chrome.runtime && chrome.runtime.id); }
        catch (e) { this._handleError(); return false; }
    }
};
