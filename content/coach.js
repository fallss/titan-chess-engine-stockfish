// ============================================================
// titan-free :: AI voice coach & natural explanations (Inovasi 3)
// ============================================================
//
// translates chess moves and evaluations into natural language
// explanations and speaks tactical cues via the Web Speech API.
// completely offline, zero external servers, zero latency.
// ============================================================

(function () {
    'use strict';

    const T = window.TitanState;
    let voiceCoachEnabled = false;
    let lastSpokenText = '';
    let lastSpeakTime = 0;

    // Piece names
    const PIECE_NAMES = {
        p: 'Pion', n: 'Kuda', b: 'Gajah', r: 'Benteng', q: 'Menteri', k: 'Raja'
    };

    // Generate concise tactical explanation
    function explainMove(move, fen) {
        if (!move || move.length < 4) return 'Langkah terbaik posisi saat ini.';
        const from = move.slice(0, 2);
        const to = move.slice(2, 4);

        // Special: Castling
        if (move === 'e1g1' || move === 'e8g8') return 'Rokade pendek: mengamankan Raja dan mengaktifkan Benteng.';
        if (move === 'e1c1' || move === 'e8c8') return 'Rokade panjang: Raja aman dan Benteng langsung menekan lajur.';

        // Detect piece type on 'from' square
        let piece = 'p';
        if (fen) {
            const rows = fen.split(' ')[0].split('/');
            const r = 8 - parseInt(from[1], 10);
            const f = from.charCodeAt(0) - 'a'.charCodeAt(0);
            let idx = 0;
            if (rows[r]) {
                for (const ch of rows[r]) {
                    if (ch >= '1' && ch <= '8') idx += parseInt(ch, 10);
                    else {
                        if (idx === f) { piece = ch.toLowerCase(); break; }
                        idx++;
                    }
                }
            }
        }

        const pName = PIECE_NAMES[piece] || 'Bidak';

        if (piece === 'p') {
            if (to === 'e4' || to === 'd4' || to === 'e5' || to === 'd5') {
                return `${pName} menguasai petak pusat strategis (${to}).`;
            }
            return `${pName} maju ke ${to} membuka ruang perwira.`;
        } else if (piece === 'n') {
            return `${pName} melompat ke ${to} mengontrol petak aktif.`;
        } else if (piece === 'b') {
            return `${pName} berkembang ke diagonal terbuka ${to}.`;
        } else if (piece === 'r') {
            return `${pName} menempati lajur aktif di ${to}.`;
        } else if (piece === 'q') {
            return `${pName} bermanuver menekan posisi lawan di ${to}.`;
        }

        return `${pName} bergerak ke ${to}.`;
    }

    // Speak audio cue via Web Speech API
    function speakCue(text) {
        if (!voiceCoachEnabled || typeof window.speechSynthesis === 'undefined') return;
        if (!text || text === lastSpokenText) return;

        const now = Date.now();
        if (now - lastSpeakTime < 1800) return; // throttle 1.8s
        lastSpeakTime = now;
        lastSpokenText = text;

        try {
            window.speechSynthesis.cancel(); // cancel pending speech
            const utter = new SpeechSynthesisUtterance(text);
            utter.rate = 1.15;
            utter.pitch = 1.0;
            utter.lang = 'id-ID';
            window.speechSynthesis.speak(utter);
        } catch (e) {
            console.warn('[TitanCoach] speech error', e);
        }
    }

    function setVoiceCoach(enabled) {
        voiceCoachEnabled = !!enabled;
    }

    function isVoiceCoachOn() {
        return voiceCoachEnabled;
    }

    // Public API
    window.TitanCoach = {
        explainMove,
        speakCue,
        setVoiceCoach,
        isVoiceCoachOn
    };
})();
