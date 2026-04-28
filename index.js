const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const { useSingleFileAuthState, clearSingleAuthFile } = require('./useSingleFileAuthState');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Path auth: SATU file JSON saja (hemat inode) ──────────────
const AUTH_FILE = path.join(__dirname, 'auth_info.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// ── Status global ──────────────────────────────────────────────
let botStatus = 'disconnected';
let currentQR = null;
let activeSock = null;

// ── Guard reconnect: cegah multiple instance berjalan bersamaan ─
let isConnecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;

// ── Hapus SATU file auth (tidak lagi hapus folder) ────────────
function clearAuthFiles() {
    clearSingleAuthFile(AUTH_FILE);
}

// ── Hitung delay exponential backoff ──────────────────────────
function getReconnectDelay() {
    return Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 5 * 60 * 1000);
}

// ── Jadwalkan reconnect dengan delay ──────────────────────────
function scheduleReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`❌ Sudah mencoba reconnect ${MAX_RECONNECT_ATTEMPTS}x. Berhenti.`);
        botStatus = 'disconnected';
        isConnecting = false;
        return;
    }

    const delay = getReconnectDelay();
    reconnectAttempts++;
    console.log(`🔄 Reconnect ke-${reconnectAttempts} dalam ${delay / 1000}s...`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startBot();
    }, delay);
}

// ── Bersihkan socket lama ──────────────────────────────────────
function cleanupSocket() {
    if (activeSock) {
        try {
            activeSock.ev.removeAllListeners();
            activeSock.end();
        } catch (_) {}
        activeSock = null;
    }
}

// ── API polling untuk browser ──────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({ status: botStatus, qr: currentQR });
});

// ── Endpoint logout ────────────────────────────────────────────
app.post('/api/logout', async (req, res) => {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempts = 0;
    isConnecting = false;

    if (botStatus !== 'connected' || !activeSock) {
        cleanupSocket();
        clearAuthFiles();
        botStatus = 'disconnected';
        currentQR = null;
        res.json({ ok: true, message: 'Auth dihapus, menunggu QR baru...' });
        setTimeout(() => startBot(), 1000);
        return;
    }

    try {
        botStatus = 'logging_out';
        await activeSock.logout();
    } catch (err) {
        console.log('Logout error (diabaikan):', err?.message || err);
    }

    cleanupSocket();
    clearAuthFiles();
    botStatus = 'disconnected';
    currentQR = null;

    res.json({ ok: true, message: 'Logout berhasil, scan QR untuk akun baru.' });
    setTimeout(() => startBot(), 1000);
});

app.get('/scan', (req, res) => {
    res.sendFile(path.join(__dirname, 'client', 'scan.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server berjalan di http://localhost:${PORT}`);
    console.log(`📱 Buka http://localhost:${PORT}/scan untuk scan QR\n`);
    console.log(`📁 Auth disimpan di: ${AUTH_FILE} (1 file, hemat inode)\n`);
});

// ══════════════════════════════════════════════════════════════════
// ── PANTUN PAGI (rotasi harian) ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const PANTUN_PAGI = [
    "Pagi hari minum teh hangat\nBurung berkicau riang di dahan\nSemangat kerja jangan sampai padat\nHari ini penuh energi dan harapan",
    "Mentari pagi menyinari taman\nAngin sepoi membawa kesegaran\nBangun semangat jangan sampai diam\nMulai hari dengan penuh ketenangan",
    "Jalan-jalan ke pasar membeli ikan\nKue manis dijual di pinggir jalan\nSelamat pagi teman semua kawan\nSemoga hari ini penuh senyuman",
    "Petik bunga di tepi kolam\nBunga harum mewangi menyapa pagi\nMulai hari dengan hati yang tenang\nBekerja cerdas jangan sampai sepi",
    "Lari pagi di tepi sungai\nAir mengalir menyejukkan hati\nKerja cerdas mulai dari niat\nHari ini sukses pasti menanti",
    // ... (sisanya sama persis dengan kode asli kamu, dipersingkat di sini)
];

function getPantunHariIni() {
    const startDate = new Date('2025-01-01');
    const today = new Date();
    const diffDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
    const index = diffDays % PANTUN_PAGI.length;
    return PANTUN_PAGI[index];
}

// ══════════════════════════════════════════════════════════════════
// ── FITUR PESAN TERJADWAL ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const SCHEDULED_MESSAGES = [
    {
        name: 'Capaian pengisian google form SKM',
        cron: '0 12 * * 1-4',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
            '6285255232511-1478313137@g.us',
        ],
        handler: async () => {
            const dataSKM = await getDataSKM();
            if (dataSKM.status === 'success' && dataSKM.data) {
                return formatSKMMessage(dataSKM.data);
            }
            return '❌ Gagal mengambil data SKM. Coba lagi nanti.\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖';
        },
    },
    {
        name: 'Monitoring Pertemuan',
        cron: '45 11 * * 1-4',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
            '6285255232511-1478313137@g.us',
        ],
        message:
            'Izin mengirimkan link monitoring pertemuan:\n\n' +
            '📎 https://docs.google.com/forms/d/e/1FAIpQLSfWi4KwZqbqZQIdbIo0Tkj3O27ypAs5CmzFMMExS5GBGKPlpA/viewform?usp=publish-editor\n' +
            'Kesediaannya untuk mengisi Hasil Pertemuan, Kesepakatan/tindak lanjut dan batas waktu. Terima kasih 🙏.\n\n' +
            'spreadsheet monitoring:\n' +
            'https://docs.google.com/spreadsheets/d/1Upnvup9_cULZVPwh280H6qNta4iZIZ-ChyvVyeI0AHI/edit?gid=1914370244#gid=1914370244\n\n' +
            '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
    },
    {
        name: 'Sistem Informasi Form',
        cron: '0 9 * * 1-4',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
            '6285255232511-1478313137@g.us',
        ],
        message:
             'Assalamualaikum,\n' +
            'izin, Mohon bantuannya untuk mengisi Form Pendataan Sistem Informasi dengan ' +
            'memasukkan nama,profesi dan mengisi frekuensi penggunaan aplikasi pada link berikut :\n' +
            '📎 https://script.google.com/macros/s/AKfycbwedZaodNfH-kNUP-lhaLWrvdGkTWTDRa-LV6EOxS-_4rNmS_PyEylmWta79LImRWrcsw/exec\n\n' +
            'daftar nama yang belum/sudah mengisi\n' +
            'https://docs.google.com/spreadsheets/d/1Kpe1VSWhCTuiwVeXcHefFs-iD6Vt0mBYsUoO3bf272E/edit?gid=752893668#gid=752893668\n\n' +
            '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
    },
    {
        name: 'Capaian pengisian google form SKM (jumat)',
        cron: '30 10 * * 5-6',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
            '6285255232511-1478313137@g.us',
        ],
        handler: async () => {
            const dataSKM = await getDataSKM();
            if (dataSKM.status === 'success' && dataSKM.data) {
                return formatSKMMessage(dataSKM.data);
            }
            return '❌ Gagal mengambil data SKM. Coba lagi nanti.\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖';
        },
    },
    {
        name: 'Monitoring Pertemuan (jumat)',
        cron: '31 10 * * 5-6',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
            '6285255232511-1478313137@g.us',
        ],
        message:
            'Izin mengirimkan link monitoring pertemuan:\n\n' +
            '📎 https://docs.google.com/forms/d/e/1FAIpQLSfWi4KwZqbqZQIdbIo0Tkj3O27ypAs5CmzFMMExS5GBGKPlpA/viewform?usp=publish-editor\n' +
            'Kesediaannya untuk mengisi Hasil Pertemuan, Kesepakatan/tindak lanjut dan batas waktu. Terima kasih 🙏.\n\n' +
            'spreadsheet monitoring:\n' +
            'https://docs.google.com/spreadsheets/d/1Upnvup9_cULZVPwh280H6qNta4iZIZ-ChyvVyeI0AHI/edit?gid=1914370244#gid=1914370244\n\n' +
            '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
    },
    {
        name: 'Sistem Informasi Form (jumat)',
        cron: '0 9 * * 5-6',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
            '6285255232511-1478313137@g.us',
        ],
        message:
             'Assalamualaikum,\n' +
            'izin, Mohon bantuannya untuk mengisi Form Pendataan Sistem Informasi dengan ' +
            'memasukkan nama,profesi dan mengisi frekuensi penggunaan aplikasi pada link berikut :\n' +
            '📎 https://script.google.com/macros/s/AKfycbwedZaodNfH-kNUP-lhaLWrvdGkTWTDRa-LV6EOxS-_4rNmS_PyEylmWta79LImRWrcsw/exec\n\n' +
            'daftar nama yang belum/sudah mengisi\n' +
            'https://docs.google.com/spreadsheets/d/1Kpe1VSWhCTuiwVeXcHefFs-iD6Vt0mBYsUoO3bf272E/edit?gid=752893668#gid=752893668\n\n' +
            '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
    },
    {
        name: 'Presensi Istirahat Mulai',
        cron: '0 12 * * 1-4',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
        ],
        message:
            'Waktu istirahat dimulai sekarang 🕛\n' +
            'Silakan lakukan presensi istirahat\n\n' +
            '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
    },
    {
        name: 'Presensi Istirahat Selesai',
        cron: '30 12 * * 1-4',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
        ],
        message:
            'Waktu istirahat telah selesai 🕧\n' +
            'Silakan lakukan presensi kembali\n\n' +
            '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
    }
];

const activeJobs = [];

function initScheduledMessages() {
    SCHEDULED_MESSAGES.forEach((schedule) => {
        const job = cron.schedule(
            schedule.cron,
            async () => {
                if (botStatus !== 'connected' || !activeSock) {
                    console.log(`⏰ [${schedule.name}] Bot belum terhubung, pesan dilewati.`);
                    return;
                }

                console.log(`\n⏰ Menjalankan jadwal: ${schedule.name}`);

                for (const target of schedule.targets) {
                    try {
                        const text = schedule.handler
                            ? await schedule.handler()
                            : schedule.message;

                        await activeSock.sendMessage(target, { text });
                        console.log(
                            new Date().toLocaleTimeString(),
                            `- [${schedule.name}] Terkirim ke`,
                            target
                        );
                    } catch (err) {
                        console.log(
                            `❌ [${schedule.name}] Gagal kirim ke ${target}:`,
                            err?.message || err
                        );
                    }

                    if (schedule.targets.length > 1) {
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                }
            },
            {
                scheduled: true,
                timezone: schedule.timezone || 'Asia/Jakarta',
            }
        );

        activeJobs.push({ name: schedule.name, job });
        console.log(`✅ Jadwal aktif: [${schedule.name}] cron="${schedule.cron}" tz="${schedule.timezone || 'Asia/Jakarta'}"`);
    });
}

initScheduledMessages();

app.get('/api/schedules', (req, res) => {
    res.json(
        SCHEDULED_MESSAGES.map((s) => ({
            name: s.name,
            cron: s.cron,
            timezone: s.timezone,
            targets: s.targets,
            preview: s.handler
                ? '[dynamic handler]'
                : (s.message || '').substring(0, 60) + (s.message?.length > 60 ? '…' : ''),
        }))
    );
});

// ══════════════════════════════════════════════════════════════════
// ── Helper SKM ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// function formatSKMMessage(data) {
//     let msg = "📊 *Laporan Pengisian Form SKM Hari Ini*\n\n";
//     for (const [ruang, info] of Object.entries(data)) {
//         msg += `🏥 ${ruang}\n`;
//         msg += `Jumlah: ${info.Jumlah}\n `;
//         msg += `Target: ${info.Target}\n`;
//         msg += `Selisih: ${info.Selisih}\n`;
//         msg += `Capaian: ${info.Capaian}%\n\n`;
//     }
//     msg += "🔗 Link Dashboard SKM:\nhttps://docs.google.com/spreadsheets/d/1eG_dA_QBDKVolvXAzE3TjQJVzFi-sC3yoXHgcoZ-smY/edit?resourcekey=&pli=1&gid=494693158#gid=494693158\n";
//     msg += "🔗 Link Google Form SKM:\nhttps://docs.google.com/forms/d/e/1FAIpQLSdKxQssBB1o4yGq00NiJL3FJ-nPNg2nDEO2M8ikC3NqUOQVFQ/viewform?usp=dialog\n\n";
//     msg += "📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖";
//     return msg;
// }
function formatSKMMessage(data) {
    let msg = "📊 *Laporan Pengisian Form SKM Hari Ini*\n\n";
    for (const [ruang, info] of Object.entries(data.data)) {
        msg += `🏥 ${ruang}\n`;
        msg += `Jumlah: ${info.Jumlah}  |  Target: ${info.Target}  |  Selisih: ${info.Selisih}  |  Capaian: ${info.Capaian}%\n`;
    }
    msg += "\n📈 *Laporan Kumulatif Pengisian Form SKM*\n\n";
    for (const [ruang, info] of Object.entries(data.dataKumulatif)) {
        msg += `🏥 ${ruang}\n`;
        msg += `Jumlah: ${info.Jumlah}  |  Target: ${info.Target}  |  Selisih: ${info.Selisih}  |  Capaian: ${info.Capaian.toFixed(0)}%\n`;
    }
    msg += "\n🔗 Link Dashboard SKM:\nhttps://docs.google.com/spreadsheets/d/1eG_dA_QBDKVolvXAzE3TjQJVzFi-sC3yoXHgcoZ-smY/edit?resourcekey=&pli=1&gid=494693158#gid=494693158\n";
    msg += "🔗 Link Google Form SKM:\nhttps://docs.google.com/forms/d/e/1FAIpQLSdKxQssBB1o4yGq00NiJL3FJ-nPNg2nDEO2M8ikC3NqUOQVFQ/viewform?usp=dialog\n\n";
    msg += "📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖";
    return msg;
}

async function getDataSKM() {
    try {
        const response = await axios.get(
            'https://script.google.com/macros/s/AKfycbyJcJ4hXRB6QkI2T4m8KJkwR76kFfifBlIsSTce8EISdskwhe27FGfCiYYG5KRKWO-V/exec',
            { timeout: 10000 }
        );
        return { status: 'success', data: response.data, message: 'Data SKM berhasil diambil' };
    } catch (error) {
        console.error('Error fetching SKM data:', error.message);
        return { status: 'error', message: 'Gagal mengambil data SKM' };
    }
}

// ══════════════════════════════════════════════════════════════════
// ── startBot dengan guard anti-loop ───────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function startBot() {
    if (isConnecting) {
        console.log('⚠️ startBot dipanggil saat sudah connecting, diabaikan.');
        return;
    }
    isConnecting = true;

    cleanupSocket();
    console.log(`\n🔌 Memulai koneksi WhatsApp... (attempt ${reconnectAttempts + 1})`);

    let sock;
    try {
        // ── PERUBAHAN UTAMA: pakai single-file auth ────────────
        const { state, saveCreds } = await useSingleFileAuthState(AUTH_FILE);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
        });

        activeSock = sock;
        isConnecting = false;

        // ── Helper kirim pesan ─────────────────────────────────
        async function sendMessage(jid, message) {
            try {
                await sock.sendMessage(jid, { text: message });
                console.log(new Date().toLocaleTimeString(), '- Pesan terkirim ke', jid);
            } catch (err) {
                console.log('Gagal kirim pesan:', err?.message || err);
            }
        }

        // ── Event: connection update ───────────────────────────
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                botStatus = 'qr';
                currentQR = qr;
                console.log('\n--- QR Terminal (fallback) ---');
                qrcode.generate(qr, { small: true });
                console.log(`--- Atau buka: http://localhost:${PORT}/scan ---\n`);
            }

            if (connection === 'close') {
                botStatus = 'disconnected';
                currentQR = null;
                activeSock = null;

                if (botStatus === 'logging_out') return;

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                console.log(`🔌 Koneksi terputus. Status code: ${statusCode}`);

                if (isLoggedOut) {
                    console.log('🚪 Logged out dari WhatsApp. Hapus auth & minta QR baru.');
                    clearAuthFiles();
                    reconnectAttempts = 0;
                    setTimeout(() => startBot(), 2000);
                } else {
                    scheduleReconnect();
                }
            }

            if (connection === 'open') {
                botStatus = 'connected';
                currentQR = null;
                reconnectAttempts = 0;
                console.log('✅ Connected to WhatsApp!');
                console.log(`📁 Auth tersimpan di: ${AUTH_FILE}`);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // ── Event: pesan masuk ─────────────────────────────────
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages?.[0];
            if (!message) return;

            const from = message.key.remoteJid;
            let text = '';

            if (message.message?.conversation) {
                text = message.message.conversation;
            } else if (message.message?.extendedTextMessage?.text) {
                text = message.message.extendedTextMessage.text;
            } else {
                return;
            }

            const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const botIds = [sock?.authState?.creds?.me?.id, sock?.authState?.creds?.me?.lid, sock?.user?.id].filter(Boolean);
            const localOf = (jid) => (jid || '').split('@')[0].split(':')[0];
            const botLocals = new Set(botIds.map(localOf));
            const mentionsLocals = mentions.map(localOf);

            console.log('Pesan baru dari', from, '->', text);

            const cmd = text.toLowerCase().trim();

            if (from.endsWith('@g.us') && mentionsLocals.some(m => botLocals.has(m))) {
                await sendMessage(from, `Halo! Aku melihat kamu men-tag aku di grup. 😊`);
            } else if (cmd === '#puspa') {
                await sendMessage(from,
                    'berikut daftar perintah yang bisa digunakan:\n\n' +
                    '*#ping* untuk tes apakah bot masih aktif\n' +
                    '*#skm* untuk laporan pengisian google form SKM\n' +
                    '*#monitor* untuk link monitoring pertemuan\n' +
                    '*#laporan* untuk link laporan bulanan\n' +
                    '*#siform* untuk link form pendataan sistem informasi\n' +
                    '*#pantun* untuk mendapatkan pantun harian\n\n' +
                    '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
                );
            } else if (cmd === '#ping') {
                await sendMessage(from, 'Hidup!\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖');
            } else if (cmd === '#monitor') {
                await sendMessage(from,
                    'Izin mengirimkan link monitoring pertemuan:\n\n' +
                    '📎 https://docs.google.com/forms/d/e/1FAIpQLSfWi4KwZqbqZQIdbIo0Tkj3O27ypAs5CmzFMMExS5GBGKPlpA/viewform?usp=publish-editor\n' +
                    'Kesediaannya untuk mengisi Hasil Pertemuan, Kesepakatan/tindak lanjut dan batas waktu. Terima kasih 🙏.\n\n' +
                    'spreadsheet monitoring:\n' +
                    'https://docs.google.com/spreadsheets/d/1Upnvup9_cULZVPwh280H6qNta4iZIZ-ChyvVyeI0AHI/edit?gid=1914370244#gid=1914370244\n\n' +
                    '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
                );
            } else if (cmd === '#siform') {
                await sendMessage(from,
                    'Assalamualaikum,\n' +
                    'izin, Mohon bantuannya untuk mengisi Form Pendataan Sistem Informasi dengan ' +
                    'memasukkan nama,profesi dan mengisi frekuensi penggunaan aplikasi pada link berikut :\n' +
                    '📎 https://script.google.com/macros/s/AKfycbwedZaodNfH-kNUP-lhaLWrvdGkTWTDRa-LV6EOxS-_4rNmS_PyEylmWta79LImRWrcsw/exec\n\n' +
                    'daftar nama yang belum/sudah mengisi\n' +
                    'https://docs.google.com/spreadsheets/d/1Kpe1VSWhCTuiwVeXcHefFs-iD6Vt0mBYsUoO3bf272E/edit?gid=752893668#gid=752893668\n\n' +
                    '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
                );
            } else if (cmd === '#skm') {
                const dataSKM = await getDataSKM();
                if (dataSKM.status === 'success' && dataSKM.data) {
                    await sendMessage(from, formatSKMMessage(dataSKM.data));
                } else {
                    await sendMessage(from, '❌ Gagal mengambil data SKM. Coba lagi nanti.\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖');
                }
            } else if (cmd === '#laporan') {
                await sendMessage(from,
                    'Google Drive Laporan Bulanan:\n' +
                    'https://drive.google.com/drive/folders/1Yii33uc60VUvQJp4PLZRf9oxGP1MLkA2?hl=ID\n\n' +
                    '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
                );
            } else if (cmd === '#pantun') {
                const pantun = getPantunHariIni();
                await sendMessage(from, `🌅 *Selamat Pagi!*\n\n_${pantun}_\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖`);
            } else if (cmd === '#versi') {
                await sendMessage(from, 'Version: 1.0.5\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖');
            }
        });

    } catch (err) {
        console.error('❌ Gagal membuat socket:', err?.message || err);
        isConnecting = false;
        scheduleReconnect();
        return;
    }
}

// Mulai bot pertama kali
startBot();