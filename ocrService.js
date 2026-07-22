const axios = require("axios");
const { ConfigManager } = require("./configManager");

// Alias resmi Google yang auto-update, bukan versi hardcoded. "gemini-1.5-flash" sudah
// dimatikan permanen oleh Google (semua request akan 404) sejak awal 2026.
const GEMINI_VISION_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

async function processImageOcr(buffer, mimeType = "image/jpeg", userInstruction = "") {
    const apiKey = ConfigManager.getApiKey("GEMINI_API_KEY");

    if (!apiKey) {
        throw new Error("GEMINI_API_KEY belum dikonfigurasi. Silakan atur dengan perintah:\n`/setkey GEMINI_API_KEY <api_key_anda>`");
    }

    const base64Data = buffer.toString("base64");

    // Retrieve Uteke Memory Context for OCR
    const recalledMemories = ConfigManager.loadConfig() ? require("./memory").MemoryManager.recallMemories("global", userInstruction) : [];
    let utekeContext = "";
    if (recalledMemories && recalledMemories.length > 0) {
        utekeContext = recalledMemories.map(m => `• ${m.text}`).join("\n");
    }

    const promptText = `Kamu adalah AI Vision OCR & Document Data Extraction Specialist Profesional.
Tolong baca dan analisis gambar/foto/dokumen terlampir secara presisi tinggi.

${utekeContext ? `INGATAN JANGKA PANJANG PENTING PENGGUNA:\n${utekeContext}\n` : ""}

Instruksi Tambahan Pengguna: ${userInstruction || "Ekstrak seluruh teks dan tabel data secara akurat."}

Langkah Tugas:
1. EKSTRAKSI TEKS LENGKAP (OCR): Tuliskan seluruh teks yang terbaca pada gambar dengan rapi.
2. EKSTRAKSI TABEL (JIKA ADA): Jika ada tabel/data kolom (kuitansi, invoice, daftar nama/angka, laporan), ekstrak tabel tersebut dalam format JSON ARRAY murni yang valid di dalam tag:
---JSON_TABLE_START---
[
  {"No": 1, "Item": "Produk A", "Harga": "10000"}
]
---JSON_TABLE_END---
Jika tidak ada tabel, buatkan data baris-berbaris yang rapi.`;

    const response = await axios.post(
        `${GEMINI_VISION_URL}?key=${apiKey}`,
        {
            contents: [
                {
                    parts: [
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data: base64Data
                            }
                        },
                        { text: promptText }
                    ]
                }
            ]
        },
        {
            headers: { "Content-Type": "application/json" },
            timeout: 120000
        }
    );

    const replyText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const jsonMatch = replyText.match(/---JSON_TABLE_START---([\s\S]*?)---JSON_TABLE_END---/i);
    let extractedTableData = null;

    if (jsonMatch) {
        try {
            const jsonStr = jsonMatch[1].trim();
            extractedTableData = JSON.parse(jsonStr);
        } catch (err) {
            console.warn("[OcrService] Gagal parse JSON table:", err.message);
        }
    }

    const cleanOcrText = replyText
        .replace(/---JSON_TABLE_START---[\s\S]*?---JSON_TABLE_END---/gi, "")
        .trim();

    return {
        ocrText: cleanOcrText || replyText,
        tableData: extractedTableData,
        rawReply: replyText
    };
}

module.exports = {
    processImageOcr
};
