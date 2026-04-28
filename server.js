/**
 * Trashcore Web Pairing Server
 * Express + Socket.IO — frontend on Vercel, backend on Railway.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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
const ALLOWED_ORIGIN = 'https://your-app.vercel.app';

const app = express();

// CORS for /api/stats fetch calls from Vercel
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
        const sessionEntry = { id, trashcore: null, retries: 0, codeSent: false };
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

                // Guard — only request code once, never again on reconnect
                if (!trashcore.authState.creds.registered && !sessionEntry.codeSent) {
                    sessionEntry.codeSent = true;
                    await delay(1500);
                    const code = await trashcore.requestPairingCode(num);
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
                        // Wait longer — give WhatsApp time to fully register keys
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

                        // 515 = stream error mid-handshake — WhatsApp does this
                        // normally right after the user enters the pairing code.
                        // Silently reconnect so the 'open' event can fire.
                        const isHandshake = statusCode === 515;

                        if (isLoggedOut) {
                            // Deliberate logout — just clean up silently
                            connectionClosed = true;
                            cleanup(socket.id);

                        } else if (isHandshake || sessionEntry.codeSent) {
                            // Mid-login reconnect — retry quietly, no error shown
                            if (sessionEntry.retries < 5) {
                                sessionEntry.retries++;
                                await delay(2000);
                                startPairing();
                            } else {
                                connectionClosed = true;
                                cleanup(socket.id);
                                stats.totalFailed++;
                                saveStats(stats);
                                socket.emit('error', { message: 'Could not complete login. Please try again.' });
                            }
                        } else {
                            // Unexpected drop before code was sent
                            connectionClosed = true;
                            cleanup(socket.id);
                            stats.totalFailed++;
                            saveStats(stats);
                            socket.emit('error', { message: 'Connection closed. Please try again.' });
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
