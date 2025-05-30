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
    origin: '*', // Bisa kamu ganti ke domain frontend kamu
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));

// Tidak perlu lagi menyajikan folder public
// app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};
const qrCodes = {};
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

    client.on('qr', async (qr) => {
        const qrImage = await qrcode.toDataURL(qr);
        qrCodes[sessionId] = qrImage;
        console.log(`📸 QR updated for ${sessionId}`);
    });

    client.on('ready', () => {
        console.log(`✅ ${sessionId} is ready`);
        delete qrCodes[sessionId];
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

    const qrImage = qrCodes[sessionId];
    if (qrImage) {
        return res.json({ qrImage });
    } else {
        return res.json({ message: 'QR belum tersedia atau sudah login' });
    }
});

app.get('/api/status', (req, res) => {
    const sessionId = req.query.session_id;
    const client = sessions[sessionId];
    if (!client) return res.status(404).json({ status: false, message: 'Client tidak ditemukan' });

    if (client.info && client.info.wid) {
        const user = {
            id: client.info.wid.user,
            name: client.info.pushname || '-',
            battery: client.info.battery || '-',
        };
        return res.json({ status: true, user });
    }

    return res.json({ status: false });
});

app.post('/api/send', async (req, res) => {
    const { session_id, number, message } = req.body;
    if (!session_id || !number || !message) return res.status(400).send('Missing parameters');

    const client = sessions[session_id];
    if (!client) return res.status(404).send('Session not found or not ready');

    try {
        await client.sendMessage(`${number}@c.us`, message);
        res.send('Pesan terkirim');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal kirim pesan');
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan tanpa tampilan web di http://localhost:${port}`);
});
