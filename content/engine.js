// ============================================================
// titan-free :: stockfish WASM engine
// ============================================================
//
// this is the brain of the extension. we run stockfish entirely
// in the browser using WebAssembly — no server needed.
//
// IMPORTANT: chrome content scripts can't do `new Worker(url)`
// with extension URLs. so we fetch the JS + WASM files, stuff
// them into a Blob, and create the Worker from that. don't try
// to "simplify" this — it'll break with a DOMException.
//
// === HOW ELO WORKS ===
//
// each elo level maps to a stockfish config:
//   - skillLevel: stockfish's internal skill (0-20)
//   - depth: how many moves ahead to search
//   - uciElo: UCI_Elo option (limits engine strength)
//   - errorRate: chance to intentionally skip a move
//     (makes the engine feel more human at lower levels)
//   - movetime: (optional) max analysis time in ms for high elo
//     levels. when set, stockfish uses `go depth X movetime Y`
//     so it searches as deep as possible within the time cap.
//
// want to add a new elo level? add it to ELO_LEVELS, ELO_LABELS,
// ELO_CONFIG, and COMBAT_CONFIG. keep them in sync or the widget
// will break.
//
// COMBAT mode uses COMBAT_CONFIG instead — same elo keys but
// with higher depth and skill for each level. it's basically
// "try harder" mode.
//
// === PERFORMANCE ===
//
// - hash table (16MB): set on engine init via `setoption name
//   Hash value 16`. caches evaluated positions so subsequent
//   moves in the same game are faster.
// - no `ucinewgame` per analysis: only sent on new game
//   detection (in content.js). this preserves the hash table
//   across moves within the same game.
// - movetime caps: high elo levels (2500+) use movetime to
//   prevent analysis from taking too long on complex positions.
//
// === ABORT & RETRY ===
//
// when a new position arrives while analysis is in progress:
//   1. send 'stop' to abort the current search
//   2. increment ignoreNextBestmove so the stale bestmove
//      from 'stop' is discarded
//   3. start fresh analysis for the new position
//
// === WHAT NOT TO CHANGE ===
//
// - the blob Worker creation in initEngine() — this is the only
//   pattern that works in MV3 content scripts
// - the WASM_BUFFER message handshake — the worker needs the
//   binary before it can initialize stockfish
// - the uci retry loop — stockfish sometimes needs a few pokes
//   before it responds with 'uciok'
// ============================================================

(function () {
    const T = window.TitanState;
    const D = window.TitanDraw;
    const Ch = window.TitanChrome;   // safe chrome.* wrapper (see state.js)

    // elo levels shown in the widget slider.
    const ELO_LEVELS = [1000, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2200, 2500, 2800, 3000];
    const ELO_LABELS = ['BRONZE', 'BRONZE+', 'SILVER', 'SILVER+', 'SILVER++', 'GOLD', 'GOLD+', 'GOLD++', 'EXPERT', 'MASTER', 'IM', 'GM', 'SUPER GM', 'STOCKFISH'];

    // streaming render throttle (ms) — keeps mobile / Xiaomi rendering at smooth 60fps without CPU spike
    let lastStreamingRender = 0;
    const STREAMING_THROTTLE_MS = 120;

    function isPlayerTurn() {
        if (!T.currentFen) return true;
        const turn = T.currentFen.split(' ')[1] || 'w';
        const myColor = T.myTurnColor || (window.TitanBoard ? window.TitanBoard.getPlayerColor() : null);
        if (!myColor) return true;
        const ctx = window.TitanContext ? window.TitanContext.getContext() : null;
        const isGameOver = typeof document !== 'undefined' && document.querySelector && !!document.querySelector('.game-over-modal, .game-over-dialog, [class*="game-over"], .board-dialog-component');
        const isAnalysisLike = (ctx === 'analysis' || ctx === 'review' || ctx === 'puzzle' || ctx === 'practice' || isGameOver);
        return isAnalysisLike || (turn === myColor);
    }

    // normal mode config — tweak these if you want different
    // playing strength at each level. errorRate is the probability
    // that the engine "misses" a move (0.25 = 25% chance to skip).
    // human-like: lower elo = shallower depth + more errors.
    // higher elo = deeper search, near-zero error rate.
    //
    // === UCI_LimitStrength ===
    // levels 1000-2800: UCI_LimitStrength = true, UCI_Elo = <uciElo>
    //   stockfish artificially weakens itself to play at the target rating.
    // level 3000 (unlimited: true): UCI_LimitStrength = false
    //   stockfish plays at FULL, unrestricted strength. no elo cap.
    //   this is raw stockfish — the strongest possible play in WASM.
    const ELO_CONFIG = {
        '1000': { skillLevel: 1,  depth: 5,  uciElo: 800,  errorRate: 0.30 },
        '1200': { skillLevel: 3,  depth: 7,  uciElo: 1100, errorRate: 0.22 },
        '1300': { skillLevel: 5,  depth: 8,  uciElo: 1250, errorRate: 0.18 },
        '1400': { skillLevel: 7,  depth: 9,  uciElo: 1350, errorRate: 0.14 },
        '1500': { skillLevel: 9,  depth: 10, uciElo: 1450, errorRate: 0.10 },
        '1600': { skillLevel: 11, depth: 11, uciElo: 1550, errorRate: 0.08 },
        '1700': { skillLevel: 13, depth: 12, uciElo: 1650, errorRate: 0.06 },
        '1800': { skillLevel: 15, depth: 13, uciElo: 1750, errorRate: 0.04 },
        '1900': { skillLevel: 17, depth: 14, uciElo: 1850, errorRate: 0.03 },
        '2000': { skillLevel: 18, depth: 16, uciElo: 2000, errorRate: 0.02 },
        '2200': { skillLevel: 19, depth: 18, uciElo: 2200, errorRate: 0.01 },
        '2500': { skillLevel: 20, depth: 20, uciElo: 2500, errorRate: 0.005, movetime: 5000 },
        '2800': { skillLevel: 20, depth: 20, uciElo: 2800, errorRate: 0.0,   movetime: 6000 },
        '3000': { skillLevel: 20, depth: 22, uciElo: 3000, errorRate: 0.0, movetime: 3000, unlimited: true }
    };

    // combat mode — same keys, but cranked up.
    // depth is higher, skill is higher, error rate is lower.
    // this is what kicks in when the user hits the COMBAT button.
    const COMBAT_CONFIG = {
        '1000': { skillLevel: 3,  depth: 10, uciElo: 1100, errorRate: 0.15 },
        '1200': { skillLevel: 6,  depth: 12, uciElo: 1350, errorRate: 0.12 },
        '1300': { skillLevel: 9,  depth: 14, uciElo: 1450, errorRate: 0.10 },
        '1400': { skillLevel: 12, depth: 16, uciElo: 1550, errorRate: 0.08 },
        '1500': { skillLevel: 15, depth: 18, uciElo: 1650, errorRate: 0.06 },
        '1600': { skillLevel: 17, depth: 20, uciElo: 1750, errorRate: 0.04 },
        '1700': { skillLevel: 18, depth: 22, uciElo: 1850, errorRate: 0.03 },
        '1800': { skillLevel: 19, depth: 24, uciElo: 1950, errorRate: 0.02 },
        '1900': { skillLevel: 20, depth: 26, uciElo: 2100, errorRate: 0.01 },
        '2000': { skillLevel: 20, depth: 28, uciElo: 2300, errorRate: 0.005 },
        '2200': { skillLevel: 20, depth: 30, uciElo: 2500, errorRate: 0.0 },
        '2500': { skillLevel: 20, depth: 32, uciElo: 2800, errorRate: 0.0,   movetime: 8000 },
        '2800': { skillLevel: 20, depth: 24, uciElo: 3000, errorRate: 0.0,   movetime: 10000 },
        '3000': { skillLevel: 20, depth: 25, uciElo: 3200, errorRate: 0.0, movetime: 5000, unlimited: true }
    };

    // stuck analysis timeout — if analyzing stays true for >10s,
    // something went wrong (worker crash, no bestmove response).
    // we force-reset it so future analysis isn't permanently blocked.
    let analyzeWatchdog = null;

    // when we send 'stop' to abort a previous analysis, stockfish
    // responds with a bestmove we need to ignore. this counter
    // tracks how many 'stop' bestmoves to skip.
    let ignoreNextBestmove = 0;

    function startAnalyzeWatchdog() {
        clearTimeout(analyzeWatchdog);
        // scale timeout: use movetime if set (+ 5s buffer), otherwise
        // base 15s + 1.5s per depth level above 10.
        const configTable = T.combatMode ? COMBAT_CONFIG : ELO_CONFIG;
        const cfg = configTable[T.currentElo] || configTable['1000'];
        const timeout = cfg.movetime
            ? cfg.movetime + 5000
            : 15000 + Math.max(0, cfg.depth - 10) * 1500;
        analyzeWatchdog = setTimeout(() => {
            if (T.analyzing) {
                console.warn(`[TitanFree] analysis stuck for >${timeout/1000}s, force-resetting`);
                T.analyzing = false;
                if (T.stockfishWorker) {
                    try {
                        T.stockfishWorker.postMessage('stop');
                        ignoreNextBestmove++;
                    } catch (e) {}
                }
            }
        }, timeout);
    }

    function clearAnalyzeWatchdog() {
        clearTimeout(analyzeWatchdog);
        analyzeWatchdog = null;
    }

    let isInitializingEngine = false;

    // boot up stockfish. fetches the JS and WASM files from the
    // extension bundle, wraps them in a Blob Worker, and waits
    // for 'uciok'. the retry loop is needed because the WASM
    // init is async and stockfish might not be ready immediately.
    function initEngine() {
        if (T.stockfishWorker || isInitializingEngine) return;
        isInitializingEngine = true;
        try {
            const wasmUrl = Ch.getURL('engine/stockfish.wasm');
            const jsUrl = Ch.getURL('engine/stockfish.js');
            if (!wasmUrl || !jsUrl) {
                isInitializingEngine = false;
                return;   // extension context invalidated — bail out
            }

            Promise.all([
                fetch(jsUrl).then(r => r.text()),
                fetch(wasmUrl).then(r => r.arrayBuffer())
            ]).then(([jsCode, wasmBuffer]) => {
                // this blob trick is required because content scripts
                // can't create Workers from chrome-extension:// URLs.
                // we inline the stockfish JS and intercept WASM fetches.
                const workerCode = `
                    let wasmBinary = null;
                    let stockfishReady = false;
                    const initListener = function(e) {
                        if (e.data && e.data.type === 'WASM_BUFFER') {
                            wasmBinary = new Uint8Array(e.data.buffer);
                            self.removeEventListener('message', initListener);
                            initStockfish();
                        }
                    };
                    self.addEventListener('message', initListener);
                    function initStockfish() {
                        WebAssembly.instantiateStreaming = function(source, importObject) {
                            return WebAssembly.instantiate(wasmBinary, importObject);
                        };
                        self.locateFile = function(path) { return 'stockfish.wasm'; };
                        const originalFetch = self.fetch;
                        self.fetch = function(url, options) {
                            if (typeof url === 'string' && url.includes('.wasm')) {
                                return Promise.resolve(new Response(wasmBinary, {
                                    status: 200, headers: { 'Content-Type': 'application/wasm' }
                                }));
                            }
                            return originalFetch(url, options);
                        };
                        ${jsCode}
                    }
                `;
                const blob = new Blob([workerCode], { type: 'application/javascript' });
                T.stockfishWorker = new Worker(URL.createObjectURL(blob));
                isInitializingEngine = false;

                T.stockfishWorker.onmessage = (e) => {
                    const line = e.data;
                    if (typeof line !== 'string') return;

                    // ===== MULTI-PV BUFFERING & PROGRESSIVE STREAMING =====
                    // when enabled, stockfish sends multiple info lines per depth:
                    //   info depth 10 ... multipv 1 score cp 34 pv e2e4 e7e5 ...
                    //   info depth 10 ... multipv 2 score cp 10 pv d2d4 d7d5 ...
                    //   info depth 10 ... multipv 3 score cp -5 pv g1f3 g8f6 ...
                    // we buffer these into T.pvResults keyed by "D_M" (depth-multipv).
                    // In addition, progressive streaming renders early win% badges
                    // as soon as depth >= 6 without waiting for bestmove!
                    if (line.startsWith('info ') && T.pvResults) {
                        const mpMatch = line.match(/multipv (\d+)/);
                        const dpMatch = line.match(/ depth (\d+)/);
                        const pvMatch = line.match(/ pv ([a-h][1-8][a-h][1-8])/);
                        const cpMatch2 = line.match(/score cp (-?\d+)/);
                        const mateMatch2 = line.match(/score mate (-?\d+)/);
                        if (mpMatch && dpMatch && pvMatch) {
                            const dp = parseInt(dpMatch[1], 10);
                            const mp = parseInt(mpMatch[1], 10);
                            const key = `${dp}_${mp}`;
                            T.pvResults[key] = {
                                mp,
                                dp,
                                pv: pvMatch[1], // first move in the PV
                                cp: cpMatch2 ? parseInt(cpMatch2[1], 10) : null,
                                mate: mateMatch2 ? parseInt(mateMatch2[1], 10) : null
                            };

                            // Progressive live badge streaming:
                            if (T.engineOn && T.movePctOn && dp >= 6 && isPlayerTurn()) {
                                const now = Date.now();
                                if (now - lastStreamingRender >= STREAMING_THROTTLE_MS) {
                                    lastStreamingRender = now;
                                    finalizeTopMoves();
                                    if (D.drawMovePct) D.drawMovePct();
                                }
                            }
                        }
                    }

                    // capture live evaluation from stockfish's info lines.
                    // every depth iteration emits a fresh score; the last
                    // one before 'bestmove' is the final evaluation.
                    // formats: 'info depth 12 ... score cp 34 ...'
                    //          'info depth 12 ... score mate 3 ...'
                    if (line.startsWith('info ') && line.indexOf(' score ') !== -1) {
                        const cpMatch = line.match(/score cp (-?\d+)/);
                        const mateMatch = line.match(/score mate (-?\d+)/);
                        const depthMatch = line.match(/ depth (\d+)/);
                        if (depthMatch) T.evalDepth = parseInt(depthMatch[1], 10);
                        if (mateMatch) {
                            T.evalMate = parseInt(mateMatch[1], 10);
                            T.evalCp = null;
                        } else if (cpMatch) {
                            T.evalCp = parseInt(cpMatch[1], 10);
                            T.evalMate = null;
                        }
                        if (window.TitanWidget) window.TitanWidget.updateEvalDisplay();
                    }

                    if (line === 'uciok') {
                        T.engineReady = true;
                        // default: limit strength. setElo() will override this
                        // to false for mode 3000 (unlimited full power).
                        T.stockfishWorker.postMessage('setoption name UCI_LimitStrength value true');
                        // Hash: this WASM build clamps Hash to 16MB max
                        // (`option name Hash type spin default 16 min 16 max 16`
                        // — verified against the actual binary). we don't send
                        // it at all; 16MB is the default. what matters is that
                        // Hash is NEVER re-set later: `setoption name Hash`
                        // reallocates and FLUSHES the transposition table, and
                        // the old code re-set it on every elo/combat switch,
                        // throwing away all cached search work each time.
                        // MultiPV defaults to 1 (fast single-line search). the
                        // deep second stage temporarily raises it to 3 for the
                        // move% badges — see startStage2().
                        T.stockfishWorker.postMessage('setoption name MultiPV value 1');
                        setElo(T.currentElo);
                        if (window.TitanWidget) window.TitanWidget.updateStatus(true);
                    } else if (line.startsWith('bestmove')) {
                        if (ignoreNextBestmove > 0) {
                            // this bestmove is from a 'stop' command — discard it
                            ignoreNextBestmove--;
                            T.analysisStage = 0;
                            return;
                        }
                        clearAnalyzeWatchdog();
                        const match = line.match(/bestmove ([a-h][1-8][a-h][1-8])/);
                        if (T.analysisStage === 1) {
                            // STAGE 1 (fast shallow pass, MultiPV=3/1):
                            // finalize provisional topMoves so percentage badges show immediately
                            finalizeTopMoves();
                            if (match) showMove(match[1], false);
                            startStage2();
                        } else {
                            // STAGE 2 / pre-analysis (final): commit the result.
                            finalizeTopMoves();
                            if (match) {
                                showMove(match[1], true);
                                cacheResult(T.analyzingFen, match[1]);
                            }
                            T.analyzing = false;
                            T.analysisStage = 0;
                        }
                    }
                };

                T.stockfishWorker.onerror = (err) => {
                    console.error('[TitanFree] engine error', err);
                    T.analyzing = false;
                    isInitializingEngine = false;
                    clearAnalyzeWatchdog();
                    if (window.TitanWidget) window.TitanWidget.updateStatus(false);
                    // attempt auto-restart after worker crash
                    T.stockfishWorker = null;
                    T.engineReady = false;
                    console.warn('[TitanFree] attempting engine restart in 2s...');
                    setTimeout(() => initEngine(), 2000);
                };

                // send the WASM binary to the worker (transferable for speed)
                T.stockfishWorker.postMessage({ type: 'WASM_BUFFER', buffer: wasmBuffer }, [wasmBuffer]);

                // stockfish needs a few 'uci' pokes before it responds.
                // poke immediately, then retry every 200ms for faster startup.
                T.stockfishWorker.postMessage('uci');
                let uciRetries = 0;
                const uciInterval = setInterval(() => {
                    if (T.engineReady) { clearInterval(uciInterval); return; }
                    if (uciRetries > 25) {
                        clearInterval(uciInterval);
                        console.error('[TitanFree] engine failed to respond after 25 retries');
                        if (window.TitanWidget) {
                            window.TitanWidget.updateStatus(false);
                            window.TitanWidget.showStatusNotification('ENGINE: FAILED TO START');
                        }
                        return;
                    }
                    T.stockfishWorker.postMessage('uci');
                    uciRetries++;
                }, 200);
            }).catch(err => {
                isInitializingEngine = false;
                console.error('[TitanFree] failed to fetch engine files', err);
                if (window.TitanWidget) {
                    window.TitanWidget.updateStatus(false);
                    window.TitanWidget.showStatusNotification('ENGINE: LOAD FAILED');
                }
            });
        } catch (err) {
            isInitializingEngine = false;
            console.error('[TitanFree] engine init failed', err);
            if (window.TitanWidget) {
                window.TitanWidget.updateStatus(false);
                window.TitanWidget.showStatusNotification('ENGINE: INIT ERROR');
            }
        }
    }

    // apply elo settings to the running engine.
    // called when user changes elo in the widget, or on startup.
    //
    // for levels 1000-2800: UCI_LimitStrength = true, UCI_Elo = target.
    //   this makes stockfish play at a capped rating.
    // for level 3000 (unlimited): UCI_LimitStrength = false.
    //   no artificial cap — full stockfish strength.
    //   hash bumped to 32MB, Contempt 50 (anti-draw).
    function setElo(elo) {
        T.currentElo = elo;
        const configTable = T.combatMode ? COMBAT_CONFIG : ELO_CONFIG;
        const cfg = configTable[elo] || configTable['1000'];
        // strength changed → cached results no longer match the config
        clearCache();
        if (T.engineReady && T.stockfishWorker) {
            if (cfg.unlimited) {
                // mode 3000: disable strength limiter for full stockfish power.
                // UCI_LimitStrength false = no artificial cap on engine strength.
                // Contempt 50 = engine avoids draws aggressively.
                // NOTE: Hash is NOT touched here — re-setting it would flush
                // the transposition table (see uciok handler).
                T.stockfishWorker.postMessage('setoption name UCI_LimitStrength value false');
                T.stockfishWorker.postMessage('setoption name Contempt value 50');
            } else {
                T.stockfishWorker.postMessage('setoption name UCI_LimitStrength value true');
                T.stockfishWorker.postMessage(`setoption name UCI_Elo value ${cfg.uciElo}`);
            }
            T.stockfishWorker.postMessage(`setoption name Skill Level value ${cfg.skillLevel}`);
        }
    }

    // pick the active config table entry (combat or elo mode)
    function pickConfig() {
        const configTable = T.combatMode ? COMBAT_CONFIG : ELO_CONFIG;
        return configTable[T.currentElo] || configTable['1000'];
    }

    function applyBookResult(bookResult, fen) {
        T.analyzing = false;
        T.analysisStage = 0;
        T.analyzingFen = fen;
        T.topMoves = (bookResult.topMoves || []).map(m => ({ ...m }));

        const sideToMove = fen.split(' ')[1] || 'w';
        const winRatio = Math.max(0.05, Math.min(0.95, (bookResult.winPct || 50) / 100));
        const cp = Math.round(Math.log(winRatio / (1 - winRatio)) / 0.0036);
        T.evalCp = (sideToMove === 'w') ? cp : -cp;
        T.evalMate = null;
        T.evalDepth = 'Book';

        if (window.TitanWidget && window.TitanWidget.updateEvalDisplay) {
            window.TitanWidget.updateEvalDisplay();
        }

        showMove(bookResult.bestmove, true);
        cacheResult(fen, bookResult.bestmove);
    }

    function startBackgroundSearch(fen) {
        if (!T.engineReady || !T.stockfishWorker) return;
        T.stockfishWorker.postMessage('stop');
        ignoreNextBestmove++;
        T.stockfishWorker.postMessage(`position fen ${fen}`);
        T.stockfishWorker.postMessage('go depth 8 movetime 400');
    }

    // send a position to stockfish for analysis.
    //
    // THREE-LAYER HYBRID ARCHITECTURE:
    //   Layer 1 (0ms - 1ms): Grandmaster Opening Book lookup
    //   Layer 2 (5ms - 20ms): ML Policy & Value Network inference
    //   Layer 3 (100ms - 500ms): Stockfish WASM tactical verification
    //
    // if already analyzing, send 'stop' first to abort the previous
    // search — this prevents the "stuck analysis" issue where a new
    // position never gets analyzed because analyzing=true.
    function analyze(fen) {
        if (!T.engineReady || !T.stockfishWorker) return;
        if (window.TitanContext && !window.TitanContext.isAllowed()) return;
        // run if ANY feature is on: arrows (engineOn) or eval bar (evalBarOn)
        if (!T.engineOn && !T.evalBarOn) return;

        // position cache hit → draw instantly, zero engine work
        const cached = getCachedResult(fen);
        if (cached) { applyCachedResult(cached); return; }

        // LAYER 1: Grandmaster Opening Book lookup (< 0.1ms, 100% GM accurate)
        if (window.TitanBook && window.TitanBook.has(fen)) {
            const bookResult = window.TitanBook.lookup(fen);
            if (bookResult) {
                applyBookResult(bookResult, fen);
                startBackgroundSearch(fen);
                return;
            }
        }

        if (T.analyzing) {
            T.stockfishWorker.postMessage('stop');
            ignoreNextBestmove++;
            T.pendingArrows = [];
            T.arrows = [];
        }
        if (window.TitanStealth) window.TitanStealth.stopMoveDelay();
        if (D.clearStealthPill) D.clearStealthPill();
        T.analyzing = true;
        T.analyzingFen = fen;
        T.pvResults = {};   // fresh buffer for this analysis
        T.topMoves = [];    // clear previous badges
        D.clearMovePct();
        startAnalyzeWatchdog();

        // LAYER 2: ML Fast Positional Inference (5-20ms)
        if (window.TitanML && typeof window.TitanML.predict === 'function') {
            window.TitanML.predict(fen).then(mlRes => {
                if (mlRes && T.analyzing && T.analyzingFen === fen && T.evalCp === null) {
                    const sideToMove = fen.split(' ')[1] || 'w';
                    const winRatio = Math.max(0.05, Math.min(0.95, (mlRes.winPct || 50) / 100));
                    const cp = Math.round(Math.log(winRatio / (1 - winRatio)) / 0.0036);
                    T.evalCp = (sideToMove === 'w') ? cp : -cp;
                    T.evalDepth = 'ML';
                    if (window.TitanWidget && window.TitanWidget.updateEvalDisplay) {
                        window.TitanWidget.updateEvalDisplay();
                    }
                }
            }).catch(() => {});
        }

        const cfg = pickConfig();
        // don't send 'ucinewgame' here — it resets the hash table
        // and kills all cached positions. only sent on actual new games.

        const stage1Depth = Math.min(8, cfg.depth - 4);
        if (cfg.depth >= 12 && stage1Depth >= 6) {
            // deep config → two-stage. stage 1: fast provisional arrow + move% badges (<250ms).
            T.analysisStage = 1;
            T.stockfishWorker.postMessage(`setoption name MultiPV value ${T.movePctOn ? 3 : 1}`);
            T.stockfishWorker.postMessage(`position fen ${fen}`);
            const stage1Cmd = `go depth ${stage1Depth} movetime 350`;
            T.stockfishWorker.postMessage(stage1Cmd);
        } else {
            // shallow config → single pass, final semantics right away
            T.analysisStage = 2;
            T.stockfishWorker.postMessage(`setoption name MultiPV value ${T.movePctOn ? 3 : 1}`);
            T.stockfishWorker.postMessage(`position fen ${fen}`);
            // use movetime as a cap if configured — stockfish searches
            // up to the depth limit but stops early if time runs out.
            const goCmd = cfg.movetime
                ? `go depth ${cfg.depth} movetime ${cfg.movetime}`
                : `go depth ${cfg.depth}`;
            T.stockfishWorker.postMessage(goCmd);
        }
    }

    // stage 2 of the adaptive search: deepen to full config depth with
    // a warm transposition table. called from the bestmove handler
    // after stage 1 returns its provisional move.
    function startStage2() {
        const fen = T.analyzingFen;
        // only deepen if the position we analyzed is still the current
        // one and a feature is still on — otherwise drop silently.
        if (!fen || fen !== T.currentFen || (!T.engineOn && !T.evalBarOn)) {
            T.analyzing = false;
            T.analysisStage = 0;
            return;
        }
        T.analysisStage = 2;
        T.analyzing = true;
        // Keep existing T.topMoves active while Stage 2 deepens so badges don't flicker!
        T.pvResults = {};
        startAnalyzeWatchdog();
        const cfg = pickConfig();
        // MultiPV 3 when movePct is on, so deep pass continues refining top 3 lines
        T.stockfishWorker.postMessage(`setoption name MultiPV value ${T.movePctOn ? 3 : 1}`);
        T.stockfishWorker.postMessage(`position fen ${fen}`);
        const goCmd = cfg.movetime
            ? `go depth ${cfg.depth} movetime ${cfg.movetime}`
            : `go depth ${cfg.depth}`;
        T.stockfishWorker.postMessage(goCmd);
    }

    // called when stockfish returns a bestmove.
    // arrow shows immediately if it's our turn, otherwise stored
    // in pendingArrows so it appears the instant our turn arrives.
    // final=true (default): the result is committed — queue entries,
    // badges, cache. final=false: provisional stage-1 arrow only; it
    // must NOT enter the move queue (would double up when stage 2
    // finalizes) and must not be presented as the final analysis.
    function showMove(move, final) {
        // CONTEXT GATE: re-evaluate now (cheap URL check) so a bestmove
        // racing an SPA navigation into a denied context can never draw.
        if (window.TitanContext) {
            window.TitanContext.update();
            if (!window.TitanContext.isAllowed()) {
                T.pendingArrows = [];
                T.arrows = [];
                return;
            }
        }

        // queue mode: store the move for later (final results only)
        if (final !== false && T.queueMode) {
            T.moveQueue.push(move);
            if (window.TitanWidget) window.TitanWidget.updateQueueDisplay();
        }

        // if the arrow feature is OFF, don't draw the arrow or the
        // move% badges — the eval bar still updates via the info
        // lines, but the board overlay stays clean.
        if (!T.engineOn) return;

        // Humanize Stealth move selection & Live Countdown
        let effectiveMove = move;
        if (final !== false && T.stealthOn && window.TitanStealth) {
            if (T.topMoves && T.topMoves.length > 1) {
                const stealthMove = window.TitanStealth.selectHumanizedMove(T.topMoves, T.currentElo);
                if (stealthMove) effectiveMove = stealthMove;
            }

            const context = {
                isBook: T.evalDepth === 'Book',
                evalCp: T.evalCp,
                isCheck: !!T.evalMate
            };
            window.TitanStealth.startMoveDelay(
                context,
                (rem, tot, pct) => {
                    if (D.renderStealthPill) D.renderStealthPill(rem, tot, pct, false);
                    if (window.TitanWidget && window.TitanWidget.updateStealthTimer) {
                        window.TitanWidget.updateStealthTimer(rem, tot, pct, false);
                    }
                },
                () => {
                    if (D.renderStealthPill) D.renderStealthPill(0, 0, 100, true);
                    if (window.TitanWidget && window.TitanWidget.updateStealthTimer) {
                        window.TitanWidget.updateStealthTimer(0, 0, 100, true);
                    }
                    if (T.hapticFeedbackOn) {
                        try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(35); } catch (e) {}
                    }
                }
            );
        }

        // AI Voice Coach commentary & explanation
        if (final !== false && window.TitanCoach) {
            const expl = window.TitanCoach.explainMove(effectiveMove, T.currentFen);
            if (window.TitanWidget && window.TitanWidget.updateCoachText) {
                window.TitanWidget.updateCoachText(expl);
            }
            if (T.voiceCoachOn) {
                window.TitanCoach.speakCue(expl);
            }
        }

        // Ghost Board Phantom projection
        if (T.phantomOn && window.TitanPhantom && effectiveMove && effectiveMove.length >= 4) {
            window.TitanPhantom.showPhantom(effectiveMove.slice(0, 2), effectiveMove.slice(2, 4));
        }

        // always store the result — monitor() will decide
        // whether to display it based on whose turn it is.
        T.pendingArrows = [{ move: effectiveMove }];
        T.arrows = [{ move: effectiveMove }];
        T.forceRedraw = true;
        D.draw(true);
        // render move% badges alongside the arrow (monitor clears
        // them on opponent's turn, same as the arrows).
        if (D.drawMovePct) D.drawMovePct();
    }

    // switch to combat-level config on the running engine.
    // NOTE: Hash is NOT touched here — it's allocated once at uciok
    // and re-setting it flushes the transposition table.
    function applyCombatConfig() {
        clearCache();   // strength profile changed → cached results invalid
        const cfg = COMBAT_CONFIG[T.currentElo] || COMBAT_CONFIG['1000'];
        if (T.engineReady && T.stockfishWorker) {
            if (cfg.unlimited) {
                T.stockfishWorker.postMessage('setoption name UCI_LimitStrength value false');
                T.stockfishWorker.postMessage('setoption name Contempt value 50');
            } else {
                T.stockfishWorker.postMessage('setoption name UCI_LimitStrength value true');
                T.stockfishWorker.postMessage(`setoption name UCI_Elo value ${cfg.uciElo}`);
            }
            T.stockfishWorker.postMessage(`setoption name Skill Level value ${cfg.skillLevel}`);
        }
    }

    // queue mode: analyze during opponent's turn at reduced depth.
    // this gives us a head start so the arrow appears faster
    // when it becomes our turn. single pass, final semantics.
    function preAnalyze(fen) {
        if (!T.engineReady || !T.stockfishWorker) return;
        // HARD CONTEXT GATE — never run outside allowed contexts
        if (window.TitanContext && !window.TitanContext.isAllowed()) return;
        // run if ANY feature is on: arrows (engineOn) or eval bar (evalBarOn)
        if (!T.engineOn && !T.evalBarOn) return;

        // cache hit → result already final, nothing to pre-compute
        const cached = getCachedResult(fen);
        if (cached) { applyCachedResult(cached); return; }

        if (T.analyzing) {
            T.stockfishWorker.postMessage('stop');
            ignoreNextBestmove++;
            T.pendingArrows = [];
            T.arrows = [];
        }
        if (window.TitanStealth) window.TitanStealth.stopMoveDelay();
        if (D.clearStealthPill) D.clearStealthPill();
        T.analyzing = true;
        T.analyzingFen = fen;
        T.analysisStage = 2;    // single pass → bestmove handler finalizes
        T.pvResults = {};       // fresh buffer for this pre-analysis
        T.topMoves = [];
        startAnalyzeWatchdog();
        const cfg = pickConfig();
        // explicit MultiPV: 3 only when badges are used (movePctOn)
        T.stockfishWorker.postMessage(`setoption name MultiPV value ${T.movePctOn ? 3 : 1}`);
        T.stockfishWorker.postMessage(`position fen ${fen}`);
        // pre-analyze at reduced depth, capped at 3 seconds
        const preDepth = Math.max(6, cfg.depth - 4);
        T.stockfishWorker.postMessage(`go depth ${preDepth} movetime 3000`);
    }

    // ============================================================
    // finalisasi top moves dari multi-PV hasil analisis
    // ============================================================
    //
    // ini adalah fungsi internal yang dipanggil setelah stockfish
    // melaporkan 'bestmove' atau selama streaming live depth.
    // ia mengambil semua pvResults yang dikumpulkan selama pencarian,
    // memfilter ke depth paling stabil dengan multi-PV lengkap,
    // menghitung win% untuk setiap langkah (dari perspektif pemain),
    // dan menyimpan ke T.topMoves agar bisa dirender oleh drawing.js.
    function finalizeTopMoves() {
        if (!T.pvResults || !Object.keys(T.pvResults).length) {
            return;
        }
        const entries = Object.values(T.pvResults);
        if (!entries.length) return;

        // Group by depth to find highest depth with evaluated multi-PV lines
        const depthMap = new Map();
        for (const e of entries) {
            if (!depthMap.has(e.dp)) depthMap.set(e.dp, []);
            depthMap.get(e.dp).push(e);
        }

        const sortedDepths = Array.from(depthMap.keys()).sort((a, b) => b - a);
        let best = null;
        for (const d of sortedDepths) {
            const list = depthMap.get(d);
            // prefer a depth with >= 2 lines (complete multipv) or the only available depth
            if (list.length >= 2 || sortedDepths.length === 1 || d === sortedDepths[sortedDepths.length - 1]) {
                best = list.sort((a, b) => a.mp - b.mp);
                break;
            }
        }
        if (!best || !best.length) {
            best = depthMap.get(sortedDepths[0]).sort((a, b) => a.mp - b.mp);
        }
        if (!best || !best.length) return;

        // sisi yang giliran jalan — default 'w' jika FEN kosong
        const sideToMove = T.currentFen ? T.currentFen.split(' ')[1] : 'w';

        // hitung win% untuk setiap langkah (untuk sisi yang akan bergerak)
        T.topMoves = best.map(entry => {
            const mv = entry.pv;         // format "e2e4"
            const fromSq = mv.slice(0, 2);
            const toSq = mv.slice(2, 4);

            let winPct = 50;             // default: netral
            if (entry.mate !== null) {
                // skakmat: + = putih mendarat, - = hitam mendarat
                winPct = (sideToMove === 'w') ? (entry.mate > 0 ? 100 : 0) : (entry.mate < 0 ? 100 : 0);
            } else if (entry.cp !== null) {
                // cp -> wdl -> win% untuk sisi yang sedang berjalan
                const winningChances = 2 / (1 + Math.exp(-0.00368208 * entry.cp)) - 1;
                const draw = 0.30 * Math.exp(-Math.pow(entry.cp / 300, 2));
                const white = (0.5 + 0.5 * winningChances) * (1 - draw);
                const black = (0.5 - 0.5 * winningChances) * (1 - draw);
                winPct = Math.round(sideToMove === 'w' ? white * 100 : black * 100);
            }

            return { from: fromSq, to: toSq, winPct };
        });
    }

    // hard-stop the engine: abort the current search and mark it
    // as idle. used by the master OFF switch. after this, stockfish
    // sits quietly until analyze()/preAnalyze() is called again.
    function stopAnalysis() {
        if (!T.stockfishWorker) { T.analyzing = false; return; }
        if (T.analyzing) {
            T.stockfishWorker.postMessage('stop');
            ignoreNextBestmove++;   // discard the bestmove from this stop
        }
        T.analyzing = false;
        T.analysisStage = 0;
        T.analyzingFen = null;
        clearAnalyzeWatchdog();
        T.pendingArrows = [];
        T.arrows = [];
        T.topMoves = [];
        T.pvResults = null;
    }

    // ============================================================
    // position result cache
    // ============================================================
    //
    // fen → finalized result {bestmove, topMoves, eval}. stepping
    // back and forth through a review/analysis page hits the same
    // positions repeatedly; a cache hit redraws instantly with zero
    // engine work. only FINAL results are cached (never provisional
    // stage-1 arrows). invalidated on: new game (ucinewgame), elo
    // change, combat-mode change — anything that alters engine
    // strength makes old results meaningless. max 64 entries, FIFO.
    const POS_CACHE_MAX = 64;
    let posCache = new Map();

    function getCachedResult(fen) {
        return posCache.get(fen) || null;
    }

    function cacheResult(fen, bestmove) {
        if (!fen || !bestmove) return;
        if (posCache.size >= POS_CACHE_MAX) {
            posCache.delete(posCache.keys().next().value);
        }
        posCache.set(fen, {
            fen,
            bestmove,
            topMoves: (T.topMoves || []).map(m => ({ ...m })),
            evalCp: T.evalCp,
            evalMate: T.evalMate,
            evalDepth: T.evalDepth
        });
    }

    function applyCachedResult(r) {
        T.analyzing = false;
        T.analysisStage = 0;
        T.analyzingFen = r.fen;
        T.evalCp = r.evalCp;
        T.evalMate = r.evalMate;
        T.evalDepth = r.evalDepth;
        T.topMoves = r.topMoves.map(m => ({ ...m }));
        // refresh widget eval + board eval bar from restored state
        if (window.TitanWidget && window.TitanWidget.updateEvalDisplay) {
            window.TitanWidget.updateEvalDisplay();
        }
        // redraw arrow/badges (final semantics — may queue if queueMode)
        showMove(r.bestmove, true);
    }

    function clearCache() {
        posCache.clear();
    }

    window.TitanEngine = {
        ELO_LEVELS, ELO_LABELS, ELO_CONFIG, COMBAT_CONFIG,
        initEngine, setElo, analyze, showMove, applyCombatConfig, preAnalyze, stopAnalysis, clearCache
    };
})();
