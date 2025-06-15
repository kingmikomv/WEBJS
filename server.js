const cors = require('cors');
const express = require('express');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
require('express-async-errors');

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
const creatingSessions = {};
const clientInfoCache = {};

const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR);
}

// 🔁 Pulihkan semua session dari folder
fs.readdir(SESSIONS_DIR, (err, folders) => {
    if (err) return console.error('❌ Gagal baca folder sesi:', err);
    folders.forEach(sessionId => {
        console.log(`🔁 Memulihkan sesi: ${sessionId}`);
        createClient(sessionId);
    });
});

// ⏳ Preload Chromium sekali saja
(async () => {
    try {
        console.log('⏳ Preloading Chromium...');
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: '/usr/bin/chromium-browser',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        await browser.close();
        console.log('✅ Chromium preloaded');
    } catch (err) {
        console.warn('⚠️ Chromium preload gagal:', err.message);
    }
})();

function createClient(sessionId) {
    if (creatingSessions[sessionId]) return;
    creatingSessions[sessionId] = true;

    const sessionPath = path.join(SESSIONS_DIR, sessionId);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath }),
        puppeteer: {
            headless: true,
            executablePath: '/usr/bin/chromium-browser',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    readyFlags[sessionId] = false;

    client.on('qr', async (qr) => {
        qrCodes[sessionId] = await qrcode.toDataURL(qr);
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

        let maxAttempts = 5;
        while ((!client.info || !client.info.wid?.user) && maxAttempts-- > 0) {
            await new Promise(r => setTimeout(r, 300));
        }

        const adminNumber = client.info?.wid?.user;
        if (adminNumber) {
            saveAdminNumberToDB(sessionId, adminNumber);
            clientInfoCache[sessionId] = {
                id: adminNumber,
                name: client.info.pushname || '-',
                battery: client.info.battery || '-',
            };
        } else {
            console.warn(`⚠️ Gagal mendapatkan adminNumber untuk ${sessionId}`);
        }

        delete creatingSessions[sessionId];
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ ${sessionId} terputus: ${reason}`);
        cleanupSession(sessionId);
    });

    client.on('auth_failure', (msg) => {
        console.log(`⚠️ Gagal autentikasi untuk ${sessionId}:`, msg);
        cleanupSession(sessionId);
    });

    client.initialize();
    sessions[sessionId] = client;
}

function cleanupSession(sessionId) {
    sessions[sessionId]?.destroy().catch(() => {});
    delete sessions[sessionId];
    delete qrCodes[sessionId];
    delete readyFlags[sessionId];
    delete adminNumbers[sessionId];
    delete clientInfoCache[sessionId];
    delete creatingSessions[sessionId];
}

async function saveAdminNumberToDB(sessionId, adminNumber) {
    try {
        await axios.post('https://biller.aqtnetwork.my.id/api/saveAdminNumber', {
            session_id: sessionId,
            admin_number: adminNumber
        });
        console.log(`✅ Nomor admin untuk session ${sessionId} berhasil disimpan`);
    } catch (error) {
        console.error('❌ Gagal menyimpan nomor admin ke DB:', error.response?.data || error);
    }
}

app.get('/api/start', (req, res) => {
    const sessionId = req.query.session_id;
    const adminNumber = req.query.admin_number;
    if (!sessionId || !adminNumber) return res.status(400).json({ message: 'session_id dan admin_number diperlukan' });

    adminNumbers[sessionId] = adminNumber;
    if (!sessions[sessionId]) createClient(sessionId);

    res.json({ message: 'Sesi dimulai' });
});

app.get('/api/qr', (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ message: 'session_id diperlukan' });

    if (readyFlags[sessionId]) return res.json({ status: 'connected' });

    const qr = qrCodes[sessionId];
    if (qr) return res.json({ status: 'scan', qrImage: qr });

    if (!sessions[sessionId] && !creatingSessions[sessionId]) {
        createClient(sessionId);
        return res.json({ status: 'initializing', message: 'QR sedang disiapkan. Silakan tunggu dan refresh.' });
    }

    res.json({ status: 'not_found' });
});

app.get('/api/status', (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId || !sessions[sessionId]) {
        return res.status(404).json({ status: false, message: 'Client tidak ditemukan' });
    }

    if (!readyFlags[sessionId]) {
        return res.status(200).json({ status: false, message: 'Client belum siap' });
    }

    const user = clientInfoCache[sessionId] || {
        id: sessions[sessionId].info?.wid?.user || '-',
        name: sessions[sessionId].info?.pushname || '-',
        battery: sessions[sessionId].info?.battery || '-',
    };
    res.json({ status: true, user });
});

app.post('/api/send', async (req, res) => {
    const { session_id, number, message } = req.body;
    if (!session_id || !number || !message) return res.status(400).send('Parameter tidak lengkap');

    const client = sessions[session_id];
    if (!client || !readyFlags[session_id]) return res.status(404).send('Session tidak ditemukan atau belum siap');

    try {
        await client.sendMessage(`${number}@c.us`, message);
        res.send('Pesan terkirim');
    } catch (err) {
        console.error('Gagal kirim:', err.message);
        res.status(500).send('Gagal kirim pesan');
    }
});

app.get('/api/disconnect', async (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId || !sessions[sessionId]) return res.status(404).json({ message: 'Session tidak ditemukan' });

    try {
        await sessions[sessionId].destroy();
        cleanupSession(sessionId);

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`🗑️ Sesi ${sessionId} terputus dan folder dihapus`);
        }

        createClient(sessionId);
        res.json({ message: `Session ${sessionId} berhasil diputus dan file dihapus` });
    } catch (err) {
        console.error('Gagal disconnect:', err);
        res.status(500).json({ message: 'Gagal disconnect sesi' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di http://localhost:${port}`);
});
