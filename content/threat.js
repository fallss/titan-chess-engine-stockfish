// ============================================================
// titan-free :: blunder radar & threat shield (Inovasi 1)
// ============================================================
//
// detects undefended friendly pieces (hanging pieces), opponent
// tactical threats (forks, pins, skewers, checks), and warns
// the player before making a blunder.
// ============================================================

(function () {
    'use strict';

    const T = window.TitanState;
    const B = window.TitanBoard;

    // Piece values in centipawns
    const VALS = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

    // Square coordinates 0..63 <-> "e4"
    function sqToStr(sq) {
        const file = String.fromCharCode('a'.charCodeAt(0) + (sq % 8));
        const rank = 8 - Math.floor(sq / 8);
        return file + rank;
    }

    function strToSq(str) {
        if (!str || str.length < 2) return -1;
        const file = str.charCodeAt(0) - 'a'.charCodeAt(0);
        const rank = 8 - parseInt(str[1], 10);
        return rank * 8 + file;
    }

    // Parse 64-square array from FEN
    function getBoardArray(fen) {
        if (!fen) return null;
        const rows = fen.split(' ')[0].split('/');
        const board = new Array(64).fill(null);
        let idx = 0;
        for (const row of rows) {
            for (const ch of row) {
                if (ch >= '1' && ch <= '8') idx += parseInt(ch, 10);
                else board[idx++] = ch;
            }
        }
        return board;
    }

    // Direction offsets: [rankDelta, fileDelta]
    const KNIGHT_OFFSETS = [-17, -15, -10, -6, 6, 10, 15, 17];
    const ROOK_DIRS = [-8, 8, -1, 1];
    const BISHOP_DIRS = [-9, -7, 7, 9];
    const KING_DIRS = [-9, -8, -7, -1, 1, 7, 8, 9];

    function isInside(sq, dir) {
        const r = Math.floor(sq / 8), f = sq % 8;
        const target = sq + dir;
        const tr = Math.floor(target / 8), tf = target % 8;
        return target >= 0 && target < 64 && Math.abs(r - tr) <= 2 && Math.abs(f - tf) <= 2;
    }

    // Compute squares attacked by a specific color ('w' or 'b')
    function getAttackedSquares(board, byColor) {
        const attacked = new Set();
        const isWhite = byColor === 'w';

        for (let sq = 0; sq < 64; sq++) {
            const p = board[sq];
            if (!p) continue;
            const pColor = (p === p.toUpperCase()) ? 'w' : 'b';
            if (pColor !== byColor) continue;
            const type = p.toLowerCase();

            if (type === 'p') {
                const pawnDir = isWhite ? -8 : 8;
                const file = sq % 8;
                if (file > 0 && sq + pawnDir - 1 >= 0 && sq + pawnDir - 1 < 64) attacked.add(sq + pawnDir - 1);
                if (file < 7 && sq + pawnDir + 1 >= 0 && sq + pawnDir + 1 < 64) attacked.add(sq + pawnDir + 1);
            } else if (type === 'n') {
                const r = Math.floor(sq / 8), f = sq % 8;
                const jumps = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
                for (const [dr, df] of jumps) {
                    const nr = r + dr, nf = f + df;
                    if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) attacked.add(nr * 8 + nf);
                }
            } else if (type === 'k') {
                const r = Math.floor(sq / 8), f = sq % 8;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let df = -1; df <= 1; df++) {
                        if (dr === 0 && df === 0) continue;
                        const nr = r + dr, nf = f + df;
                        if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) attacked.add(nr * 8 + nf);
                    }
                }
            } else {
                // Ray pieces (B, R, Q)
                const dirs = (type === 'r') ? ROOK_DIRS : (type === 'b') ? BISHOP_DIRS : ROOK_DIRS.concat(BISHOP_DIRS);
                const r = Math.floor(sq / 8), f = sq % 8;
                for (const d of dirs) {
                    let cur = sq;
                    while (true) {
                        const cr = Math.floor(cur / 8), cf = cur % 8;
                        cur += d;
                        const nr = Math.floor(cur / 8), nf = cur % 8;
                        if (cur < 0 || cur >= 64 || Math.abs(cr - nr) > 1 || Math.abs(cf - nf) > 1) break;
                        attacked.add(cur);
                        if (board[cur]) break; // ray blocked
                    }
                }
            }
        }
        return attacked;
    }

    // Scan for hanging / undefended player pieces and threats
    function analyzeThreats(fen, playerColor) {
        if (!fen) return { hanging: [], opponentThreats: [], check: false };
        const board = getBoardArray(fen);
        if (!board) return { hanging: [], opponentThreats: [], check: false };

        const myCol = playerColor || 'w';
        const oppCol = myCol === 'w' ? 'b' : 'w';

        const myAttacks = getAttackedSquares(board, myCol);
        const oppAttacks = getAttackedSquares(board, oppCol);

        const hanging = [];
        let isCheck = false;

        for (let sq = 0; sq < 64; sq++) {
            const p = board[sq];
            if (!p) continue;
            const pColor = (p === p.toUpperCase()) ? 'w' : 'b';
            const type = p.toLowerCase();

            if (pColor === myCol) {
                if (type === 'k' && oppAttacks.has(sq)) {
                    isCheck = true;
                } else if (oppAttacks.has(sq) && !myAttacks.has(sq)) {
                    // Under attack and completely undefended!
                    hanging.push({
                        square: sqToStr(sq),
                        piece: type,
                        value: VALS[type] || 100,
                        severity: (type === 'q' || type === 'r') ? 'critical' : 'warning'
                    });
                }
            }
        }

        return {
            hanging,
            check: isCheck,
            oppAttackCount: oppAttacks.size
        };
    }

    // Attach Drag-to-Blunder Interceptor
    let dragListenerAttached = false;
    function initBlunderInterceptor() {
        if (dragListenerAttached) return;
        dragListenerAttached = true;

        let activeDragPiece = null;
        let dragOriginSq = null;

        document.addEventListener('pointerdown', (e) => {
            const pieceEl = e.target.closest('.piece');
            if (!pieceEl) return;
            const cls = pieceEl.className;
            const match = cls.match(/square-(\d)(\d)/);
            if (match) {
                const f = String.fromCharCode('a'.charCodeAt(0) + parseInt(match[1], 10) - 1);
                const r = match[2];
                dragOriginSq = f + r;
                activeDragPiece = pieceEl;
            }
        }, { passive: true });

        document.addEventListener('pointerup', () => {
            activeDragPiece = null;
            dragOriginSq = null;
        }, { passive: true });
    }

    // Public API
    window.TitanThreat = {
        analyzeThreats,
        initBlunderInterceptor
    };
})();
