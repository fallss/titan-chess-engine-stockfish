// ============================================================
// titan :: context detection & mode gating
// ============================================================
//
// Identifies the active mode on Chess.com:
//   - 'computer' : Play vs Computer (/play/computer, /game/computer, or bot cards)
//   - 'live'     : Live Human Match (/game/live, /play/online, /live)
//   - 'daily'    : Daily Chess (/game/daily, /play/daily, /daily)
//   - 'review'   : Game Review (/game/review, /game/:id/review)
//   - 'analysis' : Analysis Board (/analysis)
//   - 'practice' : Practice mode (/practice, /drills)
//   - 'puzzle'   : Puzzles & Puzzle Rush (/puzzles, /puzzle-rush, /battle)
//
// All legitimate chess.com game & analysis modes are ALLOWED.
// Non-game pages (articles, member profiles, settings) and non-chess.com
// hosts are DENIED to protect performance and avoid spurious errors.
// ============================================================

(function () {
    // --- URL rules (primary signal) ---------------------------------
    const URL_RULES = [
        // 1. Analysis Board
        { re: /^https:\/\/(www\.)?chess\.com\/analysis(\/|$|\?)/, ctx: 'analysis' },

        // 2. Game Review
        { re: /^https:\/\/(www\.)?chess\.com\/game\/review(\/|$|\?)/, ctx: 'review' },
        { re: /^https:\/\/(www\.)?chess\.com\/game\/\d+\/review(\/|$|\?)/, ctx: 'review' },
        { re: /^https:\/\/(www\.)?chess\.com\/review(\/|$|\?)/, ctx: 'review' },

        // 3. Play vs Computer (explicit bot URLs)
        { re: /^https:\/\/(www\.)?chess\.com\/game\/computer(\/|$|\?)/, ctx: 'computer' },
        { re: /^https:\/\/(www\.)?chess\.com\/play\/computer(\/|$|\?)/, ctx: 'computer' },
        { re: /^https:\/\/(www\.)?chess\.com\/practice\/custom(\/|$|\?)/, ctx: 'computer' },

        // 4. Practice
        { re: /^https:\/\/(www\.)?chess\.com\/practice(\/|$|\?)/, ctx: 'practice' },
        { re: /^https:\/\/(www\.)?chess\.com\/drills(\/|$|\?)/, ctx: 'practice' },

        // 5. Puzzles & Puzzle Rush
        { re: /^https:\/\/(www\.)?chess\.com\/puzzles?(\/|$|\?)/, ctx: 'puzzle' },
        { re: /^https:\/\/(www\.)?chess\.com\/puzzle-rush(\/|$|\?)/, ctx: 'puzzle' },
        { re: /^https:\/\/(www\.)?chess\.com\/puzzle-battle(\/|$|\?)/, ctx: 'puzzle' },
        { re: /^https:\/\/(www\.)?chess\.com\/battle(\/|$|\?)/, ctx: 'puzzle' },

        // 6. Daily Chess
        { re: /^https:\/\/(www\.)?chess\.com\/game\/daily(\/|$|\?)/, ctx: 'daily' },
        { re: /^https:\/\/(www\.)?chess\.com\/play\/daily(\/|$|\?)/, ctx: 'daily' },
        { re: /^https:\/\/(www\.)?chess\.com\/daily(\/|$|\?)/, ctx: 'daily' },

        // 7. Live Human Matches & Online Play
        { re: /^https:\/\/(www\.)?chess\.com\/game\/live(\/|$|\?)/, ctx: 'live' },
        { re: /^https:\/\/(www\.)?chess\.com\/play\/online(\/|$|\?)/, ctx: 'live' },
        { re: /^https:\/\/(www\.)?chess\.com\/live(\/|$|\?)/, ctx: 'live' },

        // 8. General Play Lobby
        { re: /^https:\/\/(www\.)?chess\.com\/play\/?(\?.*)?$/, ctx: 'live' }
    ];

    // --- DOM rule (secondary signal, for bot games loading under /live/ URLs) ---
    let botSignal = false;
    let lastDomCheck = 0;
    const DOM_CHECK_INTERVAL = 1000;   // ms

    function checkBotDom() {
        const now = Date.now();
        if (now - lastDomCheck < DOM_CHECK_INTERVAL) return botSignal;
        lastDomCheck = now;

        let scope = document.querySelector('#board-layout-player-top, #board-layout-player-bottom');
        if (!scope) scope = document.querySelector('.player-card-top, .player-card-bottom');
        if (!scope) {
            botSignal = false;
            return false;
        }

        botSignal = !!(
            scope.querySelector('a[href*="/bot/"]') ||
            scope.querySelector('a[href*="/play/computer/"]') ||
            scope.querySelector('[class*="bot-badge"], .player-card-bot-badge')
        );
        return botSignal;
    }

    function isChessComHost(url) {
        if (!url || typeof url !== 'string') return false;
        return /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*chess\.com(?::\d+)?(?:\/|$|\?)/i.test(url);
    }

    // --- gate state ----------------------------------------------------
    const state = {
        allowed: false,
        context: 'unknown',
        lastUrl: ''
    };

    function update() {
        const url = (typeof location !== 'undefined' && location.href) ? location.href : '';
        if (url !== state.lastUrl) {
            state.lastUrl = url;
            botSignal = false;
            lastDomCheck = 0;
        }

        // Host validation: must be on chess.com
        if (!isChessComHost(url)) {
            state.allowed = false;
            state.context = 'denied';
            return false;
        }

        let matched = false;
        let context = 'denied';

        for (const rule of URL_RULES) {
            if (rule.re.test(url)) {
                matched = true;
                context = rule.ctx;
                break;
            }
        }

        // Secondary check: bot opponent on a live game URL
        if (matched && context === 'live' && checkBotDom()) {
            context = 'computer';
        } else if (!matched && checkBotDom()) {
            matched = true;
            context = 'computer';
        }

        state.allowed = matched;
        state.context = context;
        return state.allowed;
    }

    function isAllowed() { return state.allowed; }
    function getContext() { return state.context; }

    window.TitanContext = { update, isAllowed, getContext };
})();
