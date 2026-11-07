// ============================================================
// titan-free :: ghost board / phantom piece projection (Inovasi 4)
// ============================================================
//
// projects semi-transparent phantom pieces onto destination squares
// to visualize future tactical positions 3-5 moves ahead.
// ============================================================

(function () {
    'use strict';

    const B = window.TitanBoard;
    let phantomContainer = null;

    function ensurePhantomOverlay() {
        const board = B.findBoard();
        if (!board) return null;
        if (phantomContainer && board.contains(phantomContainer)) return phantomContainer;

        if (phantomContainer && phantomContainer.parentNode) {
            try { phantomContainer.parentNode.removeChild(phantomContainer); } catch (e) {}
        }

        phantomContainer = document.createElement('div');
        phantomContainer.className = 'titan-phantom-overlay';
        phantomContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:102;';
        board.style.position = board.style.position || 'relative';
        board.appendChild(phantomContainer);
        return phantomContainer;
    }

    // Convert square (e.g. "e4") to transform percentage
    function getSquareTransform(sq, orientation) {
        if (!sq || sq.length < 2) return null;
        const file = sq.charCodeAt(0) - 'a'.charCodeAt(0);
        const rank = parseInt(sq[1], 10) - 1;
        const x = (orientation === 'white') ? file : (7 - file);
        const y = (orientation === 'white') ? (7 - rank) : rank;
        return { xPct: x * 100, yPct: y * 100 };
    }

    // Render a glowing ghost piece indicator on destination square
    function showPhantom(fromSq, toSq) {
        const overlay = ensurePhantomOverlay();
        if (!overlay) return;
        overlay.innerHTML = '';

        const rect = B.getBoardRect();
        const orientation = rect ? rect.orientation : 'white';
        const tf = getSquareTransform(toSq, orientation);
        if (!tf) return;

        const ghost = document.createElement('div');
        ghost.className = 'titan-ghost-square';
        ghost.style.cssText =
            `position:absolute;left:0;top:0;width:12.5%;height:12.5%;` +
            `pointer-events:none;transform:translate(${tf.xPct}%,${tf.yPct}%);` +
            `display:flex;align-items:center;justify-content:center;`;

        const pulse = document.createElement('div');
        pulse.style.cssText =
            `width:88%;height:88%;border-radius:12px;` +
            `background:radial-gradient(circle, rgba(0,242,255,0.35) 0%, rgba(0,242,255,0.05) 70%);` +
            `border:2px dashed #00f2ff;box-shadow:0 0 15px rgba(0,242,255,0.5);` +
            `animation:titan-ghost-pulse 1.2s infinite alternate;`;

        ghost.appendChild(pulse);
        overlay.appendChild(ghost);
    }

    function clearPhantom() {
        if (phantomContainer) phantomContainer.innerHTML = '';
    }

    // Public API
    window.TitanPhantom = {
        showPhantom,
        clearPhantom
    };
})();
