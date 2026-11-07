// ============================================================
// titan-free :: humanize stealth engine (Inovasi 2)
// ============================================================
//
// anti-cheat evasion & natural human timing engine.
// prevents fair-play bans by ensuring:
// 1. Natural Gaussian jitter move timing (no robotic delays).
// 2. Humanized candidate move selection (Maia / GM style).
// 3. Controlled Accuracy / CAPS to match target Elo profile.
// ============================================================

(function () {
    'use strict';

    const T = window.TitanState;

    // Normal random distribution generator (Box-Muller transform)
    function randomGaussian(mean, stdDev) {
        let u1 = 0, u2 = 0;
        while (u1 === 0) u1 = Math.random();
        while (u2 === 0) u2 = Math.random();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return z0 * stdDev + mean;
    }

    // Calculate natural human thinking delay in milliseconds
    function calculateHumanDelay(moveContext) {
        // moveContext: { isBook, isCapture, isCheck, isEndgame, evalCp }
        let meanMs = 2400;
        let stdDevMs = 600;

        if (moveContext.isBook) {
            // Opening book: fast, confident human moves
            meanMs = 900;
            stdDevMs = 250;
        } else if (moveContext.isCapture) {
            // Recaptures: natural fast reflex
            meanMs = 1200;
            stdDevMs = 350;
        } else if (moveContext.isCheck) {
            // Responding to check
            meanMs = 1800;
            stdDevMs = 450;
        } else if (Math.abs(moveContext.evalCp || 0) > 300) {
            // Comfortable winning position: steady relaxed play
            meanMs = 2100;
            stdDevMs = 500;
        } else {
            // Critical positional / tactical decision
            meanMs = 4800;
            stdDevMs = 1200;
        }

        const delay = Math.round(randomGaussian(meanMs, stdDevMs));
        return Math.max(500, Math.min(12000, delay));
    }

    // Select natural human move from top candidates
    function selectHumanizedMove(topMoves, targetElo) {
        if (!topMoves || !topMoves.length) return null;
        if (topMoves.length === 1) return topMoves[0].move || (topMoves[0].from + topMoves[0].to);

        // At Master/Stockfish level (Elo >= 2500): play #1 best move
        const elo = parseInt(T.currentElo || '1500', 10);
        if (elo >= 2500 || T.combatMode) {
            const m = topMoves[0];
            return m.move || (m.from + m.to);
        }

        // Below 2500: occasionally select 2nd best candidate if win% is very close
        // (prevents robotic 100% #1 engine choice pattern)
        const best = topMoves[0];
        const second = topMoves[1];
        const winDiff = Math.abs((best.winPct || 50) - (second.winPct || 50));

        // If 2nd move is within 3% win-rate and probability roll passes, play 2nd move
        if (winDiff <= 3 && Math.random() < 0.25) {
            return second.move || (second.from + second.to);
        }

        return best.move || (best.from + best.to);
    }

    // Public API
    window.TitanStealth = {
        calculateHumanDelay,
        selectHumanizedMove
    };
})();
