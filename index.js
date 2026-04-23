const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// ── Status global ──────────────────────────────────────────────
let botStatus = 'disconnected'; // 'disconnected' | 'qr' | 'connected' | 'logging_out'
let currentQR = null;           // raw QR string dari baileys
let activeSock = null;          // referensi socket aktif untuk logout

// ── Hapus folder auth_info beserta isinya ─────────────────────
function clearAuthFiles() {
    const authDir = path.join(__dirname, 'auth_info');
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('🗑️  auth_info dihapus.');
    }
}

// ── API polling untuk browser (tanpa socket.io) ────────────────
app.get('/api/status', (req, res) => {
    res.json({ status: botStatus, qr: currentQR });
});

// ── Endpoint logout ────────────────────────────────────────────
app.post('/api/logout', async (req, res) => {
    if (botStatus !== 'connected' || !activeSock) {
        // Belum connect, cukup hapus file auth saja lalu restart
        clearAuthFiles();
        botStatus = 'disconnected';
        currentQR = null;
        res.json({ ok: true, message: 'Auth dihapus, menunggu QR baru...' });
        startBot();
        return;
    }

    try {
        botStatus = 'logging_out';
        // Logout dari WhatsApp (server side)
        await activeSock.logout();
    } catch (err) {
        console.log('Logout error (diabaikan):', err?.message || err);
    }

    // Hapus semua file sesi
    clearAuthFiles();
    botStatus = 'disconnected';
    currentQR = null;
    activeSock = null;

    res.json({ ok: true, message: 'Logout berhasil, scan QR untuk akun baru.' });

    // Restart bot agar QR baru muncul
    setTimeout(() => startBot(), 1000);
});

app.get('/scan', (req, res) => {
    res.sendFile(path.join(__dirname, 'client', 'scan.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server berjalan di http://localhost:${PORT}`);
    console.log(`📱 Buka http://localhost:${PORT}/scan untuk scan QR\n`);
});

// ══════════════════════════════════════════════════════════════════
// ── FITUR PESAN TERJADWAL ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
//
// FORMAT NOMOR:
//   - Pribadi : '628123456789@s.whatsapp.net'
//   - Grup    : '1203xxx@g.us'  (ID grup dari WhatsApp)
//
// FORMAT JADWAL (cron expression) :
//   '0 7 * * *'   → setiap hari jam 07:00
//   '30 8 * * *'  → setiap hari jam 08:30
//   '0 9 * * 1'   → setiap Senin jam 09:00
//   '0 12 * * 1-5'→ Senin–Jumat jam 12:00
//   '0 7,12,17 * * *' → jam 07:00, 12:00, dan 17:00 setiap hari
//
// Tambahkan objek baru ke array SCHEDULED_MESSAGES untuk
// menambah jadwal baru tanpa mengubah kode lainnya.
// ──────────────────────────────────────────────────────────────────

const SCHEDULED_MESSAGES = [
    {
        name: 'Capaian pengisian google form SKM',
        cron: '45 11 * * 1-5',
        timezone: 'Asia/Makassar',
        targets: [
            // '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us', //wa andri
            // '6282252932135-1607859902@g.us',
            '6285255232511-1478313137@g.us',  //grup puspa
        ],
        // ✅ Gunakan handler async, bukan message statis
        handler: async () => {
            const dataSKM = await getDataSKM();
            if (dataSKM.status === 'success' && dataSKM.data) {
                return formatSKMMessage(dataSKM.data);
            }
            return '❌ Gagal mengambil data SKM. Coba lagi nanti.\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖';
        },
    },
    {
        name: 'Monitoring Pertemuan',                      // label (hanya untuk log)
        // cron: '0 7 * * 1-6',                         // Senin–Sabtu jam 15:00
        cron: '45 11 * * 1-5',                          // Senin–Jumat jam 11:45
        timezone: 'Asia/Makassar',
        targets: [
            // '6282255187877@s.whatsapp.net', //wa andri
            '120363407441452748@g.us', //wa andri
            // '6282252932135-1607859902@g.us',  //grup kaizen
            '6285255232511-1478313137@g.us',  //grup puspa
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
        name: 'Presensi Istirahat Mulai',
        cron: '0 12 * * 1-4',  // Senin–Kamis jam 12:00
        timezone: 'Asia/Makassar',
        targets: [
            // '6282255187877@s.whatsapp.net', //wa andri
            '120363407441452748@g.us', //wa andri
            // '6282252932135-1607859902@g.us',  //grup kaizen
            '6285255232511-1478313137@g.us',  //grup puspa
        ],
        message:
            'Waktu istirahat dimulai sekarang 🕛\n' +
            'Silakan lakukan presensi istirahat' +
            // 'https://docs.google.com/forms/d/e/1FAIpQLSxxxxx/viewform?usp=sf_link\n\n' +
            '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
    },
    {
        name: 'Presensi Istirahat Selesai',
        cron: '30 12 * * 1-4', // Senin–Kamis jam 12:30
        timezone: 'Asia/Makassar',
        targets: [
            // '6282255187877@s.whatsapp.net', //wa andri
            '120363407441452748@g.us', //wa andri
            // '6282252932135-1607859902@g.us',  //grup kaizen
            '6285255232511-1478313137@g.us',  //grup puspa
        ],
        message:
            'Waktu istirahat telah selesai 🕧\n' +
            'Silakan lakukan presensi kembali\n' +
            // 'https://docs.google.com/forms/d/e/1FAIpQLSxxxxx/viewform?usp=sf_link\n\n' +
            '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
    }
];

// const MESSAGE_TEMPLATES = [
//     {
//         name: '#puspa',
//         message:
//             'berikut daftar perintah yang bisa digunakan:\n\n' +
//             '*#ping* untuk tes apakah bot masih aktif\n' + 
//             '*#skm* untuk laporan pengisian google form SKM\n' +
//             '*#monitor* untuk link monitoring pertemuan\n\n' +
//             '*#laporan* untuk link laporan bulanan\n\n' +
//             '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
//     },
//     {
//         name: '#skm',
//         message:
//             'pengisian google form, hari ini dan keseluruhan\n\n' +
//             'berikut link dashboard pengisian google form SKM\n\n' +
//             'https://docs.google.com/spreadsheets/d/1eG_dA_QBDKVolvXAzE3TjQJVzFi-sC3yoXHgcoZ-smY/edit?resourcekey=&gid=494693158#gid=494693158\n\n' +
//             'beserta link google formnya\n\n' +
//             'https://docs.google.com/forms/d/e/1FAIpQLSdKxQssBB1o4yGq00NiJL3FJ-nPNg2nDEO2M8ikC3NqUOQVFQ/viewform?usp=dialog\n\n' +
//             '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
//     },
//     {
//         name: '#monitoring',
//         message:
//             'Izin mengirimkan link monitoring pertemuan:\n\n' +
//             '📎 https://docs.google.com/forms/d/e/1FAIpQLSfWi4KwZqbqZQIdbIo0Tkj3O27ypAs5CmzFMMExS5GBGKPlpA/viewform?usp=publish-editor\n' +
//             'Kesediaannya untuk mengisi Hasil Pertemuan, Kesepakatan/tindak lanjut dan batas waktu. Terima kasih 🙏.\n\n' +
//             'spreadsheet monitoring:\n' +
//             'https://docs.google.com/spreadsheets/d/1Upnvup9_cULZVPwh280H6qNta4iZIZ-ChyvVyeI0AHI/edit?gid=1914370244#gid=1914370244\n\n' +
//             '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
//     },
// ]

// ── Daftar aktif cron job (untuk stop/restart jika diperlukan) ─
const activeJobs = [];

// ── Fungsi inisialisasi semua jadwal ──────────────────────────
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
                        // ✅ Support handler (dynamic) dan message (static)
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

// Jalankan inisialisasi jadwal saat server mulai
initScheduledMessages();

// ── API: daftar jadwal aktif (opsional, untuk monitoring) ─────
// app.get('/api/schedules', (req, res) => {
//     res.json(
//         SCHEDULED_MESSAGES.map((s) => ({
//             name: s.name,
//             cron: s.cron,
//             timezone: s.timezone,
//             targets: s.targets,
//             preview: s.message.substring(0, 60) + (s.message.length > 60 ? '…' : ''),
//         }))
//     );
// });
app.get('/api/schedules', (req, res) => {
    res.json(
        SCHEDULED_MESSAGES.map((s) => ({
            name: s.name,
            cron: s.cron,
            timezone: s.timezone,
            targets: s.targets,
            // ✅ Cek apakah pakai handler atau message statis
            preview: s.handler
                ? '[dynamic handler]'
                : (s.message || '').substring(0, 60) + (s.message?.length > 60 ? '…' : ''),
        }))
    );
});

// ══════════════════════════════════════════════════════════════════
// ── Bot WhatsApp ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function formatSKMMessage(data) {
    let msg = "📊 *Laporan Pengisian Form SKM Hari Ini*\n\n";
    for (const [ruang, info] of Object.entries(data)) {
        msg += `🏥 ${ruang}\n`;
        msg += `Jumlah: ${info.Jumlah}\n`;
        msg += `Target: ${info.Target}\n`;
        msg += `Selisih: ${info.Selisih}\n`;
        msg += `Capaian: ${info.Capaian}%\n\n`;
    }
    msg += "🔗 Link Dashboard SKM:\nhttps://docs.google.com/spreadsheets/d/1eG_dA_QBDKVolvXAzE3TjQJVzFi-sC3yoXHgcoZ-smY/edit?resourcekey=&pli=1&gid=494693158#gid=494693158\n";
    msg += "🔗 Link Google Form SKM:\nhttps://docs.google.com/forms/d/e/1FAIpQLSdKxQssBB1o4yGq00NiJL3FJ-nPNg2nDEO2M8ikC3NqUOQVFQ/viewform?usp=dialog\n\n";
    msg += "📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖";
    return msg;
}

async function getDataSKM() {
    try {
        const response = await axios.get('https://script.google.com/macros/s/AKfycbyJcJ4hXRB6QkI2T4m8KJkwR76kFfifBlIsSTce8EISdskwhe27FGfCiYYG5KRKWO-V/exec');
        return { status: 'success', data: response.data.data, message: 'Data SKM berhasil diambil' };
    } catch (error) {
        console.error('Error fetching SKM data:', error);
        return { status: 'error', message: 'Gagal mengambil data SKM' };
    }
}


async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false  // dihandle manual di bawah
    });

    activeSock = sock; // simpan referensi global untuk logout

    async function sendMessage(jid, message) {
        try {
            await sock.sendMessage(jid, { text: message });
            console.log(new Date().toLocaleTimeString(), '- Pesan terkirim ke', jid);
        } catch (err) {
            console.log('Gagal kirim pesan:', err?.message || err);
        }
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            botStatus = 'qr';
            currentQR = qr;
            // Tetap tampil di terminal sebagai fallback
            console.log('\n--- QR Terminal (fallback) ---');
            qrcode.generate(qr, { small: true });
            console.log(`--- Atau buka: http://localhost:${PORT}/scan ---\n`);
        }

        if (connection === 'close') {
            // Jangan reconnect jika sedang proses logout manual
            if (botStatus === 'logging_out') return;
            botStatus = 'disconnected';
            currentQR = null;
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log('Koneksi terputus, mencoba reconnect...');
                startBot();
            } else {
                console.log('Logged out dari WhatsApp.');
                clearAuthFiles();
                setTimeout(() => startBot(), 1000);
            }
        }

        if (connection === 'open') {
            botStatus = 'connected';
            currentQR = null;
            console.log('✅ Connected to WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages?.[0];
        if (!message) return;

        const from = message.key.remoteJid;
        let text = '';

        if (message.message?.conversation) text = message.message.conversation;
        else if (message.message?.extendedTextMessage?.text) text = message.message.extendedTextMessage.text;
        else return;

        const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const botIds = [state?.creds?.me?.id, state?.creds?.me?.lid, sock?.user?.id].filter(Boolean);
        const localOf = (jid) => (jid || '').split('@')[0].split(':')[0];
        const botLocals = new Set(botIds.map(localOf));
        const mentionsLocals = mentions.map(localOf);

        console.log('Pesan baru dari', from, '->', text);

        if (from.endsWith('@g.us') && mentionsLocals.some(m => botLocals.has(m))) {
            await sendMessage(from, `Halo! Aku melihat kamu men-tag aku di grup. 😊`);
        }
        else if (text.toLowerCase() === '#puspa') {
            await sendMessage(from,
                'berikut daftar perintah yang bisa digunakan:\n\n' +
                '*#ping* untuk tes apakah bot masih aktif\n' + 
                '*#skm* untuk laporan pengisian google form SKM\n' +
                '*#monitor* untuk link monitoring pertemuan\n' +
                '*#laporan* untuk link laporan bulanan\n\n' +
                '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
            );
        }
        else if (text.toLowerCase() === '#ping') {
            await sendMessage(from, 
                'Hidup!\n\n' +
                "📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖"
            );
        }
        else if (text.toLowerCase() === '#monitor') {
            await sendMessage(from, 
                'Izin mengirimkan link monitoring pertemuan:\n\n' +
                '📎 https://docs.google.com/forms/d/e/1FAIpQLSfWi4KwZqbqZQIdbIo0Tkj3O27ypAs5CmzFMMExS5GBGKPlpA/viewform?usp=publish-editor\n' +
                'Kesediaannya untuk mengisi Hasil Pertemuan, Kesepakatan/tindak lanjut dan batas waktu. Terima kasih 🙏.\n\n' +
                'spreadsheet monitoring:\n' +
                'https://docs.google.com/spreadsheets/d/1Upnvup9_cULZVPwh280H6qNta4iZIZ-ChyvVyeI0AHI/edit?gid=1914370244#gid=1914370244\n\n' +
                '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
            );
        }
        else if (text.toLowerCase() === '#skm') {
            const dataSKM = await getDataSKM();
            if (dataSKM.status === 'success' && dataSKM.data) {
                await sendMessage(from, formatSKMMessage(dataSKM.data));
            } else {
                await sendMessage(from, '❌ Gagal mengambil data SKM. Coba lagi nanti.\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖');
            }
        }
        else if (text.toLowerCase() === '#laporan') {
            await sendMessage(from, 
                'Google Drive Laporan Bulanan:\n' +
                'https://docs.google.com/spreadsheets/d/1Upnvup9_cULZVPwh280H6qNta4iZIZ-ChyvVyeI0AHI/edit?gid=1914370244#gid=1914370244\n\n' +
                '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖',
            );
        }
        
        // else if (text.toLowerCase() === '#skm') {
        //     await getDataSKM()
        //     // console.log('Data SKM yang diambil:', dataSKM);
        //     await sendMessage(from,
        //         'capaian pengisian google form, hari ini dan keseluruhan\n\n' +
        //         'berikut link dashboard pengisian google form SKM\n' +
        //         'https://docs.google.com/spreadsheets/d/1eG_dA_QBDKVolvXAzE3TjQJVzFi-sC3yoXHgcoZ-smY/edit?resourcekey=&gid=494693158#gid=494693158\n\n' +
        //         'beserta link google formnya\n' +
        //         'https://docs.google.com/forms/d/e/1FAIpQLSdKxQssBB1o4yGq00NiJL3FJ-nPNg2nDEO2M8ikC3NqUOQVFQ/viewform?usp=dialog\n\n'+
        //         "📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖"
        //     );
        // }
        

    });
}

startBot();