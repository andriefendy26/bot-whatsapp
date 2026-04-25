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
let botStatus = 'disconnected';
let currentQR = null;
let activeSock = null;

// ── Guard reconnect: cegah multiple instance berjalan bersamaan ─
let isConnecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000; // 5 detik

// ── Hapus folder auth_info beserta isinya ─────────────────────
function clearAuthFiles() {
    const authDir = path.join(__dirname, 'auth_info');
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('🗑️  auth_info dihapus.');
    }
}

// ── Hitung delay exponential backoff ──────────────────────────
function getReconnectDelay() {
    // 5s, 10s, 20s, 40s, ... maks 5 menit
    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 5 * 60 * 1000);
    return delay;
}

// ── Jadwalkan reconnect dengan delay ──────────────────────────
function scheduleReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`❌ Sudah mencoba reconnect ${MAX_RECONNECT_ATTEMPTS}x. Berhenti. Restart manual diperlukan.`);
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
        } catch (_) {
            // abaikan error saat cleanup
        }
        activeSock = null;
    }
}

// ── API polling untuk browser ──────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({ status: botStatus, qr: currentQR });
});

// ── Endpoint logout ────────────────────────────────────────────
app.post('/api/logout', async (req, res) => {
    // Batalkan reconnect yang sedang terjadwal
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
    "Bunga mawar tumbuh di halaman\nHarumnya semerbak menyapa pagi\nSemangat pagi jangan pudarkan\nBuat hari ini penuh prestasi tinggi",
    "Sarapan pagi roti dan teh manis\nMentari muncul menyinari jendela\nHari baru saatnya kerja dan kreatif\nSemua tugas selesai dengan rasa lega",
    "Pergi ke taman menatap hijau daun\nBurung terbang tinggi di langit biru\nJangan lupa tersenyum walau sempat kacau\nHari ini peluang baru menunggu kamu",
    "Ambil kopi panas di pagi hari\nAroma wangi membangkitkan semangat\nKerja cerdas mulai dari hati murni\nJadikan hari ini penuh berkat",
    "Jalan pagi menyeberang sungai kecil\nAir jernih mengalir menyejukkan jiwa\nHari ini kesempatan tak boleh dielak\nSemua target tercapai tanpa ragu dan was-was",
    "Burung merpati terbang di langit biru\nMenyapa pagi dengan riang dan damai\nSemangat bekerja jangan sampai redup\nHari ini peluang menanti untuk raih",
    "Embun pagi jatuh di daun segar\nMentari hangat menyinari halaman\nHari ini jangan biarkan malas datang\nBuat semangat terus menjadi teman",
    "Bunga melati harum di pagi hari\nTersenyum manis menyapa setiap hati\nKerja cerdas dimulai dari niat murni\nHari ini sukses pasti menanti",
    "Jalan-jalan pagi di taman kota\nBurung berkicau, daun menari di angin\nBangun semangat, jangan sampai terlupa\nHari ini penuh warna, jangan diam",
    "Minum teh panas di pagi yang sejuk\nSarapan roti manis menemani hati\nHari ini mari kita buat unik\nKerja dan tawa berpadu hari ini",
    "Mentari pagi menembus jendela\nSinar hangat membangkitkan semangat\nBangun pagi, hati jangan resah\nHari ini pasti penuh keberuntungan yang tepat",
    "Lihat kucing bermain di halaman\nMelompat-lompat penuh kegembiraan\nSemangat pagi jangan sampai hilang\nHari ini penuh tawa dan keceriaan",
    "Burung hantu sudah tidur di siang hari\nMenyisakan pagi dengan damai dan sepi\nBangun pagi dengan hati berseri\nHari ini pasti penuh prestasi dan arti",
    "Bunga tulip merekah indah di taman\nHarumnya menyebar sampai ke jalan\nMulai hari dengan hati yang tenang\nSemua rencana lancar tanpa beban",
    "Sarapan pagi ditemani kopi panas\nMentari pagi menyapa dengan lemah lembut\nHari ini jangan biarkan lelah membalas\nKerja cerdas, sukses pasti menunggu di depan",
    "Jalan pagi melihat matahari naik\nBurung berkicau riang di pohon rindang\nHari ini semangat jangan sampai layu dan kaku\nKerja dan tawa mari satukan langkah",
    "Ambil kue manis di tepi jalan\nAroma wangi menyapa setiap insan\nHari ini jangan biarkan lelah datang\nSemangat pagi mari terus digenggam",
    "Burung kecil terbang di pagi yang cerah\nMenyebar kabar bahagia tanpa lelah\nBangun pagi dengan hati yang cerah\nHari ini penuh semangat dan tawa meriah",
    "Embun pagi menetes di daun hijau\nMentari muncul memberi hangat yang nyata\nKerja dan senyum jangan sampai layu\nHari ini penuh cerita indah dan nyata",
    "Bunga mawar merah merekah indah\nHarumnya menyebar hingga ke jalan\nBangun pagi jangan sampai malas dan lelah\nHari ini penuh kesempatan yang menawan",
    "Pagi hari melihat embun menetes\nDaun hijau segar menyapa bumi\nBangun semangat, jangan sampai terlewat\nHari ini penuh peluang dan arti",
    "Minum kopi panas sambil tersenyum\nMentari hangat menyapa jendela\nKerja cerdas dimulai dari hati murni\nHari ini penuh cerita indah dan nyata",
    "Jalan pagi menyeberang jembatan kecil\nAir sungai mengalir menyejukkan jiwa\nMulai hari dengan tekad dan niat ikhlas\nHari ini sukses pasti menunggu di depan",
    "Bunga melati tumbuh di tepi halaman\nHarumnya semerbak menyebar luas\nSemangat pagi jangan sampai hilang\nHari ini penuh tawa dan canda yang manis",
    "Burung merpati terbang tinggi di langit\nMenyambut pagi dengan kicauan riang\nBangun pagi, hati jangan resah sedikitpun\nHari ini penuh energi dan semangat yang terang",
    "Mentari pagi menembus tirai jendela\nSinar hangat membangkitkan semangat\nKerja cerdas dimulai dari hati yang ikhlas\nHari ini semua rencana lancar tanpa hambatan",
    "Sarapan pagi dengan roti dan teh manis\nAngin sepoi membawa kesegaran\nHari ini mari kita jalani dengan tuntas\nKerja dan senyum berpadu tanpa keraguan",
    "Lari pagi di tepi taman kota\nBurung berkicau riang menyapa hari\nBangun semangat, jangan sampai terlupa\nHari ini penuh warna, peluang menanti",
    "Petik bunga mawar di tepi halaman\nHarumnya semerbak menyebar di pagi hari\nHari ini jangan biarkan malas datang\nSemangat kerja mari terus digenggam",
    "Jalan-jalan pagi menatap langit biru\nBurung terbang tinggi menyebar kabar bahagia\nBangun pagi dengan hati yang ceria\nHari ini penuh senyum dan energi yang nyata",
    "Ambil kopi panas di pagi hari\nAroma wangi membangkitkan semangat\nKerja cerdas mulai dari niat murni\nHari ini semua target pasti tercapai",
    "Mentari pagi muncul dari ufuk timur\nSinar hangat menyapa pepohonan\nBangun pagi dengan hati penuh syukur\nHari ini penuh keberkahan dan kesenangan",
    "Burung kecil bernyanyi riang di pagi hari\nDaun hijau menari diterpa angin sepoi\nMulai hari dengan hati penuh energi\nHari ini peluang baru menunggu untuk dijalani",
    "Embun pagi menetes di daun hijau segar\nMentari hangat menyinari taman kota\nKerja cerdas jangan sampai terlambat\nHari ini penuh tawa dan cerita yang indah",
    "Bunga tulip merekah indah di taman\nHarumnya menyebar hingga ke jalan\nBangun pagi dengan hati yang riang\nHari ini semua rencana lancar tanpa beban",
    "Sarapan pagi ditemani roti dan teh hangat\nMentari muncul hangat menyapa bumi\nHari ini jangan biarkan malas menghampiri\nSemangat pagi mari terus digenggam",
    "Jalan pagi menatap sungai mengalir\nAir jernih menyejukkan hati dan jiwa\nBangun semangat, jangan sampai redup\nHari ini penuh cerita indah dan nyata",
    "Burung hantu sudah tidur di siang hari\nMenyisakan pagi dengan damai dan sepi\nHari ini bangun dengan hati berseri\nKerja cerdas pasti membuahkan hasil yang berarti",
    "Petik bunga mawar merah di taman halaman\nHarumnya menyebar ke seluruh penjuru\nBangun pagi jangan sampai malas dan diam\nHari ini penuh kesempatan yang menawan",
    "Mentari pagi menembus pepohonan\nSinar hangat menyapa daun-daun hijau\nMulai hari dengan hati penuh semangat\nHari ini semua rencana pasti berjalan lancar",
    "Minum teh hangat sambil tersenyum manis\nBurung berkicau riang di pagi hari\nKerja cerdas dimulai dari niat yang tulus\nHari ini penuh tawa, energi, dan bahagia",
    "Jalan pagi menyeberang jembatan kecil\nAir mengalir menyejukkan jiwa yang lelah\nBangun pagi dengan hati yang bersih\nHari ini penuh peluang dan cerita yang indah",
    "Bunga mawar merekah di tepi halaman\nHarumnya menyebar sampai ke jalan\nHari ini semangat jangan sampai pudar\nKerja dan tawa berpadu menjadi satu",
    "Mentari pagi muncul dari ufuk timur\nSinar hangat membangkitkan energi dan hati\nBangun pagi dengan semangat penuh syukur\nHari ini peluang baru menunggu untuk dijalani",
    "Burung merpati terbang tinggi menyapa pagi\nMenyebar kabar bahagia di udara\nHari ini jangan biarkan malas menghampiri\nSemua target pasti tercapai tanpa ragu",
    "Embun pagi jatuh di daun segar\nMentari hangat menyinari halaman rumah\nBangun semangat, jangan biarkan redup\nHari ini penuh cerita indah dan keberhasilan",
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
        name: 'Pantun Pagi',
        cron: '0 7 * * 1-6',
        timezone: 'Asia/Makassar',
        targets: [
            '6282255187877@s.whatsapp.net',
            '120363407441452748@g.us',
            '6285255232511-1478313137@g.us',
        ],
        handler: async () => {
            const pantun = getPantunHariIni();
            return `🌅 *Selamat Pagi!*\n\n_${pantun}_\n\n📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖`;
        },
    },
    {
        name: 'Capaian pengisian google form SKM',
        cron: '45 11 * * 1-4',
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
        cron: '30 10 * * 5-6',
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
        const response = await axios.get(
            'https://script.google.com/macros/s/AKfycbyJcJ4hXRB6QkI2T4m8KJkwR76kFfifBlIsSTce8EISdskwhe27FGfCiYYG5KRKWO-V/exec',
            { timeout: 10000 }
        );
        return { status: 'success', data: response.data.data, message: 'Data SKM berhasil diambil' };
    } catch (error) {
        console.error('Error fetching SKM data:', error.message);
        return { status: 'error', message: 'Gagal mengambil data SKM' };
    }
}

// ══════════════════════════════════════════════════════════════════
// ── startBot dengan guard anti-loop ───────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function startBot() {
    // ── GUARD: cegah multiple instance ────────────────────────
    if (isConnecting) {
        console.log('⚠️  startBot dipanggil saat sudah connecting, diabaikan.');
        return;
    }
    isConnecting = true;

    // Bersihkan socket lama sebelum membuat yang baru
    cleanupSocket();

    console.log(`\n🔌 Memulai koneksi WhatsApp... (attempt ${reconnectAttempts + 1})`);

    let sock;
    try {
        var { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            // Batasi retry internal baileys agar tidak fork berlebihan
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
        });
    } catch (err) {
        console.error('❌ Gagal membuat socket:', err?.message || err);
        isConnecting = false;
        scheduleReconnect();
        return;
    }

    activeSock = sock;
    isConnecting = false; // socket sudah dibuat, biarkan event handler yang urus selanjutnya

    // ── Helper kirim pesan ─────────────────────────────────────
    async function sendMessage(jid, message) {
        try {
            await sock.sendMessage(jid, { text: message });
            console.log(new Date().toLocaleTimeString(), '- Pesan terkirim ke', jid);
        } catch (err) {
            console.log('Gagal kirim pesan:', err?.message || err);
        }
    }

    // ── Event: connection update ───────────────────────────────
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

            // Jangan reconnect saat proses logout manual
            if (botStatus === 'logging_out') return;

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            console.log(`🔌 Koneksi terputus. Status code: ${statusCode}`);

            if (isLoggedOut) {
                console.log('🚪 Logged out dari WhatsApp. Hapus auth & minta QR baru.');
                clearAuthFiles();
                reconnectAttempts = 0;
                // Tunggu sebentar lalu minta QR baru
                setTimeout(() => startBot(), 2000);
            } else {
                // Koneksi terputus karena jaringan/server — gunakan backoff
                scheduleReconnect();
            }
        }

        if (connection === 'open') {
            botStatus = 'connected';
            currentQR = null;
            // Reset counter setelah berhasil connect
            reconnectAttempts = 0;
            console.log('✅ Connected to WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Event: pesan masuk ─────────────────────────────────────
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
                '*#laporan* untuk link laporan bulanan\n\n' +
                '*#pantun* untuk mendapatkan pantun harian\n\n' +
                '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
            );
        } else if (cmd === '#ping') {
            await sendMessage(from,
                'Hidup!\n\n' +
                '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
            );
        } else if (cmd === '#monitor') {
            await sendMessage(from,
                'Izin mengirimkan link monitoring pertemuan:\n\n' +
                '📎 https://docs.google.com/forms/d/e/1FAIpQLSfWi4KwZqbqZQIdbIo0Tkj3O27ypAs5CmzFMMExS5GBGKPlpA/viewform?usp=publish-editor\n' +
                'Kesediaannya untuk mengisi Hasil Pertemuan, Kesepakatan/tindak lanjut dan batas waktu. Terima kasih 🙏.\n\n' +
                'spreadsheet monitoring:\n' +
                'https://docs.google.com/spreadsheets/d/1Upnvup9_cULZVPwh280H6qNta4iZIZ-ChyvVyeI0AHI/edit?gid=1914370244#gid=1914370244\n\n' +
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
            await sendMessage(from,
                'Version: 1.0.2\n\n' +
                '📌 Pesan otomatis dikirim oleh *Bot-PUSPA* 🤖'
            );
        }
    });
}

// Mulai bot pertama kali
startBot();