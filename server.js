const cors = require('cors');
const express = require('express');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

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
const readyFlags = {};
const adminNumbers = {};

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

    client.on('ready', async () => {
        console.log(`✅ ${sessionId} siap digunakan`);
        delete qrCodes[sessionId];
        readyFlags[sessionId] = true;

        // 🔁 Tunggu hingga client.info.wid.user tersedia
        let maxAttempts = 5;
        while ((!client.info || !client.info.wid?.user) && maxAttempts > 0) {
            console.log(`⏳ Menunggu info client untuk ${sessionId}...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            maxAttempts--;
        }

        const adminNumber = client.info?.wid?.user;
        if (adminNumber) {
            saveAdminNumberToDB(sessionId, adminNumber);
        } else {
            console.warn(`⚠️ Gagal mendapatkan adminNumber untuk ${sessionId}`);
        }
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ ${sessionId} terputus: ${reason}`);
        client.destroy();
        delete sessions[sessionId];
        delete qrCodes[sessionId];
        delete readyFlags[sessionId];
        delete adminNumbers[sessionId];
    });

    client.on('auth_failure', (msg) => {
        console.log(`⚠️ Gagal autentikasi untuk ${sessionId}:`, msg);
        client.destroy();
        delete sessions[sessionId];
        delete qrCodes[sessionId];
        delete readyFlags[sessionId];
        delete adminNumbers[sessionId];
    });

    client.initialize();
    sessions[sessionId] = client;
};

const saveAdminNumberToDB = async (sessionId, adminNumber) => {
    if (!adminNumber) {
        console.error('Nomor admin tidak boleh kosong');
        return;
    }

    try {
        await axios.post('http://localhost:8000/api/saveAdminNumber', {
            session_id: sessionId,
            admin_number: adminNumber
        });
        console.log(`✅ Nomor admin untuk session ${sessionId} berhasil disimpan`);
    } catch (error) {
        console.error('❌ Gagal menyimpan nomor admin ke DB:', error.response?.data || error);
    }
};

app.get('/api/start', (req, res) => {
    const sessionId = req.query.session_id;
    const adminNumber = req.query.admin_number;
    if (!sessionId || !adminNumber) {
        return res.status(400).json({ message: 'session_id dan admin_number diperlukan' });
    }

    adminNumbers[sessionId] = adminNumber;

    if (!sessions[sessionId]) {
        createClient(sessionId);
    }

    return res.json({ message: 'Sesi dimulai' });
});

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

    if (!sessions[sessionId]) {
        createClient(sessionId);
        return res.json({ status: 'initializing', message: 'QR sedang disiapkan. Silakan tunggu dan refresh.' });
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
    if (!session_id || !number || !message) return res.status(400).send('Parameter tidak lengkap');

    const client = sessions[session_id];
    if (!client || !readyFlags[session_id]) return res.status(404).send('Session tidak ditemukan atau belum siap');

    try {
        if (!client.info) throw new Error("Client belum sepenuhnya siap");
        await client.sendMessage(`${number}@c.us`, message);
        res.send('Pesan terkirim');
    } catch (err) {
        console.error('Gagal kirim:', err.message);
        res.status(500).send('Gagal kirim pesan');
    }
});

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
            delete adminNumbers[sessionId];

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

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di http://localhost:${port}`);
});
