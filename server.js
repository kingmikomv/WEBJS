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
const readyFlags = {}; // Status siap

const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

// Fungsi untuk membuat client baru
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
        console.log(`⚠️ Gagal autentikasi untuk ${sessionId}:`, msg);
        client.destroy();
        delete sessions[sessionId];
        delete qrCodes[sessionId];
        delete readyFlags[sessionId];
    });

    client.initialize();
    sessions[sessionId] = client;
};

// Endpoint untuk memulai sesi
app.get('/api/start', (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ message: 'session_id diperlukan' });

    if (!sessions[sessionId]) {
        createClient(sessionId);
    }

    return res.json({ message: 'Sesi dimulai' });
});

// Endpoint untuk mendapatkan QR code
app.get('/api/qr', (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ message: 'session_id diperlukan' });

    const isReady = readyFlags[sessionId];
    if (isReady) {
        return res.json({ status: 'connected' });
    }

    const qr = qrCodes[sessionId];
    if (qr) {
        return res.json({ status: 'scan', qrImage: qr });
    }

    // Jika client belum dibuat (terhapus karena disconnect/logout), buat ulang
    if (!sessions[sessionId]) {
        createClient(sessionId);
        return res.json({ status: 'initializing', message: 'QR sedang disiapkan. Silakan tunggu dan refresh.' });
    }

    return res.json({ status: 'not_found' });
});

// Endpoint untuk mengecek status koneksi
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

// Endpoint untuk mengirim pesan
app.post('/api/send', async (req, res) => {
    const { session_id, number, message } = req.body;
    if (!session_id || !number || !message) return res.status(400).send('Parameter tidak lengkap');

    const client = sessions[session_id];
    if (!client || !readyFlags[session_id]) return res.status(404).send('Session tidak ditemukan atau belum siap');

    try {
        await client.sendMessage(`${number}@c.us`, message);
        res.send('Pesan terkirim');
    } catch (err) {
        console.error(err);
        res.status(500).send('Gagal kirim pesan');
    }
});

// Endpoint untuk memutuskan sesi
app.get('/api/disconnect', (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ message: 'session_id diperlukan' });

    const client = sessions[sessionId];
    if (!client) return res.status(404).json({ message: 'Session tidak ditemukan' });

    client.destroy()
        .then(() => {
            delete sessions[sessionId];
            delete qrCodes[sessionId];
            delete readyFlags[sessionId];

            const sessionPath = path.join(SESSIONS_DIR, sessionId);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`🗑️ Sesi ${sessionId} terputus dan folder dihapus`);
            }
            createClient(sessionId);

            res.json({ message: `Session ${sessionId} berhasil diputus dan file dihapus` });
        })
        .catch((err) => {
            console.error('Gagal disconnect:', err);
            res.status(500).json({ message: 'Gagal disconnect sesi' });
        });
});

// Menjalankan server
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di http://localhost:${port}`);
});
