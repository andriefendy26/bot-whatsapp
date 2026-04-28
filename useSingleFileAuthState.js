/**
 * useSingleFileAuthState.js
 *
 * Pengganti useMultiFileAuthState dari Baileys yang hemat inode.
 * Semua credentials & keys disimpan dalam SATU file JSON saja.
 *
 * Cara pakai (di bot.js / index.js):
 *   const { useSingleFileAuthState } = require('./useSingleFileAuthState');
 *   const { state, saveCreds } = await useSingleFileAuthState('./auth_info.json');
 */

const fs = require('fs');
const path = require('path');
const { initAuthCreds, BufferJSON } = require('baileys');

/**
 * Baca file JSON auth. Jika tidak ada atau rusak, kembalikan null.
 */
function readAuthFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw, BufferJSON.reviver);
    } catch {
        // File rusak / tidak valid JSON → anggap tidak ada
        return null;
    }
}

/**
 * Tulis file JSON auth secara atomic (tulis ke .tmp dulu, lalu rename)
 * supaya file tidak corrupt jika proses mati di tengah penulisan.
 */
function writeAuthFile(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, BufferJSON.replacer, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
}

/**
 * useSingleFileAuthState
 *
 * @param {string} filePath  Path ke file JSON auth (misal: './auth_info.json')
 * @returns {{ state: import('baileys').AuthenticationState, saveCreds: () => void }}
 */
async function useSingleFileAuthState(filePath) {
    // Normalisasi path
    filePath = path.resolve(filePath);

    // Baca data yang sudah ada, atau buat baru
    let authData = readAuthFile(filePath);

    if (!authData) {
        authData = {
            creds: initAuthCreds(),
            keys: {},
        };
    }

    const state = {
        creds: authData.creds,

        // Baileys memanggil state.keys untuk baca/tulis signal keys
        keys: {
            get(type, ids) {
                const data = {};
                for (const id of ids) {
                    const val = authData.keys?.[type]?.[id];
                    // Baileys mengharapkan undefined jika tidak ada, bukan null
                    if (val !== undefined) data[id] = val;
                }
                return data;
            },

            set(data) {
                for (const [type, entries] of Object.entries(data)) {
                    if (!authData.keys[type]) authData.keys[type] = {};
                    for (const [id, val] of Object.entries(entries)) {
                        if (val === null || val === undefined) {
                            // Hapus key yang di-null-kan Baileys
                            delete authData.keys[type][id];
                        } else {
                            authData.keys[type][id] = val;
                        }
                    }
                }
                // Simpan langsung setelah set keys supaya tidak hilang
                writeAuthFile(filePath, authData);
            },
        },
    };

    /**
     * saveCreds dipanggil Baileys setiap kali credentials berubah
     * (misalnya setelah QR scan berhasil).
     */
    function saveCreds() {
        authData.creds = state.creds;
        writeAuthFile(filePath, authData);
    }

    return { state, saveCreds };
}

/**
 * Hapus file auth (pengganti clearAuthFiles yang hapus seluruh folder).
 * Hanya menghapus 1 file.
 */
function clearSingleAuthFile(filePath) {
    filePath = path.resolve(filePath);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('🗑️  Auth file dihapus:', filePath);
    }
    // Hapus juga .tmp jika ada
    const tmp = filePath + '.tmp';
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
}

module.exports = { useSingleFileAuthState, clearSingleAuthFile };