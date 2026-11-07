// ============================================================
// titan-free :: main entry point
// ============================================================
//
// this is the last file loaded (see manifest.json content_scripts
// order). by the time this runs, all other modules are ready:
//   state.js → context.js → board.js → drawing.js → engine.js → widget.js
//
// this file does three things:
//   1. runs the monitor loop (polls the board every 100ms)
//   2. handles chrome.runtime messages from popup/background
//   3. boots everything up (canvas, widget, engine, observer)
//
// === THE MONITOR LOOP ===
//
// monitor() runs every 100ms via setInterval. it:
//   - reads the current FEN from the DOM
//   - detects new games (starting position after a non-start)
//   - triggers analysis when the position changes on our turn
//   - pre-analyzes during opponent's turn if queue mode is on
//   - clears arrows on opponent's turn
//   - restores pending arrows when it becomes our turn
//   - triggers analysis if it's our turn with no arrows
//
// monitor() is the SINGLE SOURCE OF TRUTH for arrow visibility.
// arrows are shown only on our turn, cleared on opponent's turn.
// don't add turn checks in draw() or showMove() — keep it here.
//
// 100ms is a good balance between responsiveness and CPU usage.
// going lower (50ms) makes it snappier but burns more cycles.
// going higher (200ms+) feels laggy on fast time controls.
// ============================================================

(function () {
    const T = window.TitanState;
    const B = window.TitanBoard;
    const D = window.TitanDraw;
    const Eng = window.TitanEngine;
    const W = window.TitanWidget;
    const Ch = window.TitanChrome;   // safe chrome.* wrapper (see state.js)
    const Ctx = window.TitanContext; // context detection (always-allow)

    // SPA navigation detection: chess.com changes URL without reload.
    // track the last URL so we can detect page changes and re-discover
    // the board, re-inject the widget if it was removed, etc.
    let lastMonitorUrl = location.href;

    // core polling loop — called every 100ms.
    // reads the board state and decides what to do.
    // wrapped in try/catch so a DOM error doesn't kill the loop.
    function monitor() {
        try {
            // update context label (always allowed, never blocks)
            Ctx.update();

            // SPA navigation detection: if URL changed, clear stale
            // board references and re-discover the board element.
            const currentUrl = location.href;
            if (currentUrl !== lastMonitorUrl) {
                lastMonitorUrl = currentUrl;
                // board element likely changed — force re-discovery
                T.boardElement = null;
                T.boardCache = null;
                // re-inject widget if chess.com removed it during navigation
                if (!document.getElementById('titan-widget')) {
                    W.createFloatingWidget();
                }
            }

            // ensure engine is initialized (idempotent — returns immediately if already running)
            if (!T.engineInitStarted) {
                T.engineInitStarted = true;
                Eng.initEngine();
            }

            const fen = B.getFen(), rect = B.getBoardRect();
            if (!fen || !rect) return;

            // arrow feature OFF: keep the board clean (no arrows, no
            // badges) but DO NOT return — the eval bar is independent
            // and must keep updating while the engine runs for it.
            if (!T.engineOn) {
                if (T.arrows.length || T.pendingArrows.length || T.topMoves.length) {
                    T.arrows = [];
                    T.pendingArrows = [];
                    T.topMoves = [];
                    D.clearArrows();
                    D.clearMovePct();
                }
            }

            const isStart = fen.includes('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
            const wasNotStart = T.previousFen && !T.previousFen.includes('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');

            // new game: starting position appeared after a non-starting position.
            // reset everything and re-attach to the (possibly new) board element.
            if (isStart && wasNotStart) {
                if (T.boardObserver) { T.boardObserver.disconnect(); T.boardObserver = null; }
                T.boardElement = T.boardCache = T.playerColor = T.myTurnColor = null;
                T.moveQueue = [];
                T.pendingArrows = [];
                T.topMoves = [];
                T.pvResults = null;
                // new game → position cache from the previous game is invalid
                if (Eng.clearCache) Eng.clearCache();
                // reset castling tracking for the new game
                T.castleWhiteKingMoved = T.castleBlackKingMoved = false;
                T.castleWhiteRookAMoved = T.castleWhiteRookHMoved = false;
                T.castleBlackRookAMoved = T.castleBlackRookHMoved = false;
                W.updateQueueDisplay();
                D.clearArrows();
                D.clearMovePct();
                // reset hash table on new game so stale positions don't pollute results
                if (T.stockfishWorker && T.engineReady) {
                    T.stockfishWorker.postMessage('ucinewgame');
                }
                setup();
            }

            const turn = fen.split(' ')[1] || 'w';
            T.myTurnColor = B.getPlayerColor();
            const ctx = Ctx.getContext();
            const isGameOver = !!document.querySelector('.game-over-modal, .game-over-dialog, [class*="game-over"], .board-dialog-component');
            const isAnalysisLike = (ctx === 'analysis' || ctx === 'review' || ctx === 'puzzle' || ctx === 'practice' || isGameOver);
            const isMyTurn = isAnalysisLike || (turn === T.myTurnColor);

            // position changed — new move was made
            if (fen !== T.currentFen) {
                T.previousFen = T.currentFen;
                T.currentFen = fen;
                T.pendingArrows = [];
                T.topMoves = [];
                T.pvResults = null;
                D.clearArrows();
                D.clearMovePct();
                if (D.clearThreats) D.clearThreats();
                if (window.TitanPhantom) window.TitanPhantom.clearPhantom();
                if (D.clearStealthPill) D.clearStealthPill();

                // Inovasi 1 & 5: Threat Radar & Haptic Feedback
                if (T.threatRadarOn && window.TitanThreat) {
                    const threats = window.TitanThreat.analyzeThreats(fen, T.myTurnColor);
                    if (threats && D.drawThreats) D.drawThreats(threats);
                    if (T.hapticFeedbackOn && threats && threats.hanging && threats.hanging.length > 0) {
                        try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([40, 30, 40]); } catch (e) {}
                    }
                }

                // Inovasi 5: Mobile Haptic on our turn arrival
                if (isMyTurn && T.hapticFeedbackOn) {
                    try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(25); } catch (e) {}
                }

                // analyze on our turn, or pre-analyze in queue mode
                if (isMyTurn) {
                    Eng.analyze(fen);
                } else if (T.queueMode) {
                    Eng.preAnalyze(fen);
                }
            }

            // opponent's turn — make sure arrows & move% badges are cleared
            if (!isMyTurn && T.arrows.length > 0) {
                D.clearArrows();
                D.clearMovePct();
                if (D.clearStealthPill) D.clearStealthPill();
            }

            // our turn — restore pending arrows if they got cleared
            if (isMyTurn && T.pendingArrows.length > 0 && T.arrows.length === 0) {
                T.arrows = [...T.pendingArrows];
                T.forceRedraw = true;
                D.draw(true);
                if (D.drawMovePct) D.drawMovePct();
            }

            // our turn, no arrows, not analyzing — trigger analysis
            if (isMyTurn && T.pendingArrows.length === 0 && T.arrows.length === 0 && !T.analyzing) {
                Eng.analyze(fen);
            }
        } catch (err) {
            console.error('[TitanFree] monitor error', err);
        }
    }

    // start (or restart) the monitor loop and board observer.
    // called on initial boot and after each new game detection.
    function setup() {
        if (T.monitorInterval) clearInterval(T.monitorInterval);
        if (T.boardObserver) { T.boardObserver.disconnect(); T.boardObserver = null; }

        // poll the board every 100ms
        T.monitorInterval = setInterval(monitor, 100);

        // watch for DOM changes on the board (piece moves, etc.)
        // so we can invalidate the cached bounding rect
        const board = B.findBoard();
        if (board) {
            T.boardObserver = new MutationObserver(() => { T.boardCache = null; });
            T.boardObserver.observe(board, { childList: true, subtree: true });
        }
    }

    // handle messages from the popup or background script.
    Ch.onMessage((msg) => {
        if (!msg || typeof msg.type !== 'string') return true;
        if (msg.type === 'SET_ELO' && msg.elo) Eng.setElo(msg.elo);
        else if (msg.type === 'CLEAR_ARROWS') D.clearArrows();
        else if (msg.type === 'SET_ARROW_COLOR' && msg.color) {
            T.arrowColor = msg.color;
            Ch.set({ arrowColor: msg.color });
            if (T.arrows.length) D.draw(true);
        } else if (msg.type === 'SET_ARROW_MODE' && msg.mode) {
            T.arrowMode = msg.mode;
            Ch.set({ arrowMode: msg.mode });
            if (T.arrows.length) D.draw(true);
        } else if (msg.type === 'SET_EVAL_BAR') {
            T.evalBarOn = !!msg.enabled;
            Ch.set({ evalBarOn: T.evalBarOn });
            if (D.setBoardEval) D.setBoardEval(T.evalBarOn);
            if (W.updateEvalDisplay) W.updateEvalDisplay();
        }
        return true; // required for async message handling
    });

    // === BOOT ===
    // load saved settings first, then immediately init the engine
    // (no lazy init — start ASAP for fastest latency).
    Ch.get(['arrowColor', 'elo', 'arrowMode'], (r) => {
        if (r.arrowColor) T.arrowColor = r.arrowColor;
        if (r.arrowMode) T.arrowMode = r.arrowMode;
        if (r.elo) T.currentElo = r.elo;
    });

    // start engine immediately for fastest response time
    T.engineInitStarted = true;
    Eng.initEngine();

    // wait for chess.com to finish rendering before we inject the widget.
    // 1 second is enough for most connections; on very slow pages
    // the monitor loop will just return early until the board appears.
    setTimeout(() => {
        D.initCanvas();
        W.createFloatingWidget();
        setup();
    }, 1000);
})();
