/**
 * Trashcore Web Pairing Server
 * Express + Socket.IO — frontend on Vercel, backend on Railway.
 * Stats persisted in Neon PostgreSQL.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

function makeid(num = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < num; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

const {
    default: Mbuvi_Tech,
    useMultiFileAuthState,
    delay,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@trashcore/baileys');

// ── Replace with your actual Vercel URL once deployed ──────────────────────
const ALLOWED_ORIGIN = 'https://ultrax.drextrash.online';

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    next();
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGIN,
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── PostgreSQL (Neon) ──────────────────────────────────────────────────────
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// In-memory cache — pairing logic never touches DB directly
let statsCache = {
    totalUsers: 0,
    totalRequested: 0,
    totalSuccessful: 0,
    totalFailed: 0,
    startedAt: Date.now(),
    uniqueUsers: new Set()
};

async function initDb() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS pairing_stats (
            id INTEGER PRIMARY KEY DEFAULT 1,
            total_users INTEGER DEFAULT 0,
            total_requested INTEGER DEFAULT 0,
            total_successful INTEGER DEFAULT 0,
            total_failed INTEGER DEFAULT 0,
            started_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
            unique_users TEXT DEFAULT '[]'
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS pairing_snapshots (
            id SERIAL PRIMARY KEY,
            recorded_at BIGINT NOT NULL,
            total_successful INTEGER NOT NULL,
            total_requested INTEGER NOT NULL,
            active_sessions INTEGER NOT NULL
        )
    `);

    // Seed row if missing
    await db.query(`
        INSERT INTO pairing_stats (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING
    `);

    // Load persisted stats into cache
    const { rows } = await db.query('SELECT * FROM pairing_stats WHERE id = 1');
    if (rows.length) {
        const r = rows[0];
        statsCache.totalUsers      = r.total_users;
        statsCache.totalRequested  = r.total_requested;
        statsCache.totalSuccessful = r.total_successful;
        statsCache.totalFailed     = r.total_failed;
        statsCache.startedAt       = Number(r.started_at);
        try { statsCache.uniqueUsers = new Set(JSON.parse(r.unique_users)); } catch (_) {}
    }

    console.log(`✅ PostgreSQL connected — ${statsCache.totalSuccessful} sessions loaded from DB`);
}

// Fire-and-forget flush to DB after every stat change
function flushStats() {
    db.query(
        `UPDATE pairing_stats SET
            total_users      = $1,
            total_requested  = $2,
            total_successful = $3,
            total_failed     = $4,
            unique_users     = $5
         WHERE id = 1`,
        [
            statsCache.totalUsers,
            statsCache.totalRequested,
            statsCache.totalSuccessful,
            statsCache.totalFailed,
            JSON.stringify([...statsCache.uniqueUsers])
        ]
    ).catch(err => console.error('DB flush error:', err));
}

function trackUser(socketId) {
    if (!statsCache.uniqueUsers.has(socketId)) {
        statsCache.uniqueUsers.add(socketId);
        statsCache.totalUsers = statsCache.uniqueUsers.size;
        flushStats();
    }
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

// ─── Snapshot every 10 min ─────────────────────────────────────────────────
function recordSnapshot() {
    db.query(
        `INSERT INTO pairing_snapshots (recorded_at, total_successful, total_requested, active_sessions)
         VALUES ($1, $2, $3, $4)`,
        [Date.now(), statsCache.totalSuccessful, statsCache.totalRequested, activeSessions.size]
    ).catch(err => console.error('Snapshot error:', err));

    // Keep only last 144 rows (24h)
    db.query(
        `DELETE FROM pairing_snapshots WHERE id NOT IN (
            SELECT id FROM pairing_snapshots ORDER BY recorded_at DESC LIMIT 144
        )`
    ).catch(() => {});
}
setInterval(recordSnapshot, 10 * 60 * 1000);

// ─── Active sessions ───────────────────────────────────────────────────────
const activeSessions = new Map();

function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    try { fs.rmSync(filePath, { recursive: true, force: true }); } catch (_) {}
}

function cleanup(socketId) {
    const session = activeSessions.get(socketId);
    if (!session) return;
    if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
    try {
        if (session.trashcore?.ws) session.trashcore.ws.close();
        if (session.trashcore?.end) session.trashcore.end();
    } catch (_) {}
    removeFile(path.join(TEMP_DIR, session.id));
    activeSessions.delete(socketId);
}

// ─── Stats API ─────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
    try {
        const uptimeMs = Date.now() - statsCache.startedAt;
        const successRate = statsCache.totalRequested > 0
            ? ((statsCache.totalSuccessful / statsCache.totalRequested) * 100).toFixed(1)
            : '0.0';

        const { rows: hourly } = await db.query(
            `SELECT recorded_at AS t, total_successful AS s, total_requested AS r, active_sessions AS a
             FROM pairing_snapshots ORDER BY recorded_at ASC`
        );

        res.json({
            totalUsers:      statsCache.totalUsers,
            totalSuccessful: statsCache.totalSuccessful,
            totalFailed:     statsCache.totalFailed,
            totalRequested:  statsCache.totalRequested,
            activeSessions:  activeSessions.size,
            successRate,
            uptime:          uptimeMs,
            uptimeFormatted: formatUptime(uptimeMs),
            hourly
        });
    } catch (err) {
        console.error('Stats API error:', err);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    socket.on('start_pairing', async ({ phone }) => {
        const num = (phone || '').replace(/[^0-9]/g, '');
        if (!num || num.length < 7 || num.length > 15) {
            return socket.emit('error', { message: 'Invalid phone number. Include country code, e.g. 2547XXXXXXXX' });
        }

        if (activeSessions.has(socket.id)) {
            return socket.emit('error', { message: 'You already have an active session. Cancel it first.' });
        }

        trackUser(socket.id);
        statsCache.totalRequested++;
        flushStats();

        socket.emit('status', { step: 'connecting', message: `Starting pairing for +${num}…` });

        const id = makeid(8);
        const sessionEntry = { id, trashcore: null, retries: 0, codeSent: false, keepAliveTimer: null };
        activeSessions.set(socket.id, sessionEntry);

        async function startPairing() {
            const sessionPath = path.join(TEMP_DIR, id);
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            let connectionClosed = false;

            try {
                const trashcore = Mbuvi_Tech({
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(
                            state.keys,
                            pino({ level: 'silent' }).child({ level: 'silent' })
                        )
                    },
                    version,
                    printQRInTerminal: false,
                    logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
                    browser: ['Ubuntu', 'Opera', '100.0.4815.0'],
                    shouldSyncHistoryMessage: false,
                    syncFullHistory: false,
                    markOnlineOnConnect: false,
                    // Keep WS alive — Railway kills idle sockets after ~30s
                    keepAliveIntervalMs: 15_000
                });

                sessionEntry.trashcore = trashcore;

                if (!trashcore.authState.creds.registered && !sessionEntry.codeSent) {
                    sessionEntry.codeSent = true;
                    await delay(1500);
                    const code = await trashcore.requestPairingCode(num);
                    const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

                    socket.emit('pairing_code', { code: formatted });
                    socket.emit('status', { step: 'waiting', message: 'Enter the code in WhatsApp → Linked Devices → Link with phone number' });

                    // Extra safety: ping the WS ourselves every 20s while waiting
                    sessionEntry.keepAliveTimer = setInterval(() => {
                        try {
                            if (trashcore?.ws?.readyState === 1) trashcore.ws.ping();
                        } catch (_) {}
                    }, 20_000);
                }

                trashcore.ev.on('creds.update', saveCreds);

                trashcore.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect } = update;
                    if (connectionClosed) return;

                    if (connection === 'open') {
                        connectionClosed = true;
                        await delay(8000);

                        try {
                            let sessionId;
                            try {
                                const credsJson = JSON.stringify(trashcore.authState.creds);
                                sessionId = 'trashcore~' + Buffer.from(credsJson).toString('base64');
                            } catch (_) {
                                const data = fs.readFileSync(path.join(TEMP_DIR, id, 'creds.json'));
                                sessionId = 'trashcore~' + Buffer.from(data).toString('base64');
                            }

                            await trashcore.sendMessage(trashcore.user.id, { text: sessionId });

                            socket.emit('session_ready', {
                                sessionId,
                                message: 'Session ID also sent to your WhatsApp!'
                            });

                            statsCache.totalSuccessful++;
                            flushStats();

                        } catch (err) {
                            console.error('Session emit error:', err);
                            socket.emit('error', { message: 'Paired but failed to get session ID. Try again.' });
                            statsCache.totalFailed++;
                            flushStats();
                        } finally {
                            cleanup(socket.id);
                        }

                    } else if (connection === 'close' && !connectionClosed) {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
                        const isHandshake = statusCode === 515;

                        if (isLoggedOut) {
                            connectionClosed = true;
                            cleanup(socket.id);

                        } else if (isHandshake || sessionEntry.codeSent) {
                            if (sessionEntry.retries < 5) {
                                sessionEntry.retries++;
                                await delay(2000);
                                startPairing();
                            } else {
                                connectionClosed = true;
                                cleanup(socket.id);
                                statsCache.totalFailed++;
                                flushStats();
                                socket.emit('error', { message: 'Could not complete login. Please try again.' });
                            }
                        } else {
                            connectionClosed = true;
                            cleanup(socket.id);
                            statsCache.totalFailed++;
                            flushStats();
                            socket.emit('error', { message: 'Connection closed. Please try again.' });
                        }
                    }
                });

            } catch (err) {
                console.error('Pairing error:', err);
                connectionClosed = true;
                cleanup(socket.id);
                statsCache.totalFailed++;
                flushStats();
                socket.emit('error', { message: 'Service unavailable. Please try again.' });
            }
        }

        await startPairing();
    });

    socket.on('cancel_pairing', () => {
        cleanup(socket.id);
        socket.emit('status', { step: 'cancelled', message: 'Pairing session cancelled.' });
    });

    socket.on('disconnect', () => {
        console.log(`[-] Disconnected: ${socket.id}`);
        cleanup(socket.id);
    });
});

// ─── Boot ───────────────────────────────────────────────────────────────────
initDb().then(() => {
    server.listen(PORT, () => {
        console.log(`🌐 Trashcore Web Pairing running on port ${PORT}`);
    });
}).catch(err => {
    console.error('❌ DB init failed:', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => console.error('UNHANDLED:', err));
process.on('uncaughtException',  (err) => console.error('UNCAUGHT:', err));
