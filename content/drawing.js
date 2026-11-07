// ============================================================
// titan-free :: move visualization (DOM injection)
// ============================================================
//
// renders move suggestions directly inside the chess.com board
// element using injected DOM elements. this approach is far more
// reliable than canvas overlay because:
//   - elements inherit the board's coordinate system automatically
//   - no pixel math, no DPR scaling, no viewport quirks
//   - works identically on desktop and mobile
//
// chess.com positions pieces using percentage-based CSS transforms:
//   .piece.square-34 → transform: translate(200%, 400%)
// where file (3) = (file-1)*100% from left, rank (4) = (8-rank)*100% from top.
//
// we use the same system for our highlight/arrow overlays.
//
// draw modes:
//   - highlight: colored div overlays on from/to squares
//   - arrow: SVG arrow injected into the board
//
// draw() renders whatever is in T.arrows[]. turn-based visibility
// is handled by monitor() in content.js — draw() just renders.
// ============================================================

(function () {
    const T = window.TitanState;
    const B = window.TitanBoard;

    // container for our injected elements, lives inside the board
    let overlayContainer = null;

    // convert algebraic square (e.g. 'e4') to chess.com's
    // percentage-based coordinates for CSS transform.
    // returns {xPct, yPct} where each is a multiple of 100%.
    function sqToTransform(sq, orientation) {
        const file = 'abcdefgh'.indexOf(sq[0]); // 0-7
        const rank = parseInt(sq[1]) - 1;        // 0-7
        if (file < 0 || rank < 0 || file > 7 || rank > 7) return null;
        let xPct, yPct;
        if (orientation === 'white') {
            xPct = file * 100;       // a=0%, b=100%, ... h=700%
            yPct = (7 - rank) * 100; // 1=700%, 2=600%, ... 8=0%
        } else {
            xPct = (7 - file) * 100; // h=0%, g=100%, ... a=700%
            yPct = rank * 100;        // 8=700%, 7=600%, ... 1=0%
        }
        return { xPct, yPct };
    }

    // ensure the overlay container exists inside the board element.
    // creates it if missing. the container is position:absolute,
    // fills the board, and has pointer-events:none so clicks pass through.
    // SPA-safe: if the board element was replaced (chess.com does this
    // on navigation), we detect the orphan and re-create.
    function ensureOverlay() {
        const board = B.findBoard();
        if (!board) return null;
        // existing overlay is valid only if it's still inside the CURRENT board
        if (overlayContainer && board.contains(overlayContainer)) return overlayContainer;
        // clean up orphaned overlay from a previous board
        if (overlayContainer && overlayContainer.parentNode) {
            try { overlayContainer.parentNode.removeChild(overlayContainer); } catch (e) {}
        }
        overlayContainer = document.createElement('div');
        overlayContainer.className = 'titan-overlay';
        overlayContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100;';
        board.style.position = board.style.position || 'relative';
        board.appendChild(overlayContainer);
        return overlayContainer;
    }

    // create a highlight div on a single square
    function createHighlightEl(sq, orientation, color, opacity) {
        const pos = sqToTransform(sq, orientation);
        if (!pos) return null;
        const el = document.createElement('div');
        el.className = 'titan-highlight';
        el.style.cssText = `position:absolute;width:12.5%;height:12.5%;` +
            `background:${color};opacity:${opacity};pointer-events:none;` +
            `transform:translate(${pos.xPct}%,${pos.yPct}%);`;
        return el;
    }

    // create an SVG arrow between two squares
    function createArrowSvg(from, to, orientation, color) {
        const f = sqToTransform(from, orientation);
        const t = sqToTransform(to, orientation);
        if (!f || !t) return null;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'titan-arrow');
        svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
        svg.setAttribute('viewBox', '0 0 800 800');

        // center of each square in the 800x800 viewBox (each square = 100 units)
        const fx = f.xPct + 50, fy = f.yPct + 50;
        const tx = t.xPct + 50, ty = t.yPct + 50;

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        const markerId = 'titan-head-' + Date.now();
        marker.setAttribute('id', markerId);
        marker.setAttribute('markerWidth', '4');
        marker.setAttribute('markerHeight', '4');
        marker.setAttribute('refX', '2.5');
        marker.setAttribute('refY', '2');
        marker.setAttribute('orient', 'auto');
        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', '0 0, 4 2, 0 4');
        polygon.setAttribute('fill', color);
        marker.appendChild(polygon);
        defs.appendChild(marker);
        svg.appendChild(defs);

        // glow line (wider, semi-transparent)
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        glow.setAttribute('x1', fx); glow.setAttribute('y1', fy);
        glow.setAttribute('x2', tx); glow.setAttribute('y2', ty);
        glow.setAttribute('stroke', color);
        glow.setAttribute('stroke-width', '28');
        glow.setAttribute('stroke-opacity', '0.3');
        glow.setAttribute('stroke-linecap', 'round');
        svg.appendChild(glow);

        // solid line
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', fx); line.setAttribute('y1', fy);
        line.setAttribute('x2', tx); line.setAttribute('y2', ty);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '18');
        line.setAttribute('stroke-opacity', '0.9');
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('marker-end', `url(#${markerId})`);
        svg.appendChild(line);

        return svg;
    }

    // main render function — clears previous overlays and draws
    // whatever is in T.arrows[]. called from monitor loop.
    function draw(force) {
        try {
            const container = ensureOverlay();
            if (!container) return;

            // clear previous elements
            container.innerHTML = '';

            if (!T.arrows.length) return;

            const orientation = B.getPlayerColor() === 'w' ? 'white' : 'black';
            const color = T.arrowColor || '#00f2ff';

            T.forceRedraw = false;

            T.arrows.forEach(a => {
                if (!a || !a.move || a.move.length < 4) return;
                const from = a.move.substring(0, 2), to = a.move.substring(2, 4);

                if (T.arrowMode === 'highlight') {
                    const fromEl = createHighlightEl(from, orientation, color, 0.35);
                    const toEl = createHighlightEl(to, orientation, color, 0.5);
                    if (fromEl) container.appendChild(fromEl);
                    if (toEl) container.appendChild(toEl);
                } else {
                    // arrow mode (SVG)
                    const arrowEl = createArrowSvg(from, to, orientation, color);
                    if (arrowEl) container.appendChild(arrowEl);
                }
            });
        } catch (err) {
            console.error('[TitanFree] draw error', err);
        }
    }

    function clearArrows() {
        T.arrows = [];
        if (overlayContainer) overlayContainer.innerHTML = '';
    }

    // init is now a no-op — no canvas needed.
    // the overlay container is created lazily in ensureOverlay().
    function initCanvas() {
        // legacy name kept for API compatibility with content.js
        // actual init happens on first draw() call via ensureOverlay()
    }

    // ============================================================
    // board eval bar (W/D/L percentages rendered on the board)
    // ============================================================
    //
    // a slim, glassy bar that floats just BELOW the board so it never
    // covers pieces. it shows the live win/draw/loss probabilities as
    // a segmented bar with the eval score on the left. driven by
    // renderBoardEval() which widget.js calls from updateEvalDisplay().
    //
    // the bar uses position:fixed and re-anchors to the board's
    // bounding rect on scroll/resize, so it tracks the board wherever
    // it moves on the page. pointer-events are off.

    let evalBarEl = null;
    let evalBarAnchored = false;

    // create (once) and return the eval bar element.
    function ensureEvalBar() {
        if (evalBarEl && document.body && document.body.contains(evalBarEl)) return evalBarEl;
        if (!evalBarEl) {
            evalBarEl = document.createElement('div');
            evalBarEl.className = 'titan-board-eval';
            evalBarEl.innerHTML = `
                <div class="tbe-score" id="tbe-score">—</div>
                <div class="tbe-bar">
                    <div class="tbe-seg tbe-white" id="tbe-white"><span>—</span></div>
                    <div class="tbe-seg tbe-draw" id="tbe-draw"><span>—</span></div>
                    <div class="tbe-seg tbe-black" id="tbe-black"><span>—</span></div>
                </div>
            `;
        }
        if (document.body && !document.body.contains(evalBarEl)) {
            document.body.appendChild(evalBarEl);
        }
        anchorEvalBarListener();
        return evalBarEl;
    }

    // re-position the eval bar just below the board. force=true so we
    // always get a fresh viewport rect — the cached rect goes stale on
    // scroll, which would leave the bar floating in the wrong spot.
    function anchorEvalBar() {
        if (!evalBarEl) return;
        const rect = B.getBoardRect(true);
        if (!rect) { evalBarEl.style.display = 'none'; return; }
        const gap = 6;
        evalBarEl.style.left = rect.x + 'px';
        evalBarEl.style.top = (rect.y + rect.height + gap) + 'px';
        evalBarEl.style.width = rect.width + 'px';
    }

    // attach (once) scroll/resize listeners to re-anchor the bar.
    function anchorEvalBarListener() {
        if (evalBarAnchored) return;
        evalBarAnchored = true;
        window.addEventListener('scroll', anchorEvalBar, { passive: true });
        window.addEventListener('resize', anchorEvalBar, { passive: true });
    }

    // render the W/D/L bar. called on every engine info line with the
    // computed probabilities + score text. hasEval=false → waiting state.
    function renderBoardEval(wdl, scoreText, hasEval) {
        const el = ensureEvalBar();
        if (!el) return;

        // CONTEXT GATE: never show engine eval in denied contexts
        // (live human games etc.) — late info lines after an SPA
        // navigation must not re-show the bar.
        if (window.TitanContext && !window.TitanContext.isAllowed()) {
            el.style.display = 'none';
            return;
        }

        // respect the eval-bar toggle ONLY — the eval bar is an
        // independent feature, separate from the arrow/titan toggle.
        if (!T.evalBarOn) { el.style.display = 'none'; return; }

        anchorEvalBar();
        el.style.display = 'flex';

        const score = el.querySelector('#tbe-score');
        if (score) score.textContent = hasEval ? scoreText : '—';

        const white = el.querySelector('#tbe-white');
        const draw = el.querySelector('#tbe-draw');
        const black = el.querySelector('#tbe-black');
        const pw = el.querySelector('#tbe-white span');
        const pd = el.querySelector('#tbe-draw span');
        const pb = el.querySelector('#tbe-black span');

        if (hasEval) {
            if (white) white.style.width = wdl.white + '%';
            if (draw) draw.style.width = wdl.draw + '%';
            if (black) black.style.width = wdl.black + '%';
            if (pw) pw.textContent = wdl.white + '%';
            if (pd) pd.textContent = wdl.draw + '%';
            if (pb) pb.textContent = wdl.black + '%';
        } else {
            // waiting for first eval: full-width neutral grey bar
            if (white) white.style.width = '0%';
            if (draw) draw.style.width = '100%';
            if (black) black.style.width = '0%';
            if (pw) pw.textContent = '—';
            if (pd) pd.textContent = '—';
            if (pb) pb.textContent = '—';
        }
    }

    // explicit show/hide for the eval-bar toggle (called from widget.js)
    // so it responds instantly instead of waiting for the next info line.
    function setBoardEval(on) {
        if (!evalBarEl) return;
        // CONTEXT GATE: turning the bar ON in a denied context is a no-op
        if (on && window.TitanContext && !window.TitanContext.isAllowed()) return;
        if (on) { anchorEvalBar(); evalBarEl.style.display = 'flex'; }
        else { evalBarEl.style.display = 'none'; }
    }

    // ============================================================
    // move win% badges (top-moves overlay)
    // ============================================================
    //
    // renders a percentage badge on the destination square of each
    // candidate move in T.topMoves. green = good (winning), grey =
    // neutral, red = bad. the best move is marked with a small ★.
    // uses a dedicated overlay so badges don't clobber the arrows.

    let movePctOverlay = null;

    function ensureMovePctOverlay() {
        const board = B.findBoard();
        if (!board) return null;
        if (movePctOverlay && board.contains(movePctOverlay)) return movePctOverlay;
        // clean up orphaned overlay from a previous board (SPA navigation)
        if (movePctOverlay && movePctOverlay.parentNode) {
            try { movePctOverlay.parentNode.removeChild(movePctOverlay); } catch (e) {}
        }
        movePctOverlay = document.createElement('div');
        movePctOverlay.className = 'titan-movepct';
        movePctOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:101;';
        board.style.position = board.style.position || 'relative';
        board.appendChild(movePctOverlay);
        return movePctOverlay;
    }

    // pick a badge color for a given win% (0-100).
    function winPctColor(pct) {
        if (pct >= 62) return { bg: 'rgba(0,255,136,0.22)', border: 'rgba(0,255,136,0.85)', text: '#00ff88' };
        if (pct >= 53) return { bg: 'rgba(0,242,255,0.18)', border: 'rgba(0,242,255,0.75)', text: '#00f2ff' };
        if (pct <= 38) return { bg: 'rgba(255,64,64,0.22)', border: 'rgba(255,64,64,0.85)', text: '#ff5252' };
        if (pct <= 47) return { bg: 'rgba(255,140,0,0.18)', border: 'rgba(255,140,0,0.7)', text: '#ffa940' };
        return { bg: 'rgba(160,160,160,0.18)', border: 'rgba(200,200,200,0.6)', text: '#d5d5d5' };
    }

    // render the move% badges. called by engine.js after finalizeTopMoves.
    function drawMovePct() {
        const overlay = ensureMovePctOverlay();
        if (!overlay) return;
        if (!T.movePctOn || !T.topMoves || !T.topMoves.length) {
            overlay.innerHTML = '';
            return;
        }

        const orientation = B.getBoardRect() ? B.getBoardRect().orientation : 'white';
        const existingBadges = overlay.children;

        // In-place DOM recycling if badge count matches topMoves:
        // updates position, text, and styles smoothly with zero DOM thrashing / zero flicker
        if (existingBadges && existingBadges.length === T.topMoves.length) {
            let matched = true;
            for (let idx = 0; idx < T.topMoves.length; idx++) {
                const m = T.topMoves[idx];
                const badge = existingBadges[idx];
                const square = m.to || m.from;
                if (!square || !badge) { matched = false; break; }
                const tf = sqToTransform(square, orientation);
                if (!tf) { matched = false; break; }

                const c = winPctColor(m.winPct);
                badge.style.transform = `translate(${tf.xPct}%,${tf.yPct}%)`;
                const inner = badge.firstElementChild;
                if (inner) {
                    inner.style.background = c.bg;
                    inner.style.border = `2px solid ${c.border}`;
                    const num = inner.querySelector('.titan-pct-num');
                    if (num) {
                        num.textContent = m.winPct + '%';
                        num.style.color = c.text;
                    }
                }
            }
            if (matched) return;
        }

        overlay.innerHTML = '';

        T.topMoves.forEach((m, idx) => {
            const square = m.to || m.from;
            if (!square) return;
            const tf = sqToTransform(square, orientation);
            if (!tf) return;

            const c = winPctColor(m.winPct);
            const badge = document.createElement('div');
            badge.className = 'titan-movepct-badge';
            // NOTE: translate() percentages are relative to the element's own
            // size (which is one square = 12.5% of the board), so xPct/yPct
            // map 1:1 to square coordinates. matches createHighlightEl().
            badge.style.cssText =
                `position:absolute;left:0;top:0;width:12.5%;height:12.5%;` +
                `display:flex;align-items:center;justify-content:center;` +
                `pointer-events:none;transform:translate(${tf.xPct}%,${tf.yPct}%);`;
            // inner circle with the percentage
            const inner = document.createElement('div');
            inner.style.cssText =
                `width:82%;height:82%;border-radius:50%;display:flex;flex-direction:column;` +
                `align-items:center;justify-content:center;box-sizing:border-box;` +
                `background:${c.bg};border:2px solid ${c.border};` +
                `box-shadow:0 2px 8px rgba(0,0,0,0.45);`;
            const num = document.createElement('span');
            num.className = 'titan-pct-num';
            num.textContent = m.winPct + '%';
            num.style.cssText = `font-size:13px;font-weight:800;color:${c.text};line-height:1;` +
                `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;` +
                `text-shadow:0 1px 3px rgba(0,0,0,0.7);`;
            inner.appendChild(num);

            if (idx === 0) {
                // best move gets a small star above the number
                const star = document.createElement('span');
                star.className = 'titan-pct-star';
                star.textContent = '★';
                star.style.cssText = `font-size:9px;line-height:1;color:#ffd54a;` +
                    `text-shadow:0 1px 2px rgba(0,0,0,0.8);`;
                inner.appendChild(star);
            }

            badge.appendChild(inner);
            overlay.appendChild(badge);
        });
    }

    // remove all move% badges (called on new game / opponent's turn).
    function clearMovePct() {
        if (movePctOverlay) movePctOverlay.innerHTML = '';
    }

    // ============================================================
    // Threat Radar: Hanging pieces & danger squares
    // ============================================================
    let threatOverlay = null;

    function ensureThreatOverlay() {
        const board = B.findBoard();
        if (!board) return null;
        if (threatOverlay && board.contains(threatOverlay)) return threatOverlay;
        if (threatOverlay && threatOverlay.parentNode) {
            try { threatOverlay.parentNode.removeChild(threatOverlay); } catch (e) {}
        }
        threatOverlay = document.createElement('div');
        threatOverlay.className = 'titan-threat-overlay';
        threatOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99;';
        board.style.position = board.style.position || 'relative';
        board.appendChild(threatOverlay);
        return threatOverlay;
    }

    function drawThreats(threatData) {
        const overlay = ensureThreatOverlay();
        if (!overlay) return;
        overlay.innerHTML = '';
        if (!threatData || !threatData.hanging || !threatData.hanging.length) return;

        const orientation = B.getBoardRect() ? B.getBoardRect().orientation : 'white';
        threatData.hanging.forEach(item => {
            const tf = sqToTransform(item.square, orientation);
            if (!tf) return;
            const el = document.createElement('div');
            el.className = 'titan-threat-hanging';
            el.style.transform = `translate(${tf.xPct}%,${tf.yPct}%)`;
            const pulse = document.createElement('div');
            pulse.className = 'titan-threat-hanging-pulse';
            el.appendChild(pulse);
            overlay.appendChild(el);
        });
    }

    function clearThreats() {
        if (threatOverlay) threatOverlay.innerHTML = '';
    }

    window.TitanDraw = {
        draw, clearArrows, initCanvas, renderBoardEval, setBoardEval,
        drawMovePct, clearMovePct, drawThreats, clearThreats
    };
})();
