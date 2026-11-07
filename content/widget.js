// ============================================================
// titan-free :: floating widget UI
// ============================================================
//
// this is the main dashboard that floats on top of chess.com.
// it handles everything the user interacts with:
//   - tab navigation (engine, info, style, arrow, eval)
//   - elo slider with level labels
//   - mode switching (account / combat / threat)
//   - arrow color and mode selection
//   - theme switching (dark, light, purple, green, orange)
//   - drag-to-move, minimize, hide
//   - settings persistence via chrome.storage
//
// the widget is injected as a raw HTML string (no framework).
// chess.com's CSS is aggressive, so we load our own stylesheet
// and use !important liberally in widget.css to fight back.
//
// === ADDING A NEW TAB ===
//
// 1. add a .widget-tab div and .widget-icon div in the HTML
// 2. add a .tab-content div with matching data-content attribute
// 3. the tab/icon click handlers are generic — they'll pick it
//    up automatically via data-tab / data-icon attributes
//
// === SETTINGS PERSISTENCE ===
//
// all user preferences are saved to chrome.storage.local:
//   elo, arrowMode, arrowColor, theme, engineMode, queueMode
// loadWidgetSettings() restores them on page load.
// if you add a new setting, save it in the relevant handler
// and restore it in loadWidgetSettings().
//
// === WHAT NOT TO CHANGE ===
//
// - the widget ID ('titan-widget') — CSS and other modules
//   reference it by ID for theme application
// - the data-theme attribute on #titan-widget — that's how
//   CSS custom properties switch between themes
// - the .tab-content display toggling logic — we use both
//   classList AND inline style.display because chess.com's
//   CSS can override one but not both
// ============================================================

(function () {
    const T = window.TitanState;
    const B = window.TitanBoard;
    const D = window.TitanDraw;
    const Eng = window.TitanEngine;
    const Ch = window.TitanChrome;   // safe chrome.* wrapper (see state.js)

    // tracks which elo level is selected in the slider.
    // index into Eng.ELO_LEVELS and Eng.ELO_LABELS arrays.
    let currentEloIndex = 0;

    // apply theme by setting data-theme on the widget root.
    // CSS custom properties in widget.css handle the rest.
    // don't apply to document.body — chess.com will override it.
    function applyTheme(theme) {
        const widget = document.getElementById('titan-widget');
        if (widget) widget.setAttribute('data-theme', theme || 'dark');
    }

    // build and inject the entire widget into the page.
    // this is one big HTML template — not pretty, but it works
    // and avoids any build tooling or framework dependency.
    //
    // the structure:
    //   #titan-widget
    //     .widget-header (draggable, has minimize button)
    //     .widget-body
    //       .widget-tabs (text tabs) + .widget-icons (emoji tabs)
    //       .tab-content-container (one div per tab)
    //       .widget-toolbar (quick-access icons at bottom)
    //     #widget-advanced (overlay panel for theme/color settings)
    function createFloatingWidget() {
        if (document.getElementById('titan-widget')) return;
        if (!Ch.alive) return;   // extension reloaded — don't inject a broken widget

        // load our stylesheet — must be a separate file because
        // inline styles alone can't handle :hover, animations, etc.
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = Ch.getURL('content/widget.css');
        document.head.appendChild(link);

        const widget = document.createElement('div');
        widget.id = 'titan-widget';
        widget.innerHTML = `
            <div class="widget-status connected" id="widget-status-dot"></div>
            <div class="widget-header">
                <div class="widget-title">TITAN FREE</div>
                <button class="widget-minimize" title="Minimize">−</button>
            </div>
            <div class="widget-body">
                <div class="widget-tabs">
                    <div class="widget-tab active" data-tab="engine">ENGINE</div>
                    <div class="widget-tab" data-tab="info">INFO</div>
                    <div class="widget-tab" data-tab="style">STYLE</div>
                    <div class="widget-tab" data-tab="arrow">ARROW</div>
                    <div class="widget-tab" data-tab="eval">EVAL</div>
                </div>
                <div class="widget-icons">
                    <div class="widget-icon active" data-icon="engine" title="Engine">⚙️</div>
                    <div class="widget-icon" data-icon="info" title="Info">ℹ️</div>
                    <div class="widget-icon" data-icon="style" title="Style">🎨</div>
                    <div class="widget-icon" data-icon="arrow" title="Arrow">➜</div>
                    <div class="widget-icon" data-icon="eval" title="Eval">📊</div>
                </div>
                <div class="widget-eval-strip" id="widget-eval-strip" style="display:block">
                    <div class="eval-strip-bar">
                        <div class="eval-strip-white" id="eval-strip-white" style="width:50%"></div>
                        <div class="eval-strip-draw" id="eval-strip-draw" style="width:0%"></div>
                        <div class="eval-strip-black" id="eval-strip-black" style="width:50%"></div>
                        <div class="eval-strip-marker" id="eval-strip-marker" style="left:50%"></div>
                    </div>
                    <div class="eval-strip-text">
                        <span class="eval-strip-label">White <b id="eval-strip-pct-white">50%</b></span>
                        <span class="eval-strip-label">Draw <b id="eval-strip-pct-draw">0%</b></span>
                        <span class="eval-strip-label">Black <b id="eval-strip-pct-black">50%</b></span>
                    </div>
                </div>
                <div class="tab-content-container">
                    <!-- ENGINE tab: mode buttons, elo slider, action buttons -->
                    <div class="tab-content active" data-content="engine">
                        <div class="widget-modes">
                            <div class="mode-btn threat">THREAT</div>
                            <div class="mode-btn account active">ACCOUNT</div>
                            <div class="mode-btn combat">COMBAT</div>
                        </div>
                        <div class="widget-elo">
                            <div class="elo-slider">
                                <div class="elo-arrow" data-action="first">«</div>
                                <div class="elo-arrow" data-action="prev">‹</div>
                                <div class="elo-display">
                                    <div class="elo-value" id="elo-value">1000</div>
                                    <div class="elo-label" id="elo-label">BRONZE</div>
                                </div>
                                <div class="elo-arrow" data-action="next">›</div>
                                <div class="elo-arrow" data-action="last">»</div>
                            </div>
                            <div class="elo-advanced">
                                <button class="advanced-btn" id="advanced-btn">ADVANCED</button>
                            </div>
                        </div>
                        <div class="widget-actions">
                            <div class="action-btn hide" id="hide-btn">HIDE</div>
                            <div class="action-btn auto active" id="auto-btn">AUTO</div>
                            <div class="action-btn queue" id="queue-btn">QUEUE</div>
                            <div class="action-btn stealth" id="stealth-btn" title="Humanize Stealth Anti-Cheat Evasion">🥷 STEALTH</div>
                            <div class="action-btn off" id="off-btn">OFF</div>
                            <div class="action-btn eval active" id="eval-btn">EVAL</div>
                        </div>
                        <div class="titan-stealth-card" id="titan-stealth-card" style="display:none">
                            <div class="stealth-card-header">
                                <span class="stealth-badge">🥷 STEALTH ACTIVE</span>
                                <span class="stealth-caps" id="stealth-caps">Target CAPS: 85% — 91%</span>
                            </div>
                            <div class="stealth-timer-row">
                                <span class="stealth-timer-label" id="stealth-timer-label">Human Delay:</span>
                                <span class="stealth-timer-val" id="stealth-timer-val">0.0s</span>
                                <span class="stealth-timer-status" id="stealth-timer-status">WAIT</span>
                            </div>
                            <div class="stealth-progress-bar">
                                <div class="stealth-progress-fill" id="stealth-progress-fill"></div>
                            </div>
                        </div>
                    </div>
                    <!-- INFO tab: read-only status display -->
                    <div class="tab-content" data-content="info" style="display:none">
                        <div class="info-container">
                            <div class="info-section">
                                <div class="info-section-header">
                                    <div class="info-section-icon">⚙️</div>
                                    <div class="info-section-title">Engine</div>
                                </div>
                                <div class="info-section-body">
                                    <div class="info-row"><div class="info-label">ENGINE</div><div class="info-value highlight">STOCKFISH (LOCAL)</div></div>
                                    <div class="info-row"><div class="info-label">STATUS</div><div class="info-value" id="info-status"><span class="status-dot connected"></span><span class="status-text">Connected</span></div></div>
                                    <div class="info-row"><div class="info-label">CURRENT ELO</div><div class="info-value highlight" id="info-elo">1000</div></div>
                                    <div class="info-row"><div class="info-label">ELO RANGE</div><div class="info-value">1000 — 3000</div></div>
                                </div>
                            </div>
                            <div class="info-section">
                                <div class="info-section-header">
                                    <div class="info-section-icon">🎯</div>
                                    <div class="info-section-title">Display</div>
                                </div>
                                <div class="info-section-body">
                                    <div class="info-row"><div class="info-label">ARROW MODE</div><div class="info-value" id="info-arrow-mode">Arrow</div></div>
                                    <div class="info-row"><div class="info-label">ARROW COLOR</div><div class="info-value" id="info-arrow-color"><span class="color-indicator" style="background:#00f2ff;"></span><span>Cyan</span></div></div>
                                    <div class="info-row"><div class="info-label">EVAL BAR</div><div class="info-value highlight" id="info-eval-bar">—</div></div>
                                    <div class="info-row"><div class="info-label">VERSION</div><div class="info-value"><span class="info-version-badge"><span class="info-version-dot"></span>FREE v1.0</span></div></div>
                                </div>
                            </div>
                            <div class="info-section" style="background:transparent;border:none;">
                                <div class="info-upgrade-card">
                                    <div class="info-upgrade-content">
                                        <div class="info-upgrade-icon">⭐</div>
                                        <div class="info-upgrade-title">UPGRADE TO PREMIUM</div>
                                        <div class="info-upgrade-desc">ELO 2500 · Eval Bar · Titan_Chess Engines<br>Play Styles · Advanced Features</div>
                                        <div class="info-upgrade-btn" id="info-upgrade-link">VISIT STORE</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- STYLE tab: locked in free version -->
                    <div class="tab-content" data-content="style" style="display:none">
                        <div class="style-info">
                            <div class="info-text">🔒 Premium Only</div>
                            <div class="info-subtext">Play styles available in Premium version.<br>Aggressive, Defensive, Balanced & more.</div>
                        </div>
                    </div>
                    <!-- ARROW tab: mode + color selection -->
                    <div class="tab-content" data-content="arrow" style="display:none">
                        <div class="arrow-section">
                            <div class="section-label">ARROW MODE</div>
                            <div class="arrow-mode-grid">
                                <div class="arrow-mode-card" data-mode="highlight"><div class="arrow-mode-icon">🔆</div><div class="arrow-mode-title">HIGHLIGHT</div><div class="arrow-mode-desc">Square highlights</div></div>
                                <div class="arrow-mode-card active" data-mode="arrow"><div class="arrow-mode-icon">➜</div><div class="arrow-mode-title">ARROW</div><div class="arrow-mode-desc">Directional arrows</div></div>
                            </div>
                        </div>
                        <div class="arrow-section">
                            <div class="section-label">ARROW COLOR</div>
                            <div class="arrow-color-grid">
                                <div class="arrow-color-card selected" data-color="#00f2ff"><div class="arrow-color-preview" style="background:#00f2ff;"></div><div class="arrow-color-name">CYAN</div></div>
                                <div class="arrow-color-card" data-color="#00ff88"><div class="arrow-color-preview" style="background:#00ff88;"></div><div class="arrow-color-name">GREEN</div></div>
                                <div class="arrow-color-card" data-color="#ff00ff"><div class="arrow-color-preview" style="background:#ff00ff;"></div><div class="arrow-color-name">MAGENTA</div></div>
                                <div class="arrow-color-card" data-color="#ffff00"><div class="arrow-color-preview" style="background:#ffff00;"></div><div class="arrow-color-name">YELLOW</div></div>
                                <div class="arrow-color-card" data-color="#ff8800"><div class="arrow-color-preview" style="background:#ff8800;"></div><div class="arrow-color-name">ORANGE</div></div>
                            </div>
                        </div>
                    </div>
                    <!-- EVAL tab: live position evaluation + eval bar -->
                    <div class="tab-content" data-content="eval" style="display:none">
                        <div class="eval-section">
                            <div class="section-label">POSITION EVALUATION</div>
                            <div class="eval-readout">
                                <div class="eval-score" id="eval-score">+0.00</div>
                                <div class="eval-best" id="eval-best">—</div>
                            </div>
                            <div class="eval-bar">
                                <div class="eval-bar-white" id="eval-bar-white" style="width:50%"></div>
                                <div class="eval-bar-draw" id="eval-bar-draw" style="width:0%"></div>
                                <div class="eval-bar-black" id="eval-bar-black" style="width:50%"></div>
                                <div class="eval-bar-marker" id="eval-bar-marker" style="left:50%"></div>
                            </div>
                            <div class="eval-percents">
                                <span class="eval-pct eval-pct-white">White <b id="eval-pct-white">50%</b></span>
                                <span class="eval-pct eval-pct-draw">Draw <b id="eval-pct-draw">0%</b></span>
                                <span class="eval-pct eval-pct-black">Black <b id="eval-pct-black">50%</b></span>
                            </div>
                            <div class="eval-hint" id="eval-hint">Waiting for engine analysis…</div>
                            <div class="titan-coach-strip" id="titan-coach-strip" style="display:none">
                                <span class="titan-coach-icon">💡</span>
                                <span id="titan-coach-text">Waiting for tactical analysis…</span>
                            </div>
                        </div>
                        <div class="eval-section">
                            <div class="section-label">EVALUATION BAR</div>
                            <div class="eval-toggle-grid">
                                <div class="eval-toggle-card active" data-evalbar="on"><div class="eval-toggle-icon">✅</div><div class="eval-toggle-title">ON</div><div class="eval-toggle-desc">Show live eval bar</div></div>
                                <div class="eval-toggle-card" data-evalbar="off"><div class="eval-toggle-icon">🚫</div><div class="eval-toggle-title">OFF</div><div class="eval-toggle-desc">Hide eval bar</div></div>
                            </div>
                        </div>
                        <div class="eval-section">
                            <div class="section-label">MOVE WIN%</div>
                            <div class="eval-toggle-grid">
                                <div class="eval-toggle-card active" data-movepct="on"><div class="eval-toggle-icon">💯</div><div class="eval-toggle-title">ON</div><div class="eval-toggle-desc">Win% on board squares</div></div>
                                <div class="eval-toggle-card" data-movepct="off"><div class="eval-toggle-icon">🚫</div><div class="eval-toggle-title">OFF</div><div class="eval-toggle-desc">Hide square badges</div></div>
                            </div>
                        </div>
                        <div class="eval-section">
                            <div class="section-label">THEME</div>
                            <div class="theme-grid-compact">
                                <div class="theme-card active" data-theme="dark"><div class="theme-preview-compact" style="background: linear-gradient(135deg, #0a0f19 0%, #00f2ff 100%);"></div><div class="theme-name-compact">DARK</div></div>
                                <div class="theme-card" data-theme="light"><div class="theme-preview-compact" style="background: linear-gradient(135deg, #f5f5f5 0%, #00f2ff 100%);"></div><div class="theme-name-compact">LIGHT</div></div>
                                <div class="theme-card" data-theme="purple"><div class="theme-preview-compact" style="background: linear-gradient(135deg, #0a0f19 0%, #a855f7 100%);"></div><div class="theme-name-compact">PURPLE</div></div>
                                <div class="theme-card" data-theme="green"><div class="theme-preview-compact" style="background: linear-gradient(135deg, #0a0f19 0%, #10b981 100%);"></div><div class="theme-name-compact">GREEN</div></div>
                                <div class="theme-card" data-theme="orange"><div class="theme-preview-compact" style="background: linear-gradient(135deg, #0a0f19 0%, #f97316 100%);"></div><div class="theme-name-compact">ORANGE</div></div>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- bottom toolbar: quick toggles without opening tabs -->
                <div class="widget-toolbar">
                    <div class="tool-icon" data-tool="highlight" title="Highlight Mode">🔆</div>
                    <div class="tool-icon active" data-tool="arrow" title="Arrow Mode">➜</div>
                    <div class="tool-icon" data-tool="color" title="Arrow Color">🎨</div>
                    <div class="tool-icon active" data-tool="eval" title="Eval Bar">📊</div>
                    <div class="tool-icon active" data-tool="movepct" title="Move Win%">💯</div>
                    <div class="tool-icon active" data-tool="threat" title="Inovasi 1: Threat Radar">🛡️</div>
                    <div class="tool-icon" data-tool="stealth" title="Inovasi 2: Humanize Stealth">🥷</div>
                    <div class="tool-icon" data-tool="coach" title="Inovasi 3: Voice Coach">🎙️</div>
                    <div class="tool-icon active" data-tool="phantom" title="Inovasi 4: Ghost Board">👻</div>
                    <div class="tool-icon" data-tool="theme" title="Themes">🌈</div>
                    <div class="tool-icon" data-tool="settings" title="Settings">⚙️</div>
                    <div class="tool-icon" data-tool="upgrade" title="Upgrade to Premium">⭐</div>
                </div>
            </div>
            <!-- advanced settings overlay (theme + color pickers) -->
            <div class="widget-advanced" id="widget-advanced" style="display: none;">
                <div class="advanced-header">
                    <div class="advanced-title">ADVANCED SETTINGS</div>
                    <button class="advanced-close">×</button>
                </div>
                <div class="advanced-body">
                    <div class="advanced-section">
                        <div class="advanced-label">THEME</div>
                        <div class="theme-grid">
                            <div class="theme-option active" data-theme="dark"><div class="theme-preview" style="background: linear-gradient(135deg, #0a0f19 0%, #00f2ff 100%);"></div><div class="theme-name">DARK</div></div>
                            <div class="theme-option" data-theme="light"><div class="theme-preview" style="background: linear-gradient(135deg, #f5f5f5 0%, #00f2ff 100%);"></div><div class="theme-name">LIGHT</div></div>
                            <div class="theme-option" data-theme="purple"><div class="theme-preview" style="background: linear-gradient(135deg, #0a0f19 0%, #a855f7 100%);"></div><div class="theme-name">PURPLE</div></div>
                            <div class="theme-option" data-theme="green"><div class="theme-preview" style="background: linear-gradient(135deg, #0a0f19 0%, #10b981 100%);"></div><div class="theme-name">GREEN</div></div>
                            <div class="theme-option" data-theme="orange"><div class="theme-preview" style="background: linear-gradient(135deg, #0a0f19 0%, #f97316 100%);"></div><div class="theme-name">ORANGE</div></div>
                        </div>
                    </div>
                    <div class="advanced-section">
                        <div class="advanced-label">ARROW COLOR</div>
                        <div class="color-grid-advanced">
                            <div class="color-box-advanced selected" data-color="#00f2ff" style="background:#00f2ff;"></div>
                            <div class="color-box-advanced" data-color="#00ff88" style="background:#00ff88;"></div>
                            <div class="color-box-advanced" data-color="#ff00ff" style="background:#ff00ff;"></div>
                            <div class="color-box-advanced" data-color="#ffff00" style="background:#ffff00;"></div>
                            <div class="color-box-advanced" data-color="#ff8800" style="background:#ff8800;"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(widget);
        makeWidgetDraggable();
        setupWidgetEvents();
        loadWidgetSettings();
    }

    // drag-to-move: mousedown on header starts tracking,
    // mousemove updates position, mouseup stops.
    // we set right:auto so the widget doesn't fight its
    // default CSS positioning during drag.
    function makeWidgetDraggable() {
            const widget = document.getElementById('titan-widget');
            const header = widget.querySelector('.widget-header');
            let isDragging = false, startX, startY, startLeft, startTop;

            function onStart(x, y) {
                isDragging = true;
                widget.classList.add('dragging');
                const rect = widget.getBoundingClientRect();
                startX = x; startY = y;
                startLeft = rect.left; startTop = rect.top;
            }

            function onMove(x, y) {
                if (!isDragging) return;
                widget.style.left = (startLeft + x - startX) + 'px';
                widget.style.top = (startTop + y - startY) + 'px';
                widget.style.right = 'auto';
            }

            function onEnd() {
                if (isDragging) { isDragging = false; widget.classList.remove('dragging'); }
            }

            // Mouse events
            header.addEventListener('mousedown', (e) => {
                if (e.target.classList.contains('widget-minimize')) return;
                onStart(e.clientX, e.clientY);
                e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
            document.addEventListener('mouseup', onEnd);

            // Touch events (mobile)
            header.addEventListener('touchstart', (e) => {
                if (e.target.classList.contains('widget-minimize')) return;
                const touch = e.touches[0];
                onStart(touch.clientX, touch.clientY);
                e.preventDefault();
            }, { passive: false });
            document.addEventListener('touchmove', (e) => {
                if (!isDragging) return;
                const touch = e.touches[0];
                onMove(touch.clientX, touch.clientY);
                e.preventDefault();
            }, { passive: false });
            document.addEventListener('touchend', onEnd);
        }




    // wire up all interactive elements in the widget.
    // this is a big function because there are a lot of controls.
    // each section is grouped by feature area.
    function setupWidgetEvents() {
        const widget = document.getElementById('titan-widget');

        // sync the elo display (number + label) with currentEloIndex,
        // push the new value to the engine, and persist it.
        // also clears arrows because the old suggestion is now invalid.
        function updateEloDisplay() {
            const eloValue = widget.querySelector('#elo-value');
            const eloLabel = widget.querySelector('#elo-label');
            if (eloValue) eloValue.textContent = Eng.ELO_LEVELS[currentEloIndex];
            if (eloLabel) eloLabel.textContent = Eng.ELO_LABELS[currentEloIndex];
            Eng.setElo(String(Eng.ELO_LEVELS[currentEloIndex]));
            Ch.set({ elo: String(Eng.ELO_LEVELS[currentEloIndex]) });
            D.clearArrows();
            T.currentFen = '';  // force re-analysis on next poll
            updateInfoDisplay();
        }

        // elo slider: «/‹/›/» buttons navigate through levels.
        // first/last jump to min/max, prev/next step by one.
        widget.querySelectorAll('.elo-arrow').forEach(arrow => {
            arrow.addEventListener('click', function () {
                const action = this.dataset.action;
                if (action === 'first') currentEloIndex = 0;
                else if (action === 'prev') currentEloIndex = Math.max(0, currentEloIndex - 1);
                else if (action === 'next') currentEloIndex = Math.min(Eng.ELO_LEVELS.length - 1, currentEloIndex + 1);
                else if (action === 'last') currentEloIndex = Eng.ELO_LEVELS.length - 1;
                updateEloDisplay();
            });
        });

        // minimize: collapses the widget body, keeps header visible
        widget.querySelector('.widget-minimize').addEventListener('click', () => widget.classList.toggle('minimized'));

        // hide: fully hides the widget (user needs to reload page to get it back)
        const hideBtn = widget.querySelector('#hide-btn');
        if (hideBtn) hideBtn.addEventListener('click', () => widget.classList.add('hidden'));

        // auto mode toggle: when active, engine analyzes automatically
        const autoBtn = widget.querySelector('#auto-btn');
        if (autoBtn) autoBtn.addEventListener('click', function () {
            this.classList.toggle('active');
            showStatusNotification(this.classList.contains('active') ? 'AUTO: ON' : 'AUTO: OFF');
        });

        // mode switching: account / combat / threat
        // these are mutually exclusive — clicking one deactivates the others.
        // combat mode uses COMBAT_CONFIG (higher depth/skill).
        // threat mode is a placeholder in free version.
        // account mode is the default (normal elo-limited play).
        widget.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const mode = this.classList.contains('combat') ? 'combat' :
                             this.classList.contains('threat') ? 'threat' : 'account';
                widget.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                T.currentMode = mode;
                T.combatMode = (mode === 'combat');
                if (T.combatMode) {
                    Eng.applyCombatConfig();
                    showStatusNotification('COMBAT MODE: ON');
                } else if (mode === 'threat') {
                    T.threatRadarOn = true;
                    const threatTool = widget.querySelector('.tool-icon[data-tool="threat"]');
                    if (threatTool) threatTool.classList.add('active');
                    showStatusNotification('THREAT MODE: RADAR ON');
                } else {
                    Eng.setElo(T.currentElo);
                    showStatusNotification('ACCOUNT MODE');
                }
                D.clearArrows();
                T.currentFen = '';
                Ch.set({ engineMode: mode });
            });
        });

        // queue toggle: pre-analyze during opponent's turn.
        // stores moves in T.moveQueue for display.
        const queueBtn = widget.querySelector('#queue-btn');
        if (queueBtn) queueBtn.addEventListener('click', function () {
            T.queueMode = !T.queueMode;
            this.classList.toggle('active', T.queueMode);
            T.moveQueue = [];
            updateQueueDisplay();
            showStatusNotification(T.queueMode ? 'QUEUE: ON' : 'QUEUE: OFF');
            Ch.set({ queueMode: T.queueMode });
        });

        // STEALTH mode toggle: Humanize Anti-Cheat Evasion
        function syncStealthUI() {
            const btn = widget.querySelector('#stealth-btn');
            if (btn) btn.classList.toggle('active', !!T.stealthOn);
            const tool = widget.querySelector('.tool-icon[data-tool="stealth"]');
            if (tool) tool.classList.toggle('active', !!T.stealthOn);

            const card = widget.querySelector('#titan-stealth-card');
            if (card) {
                card.style.display = T.stealthOn ? 'block' : 'none';
                const capsEl = widget.querySelector('#stealth-caps');
                if (capsEl && window.TitanStealth) {
                    capsEl.textContent = `Target CAPS: ${window.TitanStealth.getTargetCaps(T.currentElo)}`;
                }
            }

            if (!T.stealthOn) {
                if (window.TitanStealth) window.TitanStealth.stopMoveDelay();
                if (D.clearStealthPill) D.clearStealthPill();
            }
        }

        const stealthBtn = widget.querySelector('#stealth-btn');
        if (stealthBtn) stealthBtn.addEventListener('click', function () {
            T.stealthOn = !T.stealthOn;
            syncStealthUI();
            showStatusNotification(T.stealthOn ? 'STEALTH MODE: ON' : 'STEALTH MODE: OFF');
            Ch.set({ stealthOn: T.stealthOn });
        });

        // OFF switch: toggles the ARROW/move-prediction feature only.
        // when OFF, arrows and move% badges are cleared and the engine
        // stops drawing them — but the eval bar keeps working if its
        // own EVAL switch is on. the two features are independent.
        const offBtn = widget.querySelector('#off-btn');
        if (offBtn) offBtn.addEventListener('click', function () {
            T.engineOn = !T.engineOn;
            this.classList.toggle('active', !T.engineOn);
            this.textContent = T.engineOn ? 'OFF' : 'ON';
            if (!T.engineOn) {
                // clear arrow/badge overlays only — leave eval bar alone
                T.arrows = [];
                T.pendingArrows = [];
                T.topMoves = [];
                T.moveQueue = [];
                D.clearArrows();
                if (D.clearMovePct) D.clearMovePct();
                // if the eval bar is also off, nothing needs the engine
                if (!T.evalBarOn && Eng && Eng.stopAnalysis) Eng.stopAnalysis();
                updateQueueDisplay();
                showStatusNotification('ARROWS: OFF');
            } else {
                showStatusNotification('ARROWS: ON');
                // re-trigger analysis on next monitor tick
                T.currentFen = '';
            }
            Ch.set({ engineOn: T.engineOn });
        });

        // single helper that keeps every eval-bar control in sync:
        // the EVAL action button, the widget strip, the floating board
        // bar below the board, the tool icon, and the toggle cards.
        function syncEvalBarUI() {
            const evBtn = widget.querySelector('#eval-btn');
            if (evBtn) {
                evBtn.classList.toggle('active', T.evalBarOn);
                evBtn.textContent = T.evalBarOn ? 'EVAL' : 'EVAL';
            }
            const strip = widget.querySelector('#widget-eval-strip');
            if (strip) strip.style.display = T.evalBarOn ? 'block' : 'none';
            if (D.setBoardEval) D.setBoardEval(T.evalBarOn);
            const toolIcon = widget.querySelector('.widget-icon[data-icon="eval"]');
            if (toolIcon) toolIcon.classList.toggle('active', T.evalBarOn);
            widget.querySelectorAll('.eval-toggle-card[data-evalbar]').forEach(card => {
                card.classList.toggle('active', card.dataset.evalbar === (T.evalBarOn ? 'on' : 'off'));
            });
        }

        // EVAL action button — dedicated on/off for the eval bar below
        // the board. separate from the arrow/move-prediction feature.
        const evalBtn = widget.querySelector('#eval-btn');
        if (evalBtn) evalBtn.addEventListener('click', function () {
            T.evalBarOn = !T.evalBarOn;
            syncEvalBarUI();
            Ch.set({ evalBarOn: T.evalBarOn });
            showStatusNotification(T.evalBarOn ? 'EVAL BAR: ON' : 'EVAL BAR: OFF');
            updateInfoDisplay();
            if (T.evalBarOn) {
                // turning eval ON: make sure the engine is running and
                // re-trigger analysis so the bar refreshes immediately.
                T.currentFen = '';
                if (D.setBoardEval) D.setBoardEval(true);
            } else if (!T.engineOn && Eng && Eng.stopAnalysis) {
                // both features off → stop the engine entirely
                Eng.stopAnalysis();
            }
        });

        // tab switching (text tabs at top).
        // we toggle both classList AND style.display because
        // chess.com's CSS can override one layer but not both.
        widget.querySelectorAll('.widget-tab').forEach(tab => {
            tab.addEventListener('click', function () {
                const tabName = this.dataset.tab;
                widget.querySelectorAll('.widget-tab').forEach(t => t.classList.remove('active'));
                this.classList.add('active');
                widget.querySelectorAll('.widget-icon').forEach(i => { i.classList.remove('active'); if (i.dataset.icon === tabName) i.classList.add('active'); });
                widget.querySelectorAll('.tab-content').forEach(c => { c.classList.remove('active'); c.style.display = 'none'; if (c.dataset.content === tabName) { c.classList.add('active'); c.style.display = 'block'; } });
            });
        });

        // icon switching (emoji row below tabs) — same logic as tabs
        widget.querySelectorAll('.widget-icon[data-icon]').forEach(icon => {
            icon.addEventListener('click', function () {
                const iconName = this.dataset.icon;
                widget.querySelectorAll('.widget-icon').forEach(i => i.classList.remove('active'));
                this.classList.add('active');
                widget.querySelectorAll('.widget-tab').forEach(t => { t.classList.remove('active'); if (t.dataset.tab === iconName) t.classList.add('active'); });
                widget.querySelectorAll('.tab-content').forEach(c => { c.classList.remove('active'); c.style.display = 'none'; if (c.dataset.content === iconName) { c.classList.add('active'); c.style.display = 'block'; } });
            });
        });

        // bottom toolbar: quick actions without switching tabs.
        // highlight/arrow toggle the draw mode.
        // color cycles through the 5 preset colors.
        // theme/settings open the advanced panel.
        // upgrade opens the store in a new tab.
        widget.querySelectorAll('.tool-icon[data-tool]').forEach(icon => {
            icon.addEventListener('click', function () {
                const tool = this.dataset.tool;
                if (tool === 'highlight' || tool === 'arrow') {
                    widget.querySelectorAll('.tool-icon[data-tool="highlight"], .tool-icon[data-tool="arrow"]').forEach(i => i.classList.remove('active'));
                    this.classList.add('active');
                    T.arrowMode = tool === 'arrow' ? 'arrow' : 'highlight';
                    Ch.set({ arrowMode: T.arrowMode });
                    showStatusNotification(`ARROW MODE: ${T.arrowMode.toUpperCase()}`);
                    if (T.arrows.length) D.draw(true);
                    updateInfoDisplay();
                } else if (tool === 'eval') {
                    // toggle the persistent eval bar on/off
                    T.evalBarOn = !T.evalBarOn;
                    syncEvalBarUI();
                    Ch.set({ evalBarOn: T.evalBarOn });
                    showStatusNotification(T.evalBarOn ? 'EVAL BAR: ON' : 'EVAL BAR: OFF');
                } else if (tool === 'movepct') {
                    // toggle move% badges on/off
                    T.movePctOn = !T.movePctOn;
                    this.classList.toggle('active', T.movePctOn);
                    // sync toggle cards
                    widget.querySelectorAll('.eval-toggle-card[data-movepct]').forEach(card => {
                        card.classList.toggle('active', card.dataset.movepct === (T.movePctOn ? 'on' : 'off'));
                    });
                    Ch.set({ movePctOn: T.movePctOn });
                    // redraw badges immediately if any exist
                    if (D.drawMovePct && T.topMoves.length) D.drawMovePct();
                    showStatusNotification(T.movePctOn ? 'MOVE WIN%: ON' : 'MOVE WIN%: OFF');
                } else if (tool === 'threat') {
                    T.threatRadarOn = !T.threatRadarOn;
                    this.classList.toggle('active', T.threatRadarOn);
                    showStatusNotification(T.threatRadarOn ? 'THREAT RADAR: ON' : 'THREAT RADAR: OFF');
                    if (!T.threatRadarOn && D.clearThreats) D.clearThreats();
                } else if (tool === 'stealth') {
                    T.stealthOn = !T.stealthOn;
                    syncStealthUI();
                    showStatusNotification(T.stealthOn ? 'STEALTH MODE: ON' : 'STEALTH MODE: OFF');
                    Ch.set({ stealthOn: T.stealthOn });
                } else if (tool === 'coach') {
                    T.voiceCoachOn = !T.voiceCoachOn;
                    this.classList.toggle('active', T.voiceCoachOn);
                    if (window.TitanCoach) window.TitanCoach.setVoiceCoach(T.voiceCoachOn);
                    showStatusNotification(T.voiceCoachOn ? 'VOICE COACH: ON' : 'VOICE COACH: OFF');
                } else if (tool === 'phantom') {
                    T.phantomOn = !T.phantomOn;
                    this.classList.toggle('active', T.phantomOn);
                    showStatusNotification(T.phantomOn ? 'GHOST BOARD: ON' : 'GHOST BOARD: OFF');
                    if (!T.phantomOn && window.TitanPhantom) window.TitanPhantom.clearPhantom();
                } else if (tool === 'color') {
                    // cycle through colors on each click
                    const colors = ['#00f2ff', '#00ff88', '#ff00ff', '#ffff00', '#ff8800'];
                    const names = ['CYAN', 'GREEN', 'MAGENTA', 'YELLOW', 'ORANGE'];
                    const idx = colors.indexOf(T.arrowColor);
                    const next = (idx + 1) % colors.length;
                    T.arrowColor = colors[next];
                    Ch.set({ arrowColor: T.arrowColor });
                    showStatusNotification(`ARROW COLOR: ${names[next]}`);
                    if (T.arrows.length) D.draw(true);
                    updateInfoDisplay();
                } else if (tool === 'theme' || tool === 'settings') {
                    const panel = widget.querySelector('#widget-advanced');
                    if (panel) panel.style.display = 'block';
                } else if (tool === 'upgrade') {
                    window.open('https://titanchess.online', '_blank');
                }
            });
        });

        // advanced panel open/close
        const advClose = widget.querySelector('.advanced-close');
        if (advClose) advClose.addEventListener('click', () => widget.querySelector('#widget-advanced').style.display = 'none');
        const advBtn = widget.querySelector('#advanced-btn');
        if (advBtn) advBtn.addEventListener('click', () => widget.querySelector('#widget-advanced').style.display = 'block');

        // theme selection from advanced panel.
        // syncs with the compact theme cards in the eval tab too.
        widget.querySelectorAll('.theme-option').forEach(opt => {
            opt.addEventListener('click', function () {
                widget.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active'));
                this.classList.add('active');
                const theme = this.dataset.theme;
                Ch.set({ theme });
                applyTheme(theme);
                // keep compact cards in sync
                widget.querySelectorAll('.theme-card').forEach(c => { c.classList.remove('active'); if (c.dataset.theme === theme) c.classList.add('active'); });
                showStatusNotification(`THEME: ${theme.toUpperCase()}`);
            });
        });

        // theme selection from compact cards (eval tab).
        // syncs with the advanced panel theme options.
        widget.querySelectorAll('.theme-card').forEach(card => {
            card.addEventListener('click', function () {
                const theme = this.dataset.theme;
                widget.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
                this.classList.add('active');
                widget.querySelectorAll('.theme-option').forEach(o => { o.classList.remove('active'); if (o.dataset.theme === theme) o.classList.add('active'); });
                Ch.set({ theme });
                applyTheme(theme);
                showStatusNotification(`THEME: ${theme.toUpperCase()}`);
            });
        });

        // arrow color from advanced panel
        widget.querySelectorAll('.color-box-advanced').forEach(box => {
            box.addEventListener('click', function () {
                T.arrowColor = this.dataset.color;
                widget.querySelectorAll('.color-box-advanced').forEach(b => b.classList.remove('selected'));
                this.classList.add('selected');
                Ch.set({ arrowColor: T.arrowColor });
                if (T.arrows.length) D.draw(true);
                updateInfoDisplay();
            });
        });

        // arrow mode cards (arrow tab)
        widget.querySelectorAll('.arrow-mode-card').forEach(card => {
            card.addEventListener('click', function () {
                T.arrowMode = this.dataset.mode;
                widget.querySelectorAll('.arrow-mode-card').forEach(c => c.classList.remove('active'));
                this.classList.add('active');
                // sync toolbar icons
                widget.querySelectorAll('.tool-icon[data-tool="highlight"], .tool-icon[data-tool="arrow"]').forEach(i => i.classList.remove('active'));
                const toolIcon = widget.querySelector(`.tool-icon[data-tool="${T.arrowMode}"]`);
                if (toolIcon) toolIcon.classList.add('active');
                Ch.set({ arrowMode: T.arrowMode });
                showStatusNotification(`ARROW MODE: ${T.arrowMode.toUpperCase()}`);
                if (T.arrows.length) D.draw(true);
                updateInfoDisplay();
            });
        });

        // arrow color cards (arrow tab).
        // syncs with the advanced panel color boxes.
        widget.querySelectorAll('.arrow-color-card').forEach(card => {
            card.addEventListener('click', function () {
                T.arrowColor = this.dataset.color;
                widget.querySelectorAll('.arrow-color-card').forEach(c => c.classList.remove('selected'));
                this.classList.add('selected');
                // sync advanced panel
                widget.querySelectorAll('.color-box-advanced').forEach(b => b.classList.remove('selected'));
                const advBox = widget.querySelector(`.color-box-advanced[data-color="${T.arrowColor}"]`);
                if (advBox) advBox.classList.add('selected');
                Ch.set({ arrowColor: T.arrowColor });
                const names = { '#00f2ff': 'CYAN', '#00ff88': 'GREEN', '#ff00ff': 'MAGENTA', '#ffff00': 'YELLOW', '#ff8800': 'ORANGE' };
                showStatusNotification(`ARROW COLOR: ${names[T.arrowColor] || 'CUSTOM'}`);
                if (T.arrows.length) D.draw(true);
                updateInfoDisplay();
            });
        });

        // eval toggle cards — turn the persistent eval bar on/off
        widget.querySelectorAll('.eval-toggle-card[data-evalbar]').forEach(card => {
            card.addEventListener('click', function () {
                T.evalBarOn = this.dataset.evalbar === 'on';
                widget.querySelectorAll('.eval-toggle-card[data-evalbar]').forEach(c => c.classList.remove('active'));
                this.classList.add('active');
                const strip = widget.querySelector('#widget-eval-strip');
                if (strip) strip.style.display = T.evalBarOn ? 'block' : 'none';
                if (D.setBoardEval) D.setBoardEval(T.evalBarOn);
                const toolIcon = widget.querySelector('.tool-icon[data-tool="eval"]');
                if (toolIcon) toolIcon.classList.toggle('active', T.evalBarOn);
                Ch.set({ evalBarOn: T.evalBarOn });
                showStatusNotification(T.evalBarOn ? 'EVAL BAR: ON' : 'EVAL BAR: OFF');
                updateInfoDisplay();
            });
        });

        // move win% toggle cards — turn square badges on/off
        widget.querySelectorAll('.eval-toggle-card[data-movepct]').forEach(card => {
            card.addEventListener('click', function () {
                T.movePctOn = this.dataset.movepct === 'on';
                widget.querySelectorAll('.eval-toggle-card[data-movepct]').forEach(c => c.classList.remove('active'));
                this.classList.add('active');
                const toolIcon = widget.querySelector('.tool-icon[data-tool="movepct"]');
                if (toolIcon) toolIcon.classList.toggle('active', T.movePctOn);
                Ch.set({ movePctOn: T.movePctOn });
                if (D.drawMovePct && T.topMoves.length) D.drawMovePct();
                showStatusNotification(T.movePctOn ? 'MOVE WIN%: ON' : 'MOVE WIN%: OFF');
                updateInfoDisplay();
            });
        });

        // upgrade link in info tab
        const upgradeLink = widget.querySelector('#info-upgrade-link');
        if (upgradeLink) upgradeLink.addEventListener('click', () => window.open('https://titanchess.online', '_blank'));
    }

    // restore saved preferences from chrome.storage.
    // runs once after widget creation. if you add a new
    // persisted setting, load it here and apply it to the UI.
    function loadWidgetSettings() {
        Ch.get(['elo', 'arrowMode', 'arrowColor', 'theme', 'engineMode', 'queueMode', 'evalBarOn', 'movePctOn', 'engineOn'], (result) => {
            const widget = document.getElementById('titan-widget');
            if (!widget) return;

            // restore master power switch (default: on)
            T.engineOn = result.engineOn !== false;
            const offBtn = widget.querySelector('#off-btn');
            if (offBtn) {
                offBtn.classList.toggle('active', !T.engineOn);
                offBtn.textContent = T.engineOn ? 'OFF' : 'ON';
            }

            // restore elo level
            if (result.elo) {
                const idx = Eng.ELO_LEVELS.indexOf(parseInt(result.elo));
                if (idx !== -1) {
                    currentEloIndex = idx;
                    const v = widget.querySelector('#elo-value'), l = widget.querySelector('#elo-label');
                    if (v) v.textContent = Eng.ELO_LEVELS[idx];
                    if (l) l.textContent = Eng.ELO_LABELS[idx];
                }
            }

            // restore arrow mode (arrow or highlight)
            if (result.arrowMode) {
                T.arrowMode = result.arrowMode;
                widget.querySelectorAll('.tool-icon[data-tool="highlight"], .tool-icon[data-tool="arrow"]').forEach(i => i.classList.remove('active'));
                const toolIcon = widget.querySelector(`.tool-icon[data-tool="${result.arrowMode}"]`);
                if (toolIcon) toolIcon.classList.add('active');
                const modeCard = widget.querySelector(`.arrow-mode-card[data-mode="${result.arrowMode}"]`);
                if (modeCard) { widget.querySelectorAll('.arrow-mode-card').forEach(c => c.classList.remove('active')); modeCard.classList.add('active'); }
            }

            // restore arrow color
            if (result.arrowColor) {
                T.arrowColor = result.arrowColor;
                const colorBox = widget.querySelector(`.color-box-advanced[data-color="${result.arrowColor}"]`);
                if (colorBox) { widget.querySelectorAll('.color-box-advanced').forEach(b => b.classList.remove('selected')); colorBox.classList.add('selected'); }
                const colorCard = widget.querySelector(`.arrow-color-card[data-color="${result.arrowColor}"]`);
                if (colorCard) { widget.querySelectorAll('.arrow-color-card').forEach(c => c.classList.remove('selected')); colorCard.classList.add('selected'); }
            }

            // restore engine mode (account / combat / threat)
            if (result.engineMode) {
                T.currentMode = result.engineMode;
                T.combatMode = (result.engineMode === 'combat');
                widget.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                const modeBtn = widget.querySelector(`.mode-btn.${result.engineMode}`);
                if (modeBtn) modeBtn.classList.add('active');
                if (T.combatMode && T.engineReady) Eng.applyCombatConfig();
            }

            // restore queue mode
            if (result.queueMode) {
                T.queueMode = result.queueMode;
                const qBtn = widget.querySelector('#queue-btn');
                if (qBtn) qBtn.classList.toggle('active', T.queueMode);
                updateQueueDisplay();
            }

            // restore eval bar visibility (default: on)
            T.evalBarOn = result.evalBarOn !== false;
            const evalStrip = widget.querySelector('#widget-eval-strip');
            if (evalStrip) evalStrip.style.display = T.evalBarOn ? 'block' : 'none';
            if (D.setBoardEval) D.setBoardEval(T.evalBarOn);
            const evalBtnRestore = widget.querySelector('#eval-btn');
            if (evalBtnRestore) evalBtnRestore.classList.toggle('active', T.evalBarOn);
            const evalToolIcon = widget.querySelector('.tool-icon[data-tool="eval"]');
            if (evalToolIcon) evalToolIcon.classList.toggle('active', T.evalBarOn);
            widget.querySelectorAll('.eval-toggle-card[data-evalbar]').forEach(card => {
                card.classList.toggle('active', card.dataset.evalbar === (T.evalBarOn ? 'on' : 'off'));
            });

            // restore move win% badge visibility (default: on)
            T.movePctOn = result.movePctOn !== false;
            const movePctToolIcon = widget.querySelector('.tool-icon[data-tool="movepct"]');
            if (movePctToolIcon) movePctToolIcon.classList.toggle('active', T.movePctOn);
            widget.querySelectorAll('.eval-toggle-card[data-movepct]').forEach(card => {
                card.classList.toggle('active', card.dataset.movepct === (T.movePctOn ? 'on' : 'off'));
            });

            // restore theme (default: dark)
            const theme = result.theme || 'dark';
            applyTheme(theme);
            const themeOpt = widget.querySelector(`.theme-option[data-theme="${theme}"]`);
            if (themeOpt) { widget.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active')); themeOpt.classList.add('active'); }
            const themeCard = widget.querySelector(`.theme-card[data-theme="${theme}"]`);
            if (themeCard) { widget.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active')); themeCard.classList.add('active'); }

            updateInfoDisplay();
            // render the board eval bar once so it shows the waiting
            // state immediately (before the first engine info line) —
            // the evalBarOn guard inside renderBoardEval hides it if off.
            if (D.renderBoardEval) D.renderBoardEval({ white: 50, draw: 0, black: 50 }, '—', false);
        });
    }

    // update the status dot (green = connected, red = disconnected).
    // called by engine.js when stockfish sends 'uciok' or errors out.
    function updateStatus(connected) {
        const widget = document.getElementById('titan-widget');
        if (!widget) return;
        const dot = widget.querySelector('#widget-status-dot');
        if (dot) dot.classList.toggle('connected', connected);
        const statusDot = widget.querySelector('#info-status .status-dot');
        const statusText = widget.querySelector('#info-status .status-text');
        if (statusDot) statusDot.classList.toggle('connected', connected);
        if (statusText) statusText.textContent = connected ? 'Connected' : 'Disconnected';
    }

    // context gate indicator: on live-game (denied) pages the widget
    // shows a clear BLOCKED status so the user understands why no
    // analysis is happening. called from the monitor loop on state
    // transitions only (not every tick).
    function setContextBlocked(blocked) {
        const widget = document.getElementById('titan-widget');
        if (!widget) return;
        const dot = widget.querySelector('#widget-status-dot');
        const statusDot = widget.querySelector('#info-status .status-dot');
        const statusText = widget.querySelector('#info-status .status-text');
        if (blocked) {
            if (dot) dot.classList.remove('connected');
            if (statusDot) statusDot.classList.remove('connected');
            if (statusText) statusText.textContent = 'Inactive — non-game page';
        } else {
            // restore normal status (engine may still be initializing)
            updateStatus(!!window.TitanState.engineReady);
        }
    }

    // toast notification that appears briefly at the top of the page.
    // auto-removes after 2 seconds. only one visible at a time.
    function showStatusNotification(text) {
        const existing = document.querySelector('.status-notification');
        if (existing) existing.remove();
        const el = document.createElement('div');
        el.className = 'status-notification';
        el.innerHTML = `<div class="status-notification-text">${text}</div>`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2000);
    }

    // refresh the INFO tab with current values.
    // called after any setting change so the info tab stays accurate.
    function updateInfoDisplay() {
        const widget = document.getElementById('titan-widget');
        if (!widget) return;
        const infoElo = widget.querySelector('#info-elo');
        if (infoElo) infoElo.textContent = Eng.ELO_LEVELS[currentEloIndex];
        const infoMode = widget.querySelector('#info-arrow-mode');
        if (infoMode) infoMode.textContent = T.arrowMode === 'arrow' ? 'Arrow' : 'Highlight';
        const infoColor = widget.querySelector('#info-arrow-color');
        if (infoColor) {
            const names = { '#00f2ff': 'Cyan', '#00ff88': 'Green', '#ff00ff': 'Magenta', '#ffff00': 'Yellow', '#ff8800': 'Orange' };
            infoColor.innerHTML = `<span class="color-indicator" style="background:${T.arrowColor};"></span><span>${names[T.arrowColor] || 'Custom'}</span>`;
        }
        const infoEval = widget.querySelector('#info-eval-bar');
        if (infoEval) infoEval.textContent = T.evalBarOn ? `ON · ${T.evalMate !== null ? 'M' + Math.abs(T.evalMate) : (T.evalCp != null ? (T.evalCp / 100).toFixed(2) : '—')}` : 'OFF';
    }

    // update the queue button text to show move count
    function updateQueueDisplay() {
        const widget = document.getElementById('titan-widget');
        if (!widget) return;
        const queueBtn = widget.querySelector('#queue-btn');
        if (queueBtn) queueBtn.textContent = T.queueMode ? `QUEUE (${T.moveQueue.length})` : 'QUEUE';
    }

    // convert a centipawn score (from White's perspective) into
    // win/draw/loss probabilities. this uses the standard lichess-style
    // logistic model:  win% + draw% + loss% always sums to 100.
    // a draw is most likely at 0.00 and shrinks as the eval diverges.
    function wdlFromCentiPawns(cp) {
        // "winning chances" in [-1, 1] — lichess logistic curve
        const winningChances = 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
        // draw rate: peaks (~30%) at equality, decays with |cp|
        const draw = 0.30 * Math.exp(-Math.pow(cp / 300, 2));
        const white = (0.5 + 0.5 * winningChances) * (1 - draw);
        const black = (0.5 - 0.5 * winningChances) * (1 - draw);
        return {
            white: Math.round(white * 100),
            draw: Math.round(draw * 100),
            black: Math.round(black * 100)
        };
    }

    // render the live evaluation into the EVAL tab and the persistent
    // strip. called by engine.js every time stockfish reports a score.
    function updateEvalDisplay() {
        const widget = document.getElementById('titan-widget');
        if (!widget) return;

        let wdl, scoreText, barPct;
        // CONTEXT GATE: in denied contexts (live human games etc.) never
        // display real engine eval — render the neutral waiting state.
        const ctxBlocked = window.TitanContext && !window.TitanContext.isAllowed();
        const hasEval = !ctxBlocked && (T.evalCp !== null || T.evalMate !== null);

        if (!hasEval) {
            wdl = { white: 50, draw: 0, black: 50 };
            scoreText = '—';
            barPct = 50;
        } else if (T.evalMate !== null) {
            // forced mate: near-certain win for the mating side
            const whiteMate = T.evalMate > 0;
            wdl = whiteMate ? { white: 99, draw: 1, black: 0 } : { white: 0, draw: 1, black: 99 };
            scoreText = (T.evalMate > 0 ? 'M' + T.evalMate : 'M' + T.evalMate);
            barPct = whiteMate ? 99 : 1;
        } else {
            wdl = wdlFromCentiPawns(T.evalCp);
            scoreText = (T.evalCp > 0 ? '+' : '') + (T.evalCp / 100).toFixed(2);
            barPct = Math.max(0, Math.min(100, 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * T.evalCp)) - 1)));
        }

        const applyToBar = (whiteEl, drawEl, blackEl, markerEl) => {
            if (whiteEl) whiteEl.style.width = wdl.white + '%';
            if (drawEl) drawEl.style.width = wdl.draw + '%';
            if (blackEl) blackEl.style.width = wdl.black + '%';
            if (markerEl) markerEl.style.left = barPct + '%';
        };

        // full EVAL tab
        const scoreEl = widget.querySelector('#eval-score');
        if (scoreEl) scoreEl.textContent = scoreText;
        const bestEl = widget.querySelector('#eval-best');
        if (bestEl) bestEl.textContent = (!ctxBlocked && T.evalDepth !== null) ? (typeof T.evalDepth === 'number' ? `Depth ${T.evalDepth}` : String(T.evalDepth)) : '—';
        applyToBar(
            widget.querySelector('#eval-bar-white'),
            widget.querySelector('#eval-bar-draw'),
            widget.querySelector('#eval-bar-black'),
            widget.querySelector('#eval-bar-marker')
        );
        const pW = widget.querySelector('#eval-pct-white');
        const pD = widget.querySelector('#eval-pct-draw');
        const pB = widget.querySelector('#eval-pct-black');
        if (pW) pW.textContent = wdl.white + '%';
        if (pD) pD.textContent = wdl.draw + '%';
        if (pB) pB.textContent = wdl.black + '%';
        const hintEl = widget.querySelector('#eval-hint');
        if (hintEl) hintEl.textContent = ctxBlocked
            ? 'Engine inactive on this page'
            : (hasEval
                ? (T.evalMate !== null ? 'Forced mate detected' : 'Live engine evaluation')
                : 'Waiting for engine analysis…');

        // persistent strip (shown whenever evalBarOn is true)
        applyToBar(
            widget.querySelector('#eval-strip-white'),
            widget.querySelector('#eval-strip-draw'),
            widget.querySelector('#eval-strip-black'),
            widget.querySelector('#eval-strip-marker')
        );
        const sW = widget.querySelector('#eval-strip-pct-white');
        const sD = widget.querySelector('#eval-strip-pct-draw');
        const sB = widget.querySelector('#eval-strip-pct-black');
        if (sW) sW.textContent = wdl.white + '%';
        if (sD) sD.textContent = wdl.draw + '%';
        if (sB) sB.textContent = wdl.black + '%';

        // info tab eval row
        const infoEval = widget.querySelector('#info-eval-bar');
        if (infoEval) infoEval.textContent = T.evalBarOn ? `ON · ${scoreText}` : 'OFF';

        // board eval bar (W/D/L overlay on the board itself)
        if (D.renderBoardEval) D.renderBoardEval(wdl, scoreText, hasEval);
    }

    function updateCoachText(text) {
        const widget = document.getElementById('titan-widget');
        if (!widget) return;
        const strip = widget.querySelector('#titan-coach-strip');
        const textEl = widget.querySelector('#titan-coach-text');
        if (textEl && text) {
            textEl.textContent = text;
            if (strip) strip.style.display = 'flex';
        }
    }

    function updateStealthTimer(remainingMs, totalMs, pct, isReady) {
        const widget = document.getElementById('titan-widget');
        if (!widget) return;
        const valEl = widget.querySelector('#stealth-timer-val');
        const statusEl = widget.querySelector('#stealth-timer-status');
        const fillEl = widget.querySelector('#stealth-progress-fill');

        if (isReady || remainingMs <= 0) {
            if (valEl) valEl.textContent = '0.0s';
            if (statusEl) {
                statusEl.textContent = 'READY TO MOVE';
                statusEl.className = 'stealth-timer-status ready';
            }
            if (fillEl) fillEl.style.width = '100%';
        } else {
            const sec = (remainingMs / 1000).toFixed(1);
            if (valEl) valEl.textContent = `${sec}s`;
            if (statusEl) {
                statusEl.textContent = 'THINKING';
                statusEl.className = 'stealth-timer-status';
            }
            if (fillEl) fillEl.style.width = `${pct}%`;
        }
    }

    // public API — other modules call these to update the widget
    window.TitanWidget = {
        createFloatingWidget, updateStatus, showStatusNotification,
        updateInfoDisplay, updateQueueDisplay, updateEvalDisplay, setContextBlocked,
        updateCoachText, updateStealthTimer
    };
})();
