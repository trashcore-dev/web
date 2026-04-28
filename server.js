/**
 * Trashcore Web Pairing Server
 * Express + Socket.IO — drops the Telegram dependency entirely.
 * Each browser tab gets its own isolated pairing session via socket.id.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const { makeid } = require('./id');
const {
    default: Mbuvi_Tech,
    useMultiFileAuthState,
    delay,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@trashcore/baileys');

// Allowed origins — set ALLOWED_ORIGINS in .env as comma-separated list
// e.g. ALLOWED_ORIGINS=https://trashbots.zone.id,https://www.trashbots.zone.id
// Falls back to localhost only if not set
const rawOrigins = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
const allowedOrigins = rawOrigins.split(',').map(o => o.trim());

function originAllowed(origin) {
    if (!origin) return false; // block non-browser requests (curl, etc.) unless you want them
    return allowedOrigins.includes(origin);
}

const corsOptions = {
    origin: (origin, callback) => {
        if (originAllowed(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`CORS: origin '${origin}' not allowed`));
        }
    },
    methods: ['GET'],
    credentials: false
};

const app = express();
app.use(cors(corsOptions));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (originAllowed(origin)) {
                callback(null, true);
            } else {
                callback(new Error(`CORS: origin '${origin}' not allowed`));
            }
        },
        methods: ['GET', 'POST'],
        credentials: false
    }
});

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── Stats ─────────────────────────────────────────────────────────────────
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    } catch (_) {}
    return { totalUsers: 0, uniqueUsers: [], totalRequested: 0, totalSuccessful: 0, totalFailed: 0, startedAt: Date.now() };
}

function saveStats(s) {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2)); } catch (_) {}
}

const stats = loadStats();

function trackUser(socketId) {
    if (!stats.uniqueUsers.includes(socketId)) {
        stats.uniqueUsers.push(socketId);
        stats.totalUsers = stats.uniqueUsers.length;
        saveStats(stats);
    }
}

// ─── Active sessions ───────────────────────────────────────────────────────
const activeSessions = new Map(); // socketId → { id, trashcore, retries }

function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    try { fs.rmSync(filePath, { recursive: true, force: true }); } catch (_) {}
}

function cleanup(socketId) {
    const session = activeSessions.get(socketId);
    if (!session) return;
    try {
        if (session.trashcore?.ws) session.trashcore.ws.close();
        if (session.trashcore?.end) session.trashcore.end();
    } catch (_) {}
    removeFile(path.join(TEMP_DIR, session.id));
    activeSessions.delete(socketId);
}

// ─── Serve static frontend ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Stats API ─────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
    res.json({
        totalUsers: stats.totalUsers,
        totalSuccessful: stats.totalSuccessful,
        totalRequested: stats.totalRequested,
        activeSessions: activeSessions.size,
        uptime: Date.now() - stats.startedAt
    });
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    socket.on('start_pairing', async ({ phone }) => {
        // Validate phone
        const num = (phone || '').replace(/[^0-9]/g, '');
        if (!num || num.length < 7 || num.length > 15) {
            return socket.emit('error', { message: 'Invalid phone number. Include country code, e.g. 2547XXXXXXXX' });
        }

        if (activeSessions.has(socket.id)) {
            return socket.emit('error', { message: 'You already have an active session. Cancel it first.' });
        }

        trackUser(socket.id);
        stats.totalRequested++;
        saveStats(stats);

        socket.emit('status', { step: 'connecting', message: `Starting pairing for +${num}…` });

        const id = makeid(8);
        const sessionEntry = { id, trashcore: null, retries: 0 };
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
                    markOnlineOnConnect: false
                });

                sessionEntry.trashcore = trashcore;

                if (!trashcore.authState.creds.registered) {
                    await delay(1500);
                    const code = await trashcore.requestPairingCode(num, 'TRASHBOT');
                    const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

                    socket.emit('pairing_code', { code: formatted });
                    socket.emit('status', { step: 'waiting', message: 'Enter the code in WhatsApp → Linked Devices → Link with phone number' });
                }

                trashcore.ev.on('creds.update', saveCreds);

                trashcore.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect } = update;
                    if (connectionClosed) return;

                    if (connection === 'open') {
                        connectionClosed = true;
                        await delay(5000);

                        try {
                            let sessionId;
                            try {
                                const credsJson = JSON.stringify(trashcore.authState.creds);
                                sessionId = 'trashcore~' + Buffer.from(credsJson).toString('base64');
                            } catch (_) {
                                const data = fs.readFileSync(path.join(TEMP_DIR, id, 'creds.json'));
                                sessionId = 'trashcore~' + Buffer.from(data).toString('base64');
                            }

                            // Send to WhatsApp
                            await trashcore.sendMessage(trashcore.user.id, { text: sessionId });

                            // Emit to browser
                            socket.emit('session_ready', {
                                sessionId,
                                message: 'Session ID also sent to your WhatsApp!'
                            });

                            stats.totalSuccessful++;
                            saveStats(stats);

                        } catch (err) {
                            console.error('Session emit error:', err);
                            socket.emit('error', { message: 'Paired but failed to get session ID. Try again.' });
                            stats.totalFailed++;
                            saveStats(stats);
                        } finally {
                            cleanup(socket.id);
                        }

                    } else if (connection === 'close' && !connectionClosed) {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

                        if (!isLoggedOut && sessionEntry.retries < 3) {
                            sessionEntry.retries++;
                            socket.emit('status', { step: 'retrying', message: `Reconnecting… (attempt ${sessionEntry.retries}/3)` });
                            await delay(10000);
                            startPairing();
                        } else {
                            connectionClosed = true;
                            cleanup(socket.id);
                            if (!isLoggedOut) {
                                stats.totalFailed++;
                                saveStats(stats);
                                socket.emit('error', { message: 'Connection failed after retries. Please try again.' });
                            }
                        }
                    }
                });

            } catch (err) {
                console.error('Pairing error:', err);
                connectionClosed = true;
                cleanup(socket.id);
                stats.totalFailed++;
                saveStats(stats);
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

server.listen(PORT, () => {
    console.log(`🌐 Trashcore Web Pairing running on http://localhost:${PORT}`);
});

process.on('unhandledRejection', (err) => console.error('UNHANDLED:', err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err));
