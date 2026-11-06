// ============================================================
// bench :: run-benchmark.js — Stockfish WASM benchmark harness
// ============================================================

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const fs = require('fs');

// --- args -----------------------------------------------------
const args = process.argv.slice(2);
function argVal(flag, def) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
}
const MOVETIME = Number(argVal('--movetime', 1000));
const DEPTH    = argVal('--depth', null);
const POS_SEL  = argVal('--positions', null);
const JSON_OUT = argVal('--json', null);
const PER_POS_TIMEOUT_MS = Number(argVal('--timeout', 30000));

// --- positions (same as before) -------------------------------
const POSITIONS = [
    { id: 1, name: 'opening',   fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
    { id: 2, name: 'middlegame',fen: 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2N1PN2/PP3PPP/R1BQKB1R w KQ - 0 7' },
    { id: 3, name: 'tactics',   fen: '2rq1rk1/pp1bppbp/3p1np1/8/3NP3/1BN1BP2/PPPQ2PP/R2K3R w - - 0 11' },
    { id: 4, name: 'endgame',   fen: '8/8/8/4k3/8/4K3/4P3/8 w - - 0 1' },
    { id: 5, name: 'queens',    fen: '4r1k1/1p3ppp/pq2p3/8/3B4/2P1Q3/PP3PPP/R3K3 w - - 0 20' },
];

// --- helper formatting ----------------------------------------
function fmt(n) {
    if (n == null || isNaN(n)) return '     n/a';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' G';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' k';
    return String(n);
}

function goCmd() {
    return DEPTH ? `go depth ${DEPTH}` : `go movetime ${MOVETIME}`;
}

// --- main session ---------------------------------------------
function runSession() {
    return new Promise((resolve, reject) => {
        const bridgePath = path.join(__dirname, 'engine-bridge.js');
        const child = spawn('node', [bridgePath], { stdio: ['pipe', 'pipe', 'pipe'] });

        const rl = readline.createInterface({ input: child.stdout });
        let stderrBuf = '';
        child.stderr.on('data', d => { stderrBuf += d.toString(); });
        child.on('error', err => reject(new Error(`spawn failed: ${err.message}`)));

        let bootMs = null;
        const results = [];
        let currentPos = null;
        let posIdx = 0;
        let quitSent = false;
        let startTime = Date.now();

        // Start engine
        child.stdin.write('uci\nisready\n');

        function send(cmd) { child.stdin.write(cmd + '\n'); }

        function startPosition(pos) {
            currentPos = {
                id: pos.id, name: pos.name, tStart: Date.now(),
                maxDepth: 0, nodes: null, nps: null, time: null, scoreCp: null, bestmove: null, pv: '', error: null
            };
            setTimeout(() => {
                if (currentPos && !currentPos.bestmove && !currentPos.error) {
                    currentPos.error = `timeout ${PER_POS_TIMEOUT_MS}ms`;
                    finishPosition();
                }
            }, PER_POS_TIMEOUT_MS);
            send(`position fen ${pos.fen}`);
            send(goCmd());
        }

        function finishPosition() {
            if (!currentPos) return;
            if (!currentPos.bestmove && !currentPos.error) {
                currentPos.error = 'no response';
            }
            if (currentPos.time == null) currentPos.time = currentPos.tStart ? Date.now() - currentPos.tStart : null;
            if (!currentPos.wallMs) currentPos.wallMs = Date.now() - currentPos.tStart;
            results.push(currentPos);
            currentPos = null;
            nextPosition();
        }

        function nextPosition() {
            if (posIdx < POSITIONS.length) {
                startPosition(POSITIONS[posIdx++]);
            } else if (!quitSent) {
                quitSent = true;
                send('quit');
                // Exit grace period after quit command
                setTimeout(() => resolve({ bootMs, results, stderr: stderrBuf, exitCode: child.exitCode ?? 0 }), 2000);
            }
        }

        rl.on('line', line => {
            const s = line.trim();

            if (s === 'uciok') {
                bootMs = Date.now() - startTime;
                nextPosition();               // Start position #1
                return;
            }

            if (!currentPos) return;      // Waiting for first position

            // Parse info lines (progress updates)
            if (s.startsWith('info ')) {
                let depth = null, nodes = null, nps = null, time = null, scoreCp = null;
                const toks = s.split(' ');
                for (let i = 1; i < toks.length; i++) {
                    if (toks[i] === 'depth')   depth = Number(toks[++i]);
                    else if (toks[i] === 'nodes') nodes = Number(toks[++i]);
                    else if (toks[i] === 'nps')   nps = Number(toks[++i]);
                    else if (toks[i] === 'time')  time = Number(toks[++i]);
                    else if (toks[i] === 'score') {
                        i++;
                        if (toks[i] === 'cp') scoreCp = Number(toks[++i]);
                        else if (toks[i] === 'mate') scoreCp = 'mate ' + toks[++i];
                    }
                }
                if (depth != null) {
                    if (depth > currentPos.maxDepth) {
                        currentPos.maxDepth = depth;
                        if (nodes != null) currentPos.nodes = nodes;
                        if (nps != null)   currentPos.nps = nps;
                        if (time != null)  currentPos.time = time;
                        if (scoreCp != null && currentPos.scoreCp == null) currentPos.scoreCp = scoreCp;
                    }
                }
                return;
            }

            // Bestmove received → end of this position
            if (s.startsWith('bestmove ')) {
                const parts = s.split(' ');
                currentPos.bestmove = parts[1];
                finishPosition();
                return;
            }
        });

        rl.on('close', () => {
            if (!bootMs && !currentPos?.error) {
                reject(new Error(`Bridge died early before any output. stderr: ${stderrBuf.slice(0, 1000)}`));
            }
            // If we got here and bootMs set but no results, that's also an error
            if (bootMs && results.length === 0) {
                reject(new Error(`Bridge exited without completing any position. Results: 0. stderr: ${stderrBuf.slice(0, 1000)}`));
            }
        });

        child.on('exit', (code) => {
            if (code !== 0 && !quitSent) {
                reject(new Error(`Bridge crashed unexpectedly. exit code: ${code}. stderr: ${stderrBuf.slice(0, 2000)}`));
            }
        });
    });
}

// --- report generation -----------------------------------------
function report(data) {
    console.log('\n=== TITAN CHESS — Stockfish WASM Benchmark ===');
    console.log(`mode        : ${DEPTH ? `depth ${DEPTH}` : `movetime ${MOVETIME}ms`}`);
    console.log(`boot latency: ${data.bootMs} ms (spawn → uciok)`);
    console.log('');

    if (data.results.length === 0) {
        console.log('⚠ No results collected. Check error message above.\n');
        return;
    }

    console.log(' pos  name          depth   nodes       nps       eng.ms  wall.ms  score    bestmove  pv');
    console.log(' ---- ------------- ------- ---------- ---------- ------- ------- -------- -------- --------------------');
    for (const r of data.results) {
        const scoreStr = r.scoreCp == null ? 'n/a' : (typeof r.scoreCp === 'string' ? r.scoreCp : (r.scoreCp / 100).toFixed(2));
        console.log(
            `  ${String(r.id).padEnd(4)} ${r.name.padEnd(13)} ` +
            `${String(r.maxDepth).padEnd(7)} ${fmt(r.nodes).padEnd(10)} ${fmt(r.nps).padEnd(10)} ` +
            `${String(r.time ?? '').padEnd(7)} ${String(r.wallMs ?? '').padEnd(7)} ` +
            `${String(scoreStr).padEnd(8)} ${String(r.bestmove ?? '').padEnd(8)} ${r.pv || ''}`
        );
        if (r.error) console.log(`      !! ${r.error}`);
    }

    const ok = data.results.filter(r => !r.error);
    console.log('');
    if (ok.length) {
        const avgNps = ok.reduce((a, r) => a + (r.nps || 0), 0) / ok.length;
        const avgWall = ok.reduce((a, r) => a + (r.wallMs || 0), 0) / ok.length;
        console.log(`  avg nps     : ${fmt(avgNps)}\n  avg wall ms : ${avgWall.toFixed(0)} (per move)\n  errors      : ${data.results.length - ok.length}/${data.results.length}`);
    }
    if (data.stderr && data.stderr.trim()) {
        console.log('\n  engine stderr (tail):\n  ' + data.stderr.trim().split('\n').slice(-3).join('\n  ') + '\n');
    }
    console.log('');
}

// --- main entry point -----------------------------------------
async function main() {
    let list = POSITIONS;
    if (POS_SEL) {
        const sel = new Set(POS_SEL.split(',').map(Number));
        list = POSITIONS.filter(p => sel.has(p.id));
        if (!list.length) {
            console.error(`Invalid --positions "${POS_SEL}" (valid: ${POSITIONS.map(p => p.id).join(',')})`);
            process.exit(2);
        }
    }

    try {
        const data = await runSession();
        report(data);
        if (JSON_OUT) {
            fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(data, null, 2));
            console.log(`✓ JSON report: ${path.resolve(JSON_OUT)}\n`);
        }
    } catch (err) {
        console.error(`✗ BENCHMARK FAILED: ${err.message}\n`);
        process.exit(1);
    }
}

main();
