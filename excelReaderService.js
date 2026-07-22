const XLSX = require("xlsx");

// Batas per-sheet dinaikkan jauh dari sebelumnya (6000 -> 40000 karakter).
// Nilai lama (6000) adalah penyebab utama data terpotong pada file dengan banyak
// baris/sheet (mis. siklus menu 5+ periode x puluhan hari), sehingga perbandingan
// antar-file jadi tidak lengkap. 40000 karakter cukup untuk ratusan baris data tabel,
// dan kalau masih terpotong, sekarang diberi PERINGATAN EKSPLISIT di teksnya (bukan
// dipotong diam-diam) supaya AI tahu datanya belum lengkap.
const MAX_CHARS_PER_SHEET = 40000;

/**
 * Reads and parses an Excel (.xlsx / .xls / .csv) file buffer into concise text per sheet
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {string} Formatted text representation of all sheets
 */
function parseExcelFileBuffer(buffer, filename = "document.xlsx") {
    try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        let resultText = `\n--- BERKAS EXCEL: ${filename} ---\n`;

        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            resultText += `\n[SHEET: "${sheetName}"]\n`;

            if (!jsonData || jsonData.length === 0) {
                resultText += "(Sheet kosong)\n";
                continue;
            }

            const sheetLines = jsonData
                .filter(row => Array.isArray(row) && row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== ""))
                .map(row => row.map(cell => String(cell || "").trim()).filter(Boolean).join(" | "))
                .filter(Boolean)
                .join("\n");

            if (sheetLines.length > MAX_CHARS_PER_SHEET) {
                resultText += sheetLines.substring(0, MAX_CHARS_PER_SHEET) +
                    `\n[!! PERINGATAN: Sheet "${sheetName}" terlalu besar, teks dipotong di karakter ke-${MAX_CHARS_PER_SHEET}. Data setelah titik ini TIDAK terbaca. Jangan simpulkan seolah data yang terpotong berarti "tidak ada". !!]\n`;
            } else {
                resultText += sheetLines + "\n";
            }
        }

        return resultText;
    } catch (err) {
        console.error("[ExcelReaderService] Error parsing Excel buffer:", err.message);
        return `\n--- BERKAS EXCEL: ${filename} (Gagal diparse: ${err.message}) ---\n`;
    }
}

// ============================================================================
// DETERMINISTIC CROSS-FILE DIFF ENGINE
// ============================================================================
// LLM tidak reliable untuk membandingkan ratusan baris data secara exhaustive
// (cenderung meringkas/sampling, bukan memproses SEMUA baris). Modul ini
// menghitung selisih data secara PASTI di level kode, lalu hasilnya disuntikkan
// ke prompt sebagai fakta yang sudah diverifikasi, bukan estimasi AI.
//
// Pendekatan ini sengaja dibuat GENERIK/agnostik terhadap struktur tabel (tidak
// mengasumsikan tabel flat atau pivot/matrix) dengan cara memindai SETIAP SEL,
// lalu memfilter nilai yang kemungkinan besar adalah label struktural (nama hari,
// nomor minggu, kategori yang berulang puluhan kali, dst) menggunakan heuristik
// frekuensi -- nilai yang muncul terlalu sering di banyak sel biasanya adalah
// header/kategori berulang, bukan nama item/menu/produk individual.

const STRUCTURAL_NOISE_PATTERNS = [
    /^hari\s*\d+$/i,
    /^minggu\s*(ke-?)?\s*\d+$/i,
    /^p\d+$/i,
    /^\d+$/,
    /^\d+([.,]\d+)?$/,
    /^siklus\s*menu/i,
    /^no\.?$/i,
    /^tanggal$/i
];

function isStructuralNoise(value) {
    const v = String(value).trim();
    if (v.length < 3) return true;
    return STRUCTURAL_NOISE_PATTERNS.some(p => p.test(v));
}

function normalizeItemName(value) {
    return String(value || "")
        .toLowerCase()
        .trim()
        .normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // hilangkan aksen
        .replace(/[().,\-_/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Jarak Levenshtein sederhana untuk fuzzy matching nama sheet (toleran typo kecil user). */
function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const currRow = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            currRow.push(Math.min(
                currRow[j - 1] + 1,      // insertion
                prevRow[j] + 1,          // deletion
                prevRow[j - 1] + cost    // substitution
            ));
        }
        prevRow = currRow;
    }
    return prevRow[b.length];
}

/**
 * Cek apakah nama sheet "cocok" dengan hint, toleran terhadap substring DAN typo
 * kecil (mis. "Noets Bahan Makanan" tetap cocok dengan "Notes Bahan Makanan").
 */
function sheetNameMatchesHint(sheetName, hint) {
    const s = sheetName.toLowerCase().trim();
    const h = hint.toLowerCase().trim();
    if (!h) return false;
    if (s.includes(h) || h.includes(s)) return true;

    const distance = levenshteinDistance(s, h);
    const maxLen = Math.max(s.length, h.length);
    const similarity = maxLen > 0 ? 1 - (distance / maxLen) : 0;
    return similarity >= 0.75; // toleransi typo ringan
}

/**
 * Memindai seluruh sel kandidat dari sheet-sheet dalam satu workbook, kecuali sheet
 * yang namanya cocok dengan excludeSheetNameHints.
 *
 * PENTING: baris pertama tiap sheet diasumsikan header dan dilewati (bukan data).
 * Tiap KOLOM dianalisis variasinya -- kolom dengan sedikit nilai unik yang berulang
 * terus-menerus (mis. kolom "Kategori Menu": Buah/Sayur/Lauk Hewani/...) dianggap
 * kolom label/kategori, BUKAN kolom nama item, dan dilewati. Ini jauh lebih akurat
 * daripada memfilter berdasar frekuensi kemunculan global, karena menu pada siklus
 * rotasi memang WAJAR berulang berkali-kali lintas minggu/periode -- frekuensi
 * tinggi bukan indikasi itu adalah label struktural.
 *
 * @returns {Array<{sheet, value, normalized}>}
 */
const LABEL_COLUMN_HEADER_HINTS = [
    "hari", "tanggal", "minggu", "periode", "no", "nomor", "id", "kode", "urutan", "tgl",
    "kategori", "jenis", "satuan", "unit", "harga", "qty", "jumlah", "keterangan"
];
const ITEM_COLUMN_HEADER_HINTS = ["nama", "menu", "produk", "item", "bahan"];

function extractCandidateItems(workbook, excludeSheetNameHints = []) {
    const excludeLower = excludeSheetNameHints
        .map(s => String(s || "").toLowerCase().trim())
        .filter(Boolean);

    const candidates = [];

    for (const sheetName of workbook.SheetNames) {
        if (excludeLower.some(ex => sheetNameMatchesHint(sheetName, ex))) continue;

        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (!rows || rows.length < 2) continue; // butuh minimal header + 1 baris data

        const headerRow = rows[0] || [];
        const bodyRows = rows.slice(1); // lewati baris header
        const numCols = rows.reduce((max, r) => Array.isArray(r) ? Math.max(max, r.length) : max, 0);

        // Analisis variasi tiap kolom untuk mendeteksi kolom kategori/label.
        const colIsCategorical = [];
        for (let c = 0; c < numCols; c++) {
            // (1) Kolom pertama & kolom yang headernya jelas menandakan label/ID
            // (Hari, Tanggal, Minggu, No, dst) selalu dilewati, apapun variasinya --
            // kolom seperti ini seringkali punya nilai unik per baris (mis. "Minggu 1
            // Hari 1", "Minggu 1 Hari 2", ...) sehingga tidak tertangkap heuristik
            // diversity di bawah.
            const headerText = String(headerRow[c] || "").toLowerCase().trim();
            const looksLikeItemHeader = ITEM_COLUMN_HEADER_HINTS.some(h => headerText.includes(h));
            const looksLikeLabelHeader = LABEL_COLUMN_HEADER_HINTS.some(h => headerText === h || headerText.startsWith(h));

            if (looksLikeLabelHeader) {
                // Sinyal kuat dari nama header (mis. "Kategori", "Satuan", "Hari") --
                // langsung dianggap kolom label, tak perlu cek variasi lagi.
                colIsCategorical[c] = true;
                continue;
            }
            if (looksLikeItemHeader) {
                // Sinyal kuat header eksplisit bilang ini kolom nama item (mis. "Nama
                // Menu") -- JANGAN pernah dianggap kategorikal walau datanya kebetulan
                // repetitif (menu yang sama bisa muncul berkali-kali dalam siklus).
                colIsCategorical[c] = false;
                continue;
            }
            if (c === 0) {
                // Kolom pertama tanpa header yang jelas: asumsikan label/ID (konvensi
                // spreadsheet paling umum), lebih aman daripada salah anggap item.
                colIsCategorical[c] = true;
                continue;
            }

            // Header ambigu/tidak ada -- fallback ke heuristik variasi: kolom dengan
            // sedikit nilai unik yang berulang terus (mis. kategori tanpa nama header
            // jelas) dianggap kolom label, bukan nama item.
            const values = [];
            for (const row of bodyRows) {
                const v = row?.[c];
                if (v === undefined || v === null) continue;
                const s = String(v).trim();
                if (!s || isStructuralNoise(s)) continue;
                values.push(normalizeItemName(s));
            }
            const distinctCount = new Set(values).size;
            const total = values.length;
            const ratio = total > 0 ? distinctCount / total : 0;
            colIsCategorical[c] = total >= 3 && distinctCount <= 8 && ratio <= 0.4;
        }

        for (const row of bodyRows) {
            if (!Array.isArray(row)) continue;
            for (let c = 0; c < row.length; c++) {
                if (colIsCategorical[c]) continue;
                const cell = row[c];
                if (cell === undefined || cell === null) continue;
                const str = String(cell).trim();
                if (!str || isStructuralNoise(str)) continue;

                candidates.push({ sheet: sheetName, value: str, normalized: normalizeItemName(str) });
            }
        }
    }

    return candidates;
}

/**
 * Membangun set referensi (nilai yang SUDAH terdaftar) dari satu atau beberapa
 * sheet acuan dalam sebuah workbook.
 */
function buildReferenceSet(workbook, sheetNameHints = []) {
    const hints = sheetNameHints.map(s => String(s || "").toLowerCase().trim()).filter(Boolean);
    let matchedSheets = [];

    if (hints.length > 0) {
        // Hint eksplisit diberikan (mis. user sebut "sheet Produk") -- HANYA cari itu.
        // Jangan jatuh ke fallback generik di workbook yang salah, karena bisa salah
        // pilih sheet referensi (mis. "Master Menu" ke-pick padahal maksudnya "Produk"
        // yang ada di file lain).
        matchedSheets = workbook.SheetNames.filter(name =>
            hints.some(h => sheetNameMatchesHint(name, h))
        );
    } else {
        // Tidak ada hint dari user -- baru pakai heuristik nama umum.
        const fallbackHints = ["produk", "master", "database", "referensi", "bahan baku", "item"];
        matchedSheets = workbook.SheetNames.filter(name =>
            fallbackHints.some(h => name.toLowerCase().includes(h))
        );
    }

    if (matchedSheets.length === 0) return null;

    const referenceSet = new Set();
    for (const sheetName of matchedSheets) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (!rows || rows.length < 2) continue;
        for (const row of rows.slice(1)) { // lewati baris header
            if (!Array.isArray(row)) continue;
            for (const cell of row) {
                if (cell === undefined || cell === null) continue;
                const str = String(cell).trim();
                if (!str || isStructuralNoise(str)) continue;
                referenceSet.add(normalizeItemName(str));
            }
        }
    }

    return { sheetNames: matchedSheets, set: referenceSet };
}

/**
 * Menghitung item yang ADA di file sumber tapi TIDAK ADA di file referensi.
 * Fully defensive: kalau gagal mendeteksi apapun, return null (index.js akan
 * fallback ke analisis LLM biasa tanpa hasil deterministik, tidak akan crash).
 *
 * @param {Array<{filename:string, buffer:Buffer}>} excelFiles
 * @param {Object} options
 * @param {string[]} options.excludeSheetNames - sheet yang dikecualikan dari sumber (mis. ["Notes Bahan Makanan", "Master Menu"])
 * @param {string[]} options.referenceSheetHints - nama sheet acuan (mis. ["Produk"])
 * @returns {{ referenceFile:string, referenceSheets:string[], missing: Array<{sheet,file,value}> } | null}
 */
function computeCrossFileMissingItems(excelFiles, options = {}) {
    try {
        const { excludeSheetNames = [], referenceSheetHints = [] } = options;
        if (!Array.isArray(excelFiles) || excelFiles.length < 2) return null;

        const workbooks = excelFiles.map(f => ({
            filename: f.filename,
            wb: XLSX.read(f.buffer, { type: "buffer" })
        }));

        // Cari file yang punya sheet referensi (mis. "Produk")
        let referenceInfo = null;
        let referenceFilename = null;
        for (const { filename, wb } of workbooks) {
            const ref = buildReferenceSet(wb, referenceSheetHints);
            if (ref && ref.set.size > 0) {
                referenceInfo = ref;
                referenceFilename = filename;
                break;
            }
        }

        if (!referenceInfo) return null;

        const missing = [];
        const seenNormalized = new Set();

        for (const { filename, wb } of workbooks) {
            if (filename === referenceFilename) continue;

            const candidates = extractCandidateItems(wb, excludeSheetNames);
            for (const c of candidates) {
                if (referenceInfo.set.has(c.normalized)) continue;
                if (seenNormalized.has(c.normalized)) continue; // dedupe lintas file/sheet
                seenNormalized.add(c.normalized);
                missing.push({ file: filename, sheet: c.sheet, value: c.value });
            }
        }

        return {
            referenceFile: referenceFilename,
            referenceSheets: referenceInfo.sheetNames,
            missing
        };
    } catch (err) {
        console.error("[ExcelReaderService] computeCrossFileMissingItems gagal:", err.message);
        return null;
    }
}

module.exports = {
    parseExcelFileBuffer,
    computeCrossFileMissingItems
};
