const cors = require('cors');
const express = require('express');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

app.use(express.json());
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));

const sessions = {};
const qrCodes = {};
const readyFlags = {}; // 🆕 status siap

const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

const createClient = (sessionId) => {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    readyFlags[sessionId] = false;

    client.on('qr', async (qr) => {
        const qrImage = await qrcode.toDataURL(qr);
        qrCodes[sessionId] = qrImage;
        readyFlags[sessionId] = false;
        console.log(`📸 QR diperbarui untuk ${sessionId}`);
    });

    client.on('authenticated', () => {
        console.log(`🔐 ${sessionId} terautentikasi`);
    });

    client.on('ready', () => {
        console.log(`✅ ${sessionId} siap digunakan`);
        delete qrCodes[sessionId];
        readyFlags[sessionId] = true;
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ ${sessionId} terputus: ${reason}`);
        client.destroy();
        delete sessions[sessionId];
        delete qrCodes[sessionId];
        delete readyFlags[sessionId];
    });

    client.on('auth_failure', (msg) => {
        console.log(`⚠️ Auth failure untuk ${sessionId}:`, msg);
        client.destroy();
        delete sessions[sessionId];
        delete qrCodes[sessionId];
        delete readyFlags[sessionId];
    });

    client.initialize();
    sessions[sessionId] = client;
};

app.get('/api/start', (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ message: 'session_id is required' });

    if (!sessions[sessionId]) {
        createClient(sessionId);
    }

    return res.json({ message: 'Session started' });
});

app.get('/api/qr', (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ message: 'session_id is required' });

    const isReady = readyFlags[sessionId];
    if (isReady) {
        return res.json({ status: 'connected' });
    }

    const qr = qrCodes[sessionId];
    if (qr) {
        return res.json({ status: 'scan', qrImage: qr });
    }

    return res.json({ status: 'not_found' });
});

app.get('/api/status', (req, res) => {
    const sessionId = req.query.session_id;
    const client = sessions[sessionId];
    const isReady = readyFlags[sessionId];

    if (!client) return res.status(404).json({ status: false, message: 'Client tidak ditemukan' });

    if (!isReady) return res.status(200).json({ status: false, message: 'Client belum siap' });

    try {
        const user = {
            id: client.info?.wid?.user || '-',
            name: client.info?.pushname || '-',
            battery: client.info?.battery || '-',
        };
        return res.json({ status: true, user });
    } catch (e) {
        return res.json({ status: false, message: 'Gagal ambil info client' });
    }
});

app.post('/api/send', async (req, res) => {
    const { session_id, number, message } = req.body;
    if (!session_id || !number || !message) return res.status(400).send('Missing parameters');

    const client = sessions[session_id];
    if (!client || !readyFlags[session_id]) return res.status(404).send('Session not found or not ready');

    try {
        await client.sendMessage(`${number}@c.us`, message);
        res.send('Pesan terkirim');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal kirim pesan');
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di http://localhost:${port}`);
});
