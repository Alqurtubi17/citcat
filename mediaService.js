const axios = require("axios");
const { ConfigManager } = require("./configManager");

// Alias resmi Google yang auto-update, bukan versi hardcoded. "gemini-1.5-pro" sudah
// dimatikan permanen oleh Google (semua request akan 404) sejak awal 2026.
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent";

async function transcribeAndSummarizeMedia(buffer, mimeType = "audio/ogg") {
    const apiKey = ConfigManager.getApiKey("GEMINI_API_KEY");

    if (!apiKey) {
        throw new Error("GEMINI_API_KEY belum dikonfigurasi. Silakan atur dengan perintah:\n`/setkey GEMINI_API_KEY <api_key_anda>`");
    }

    const base64Data = buffer.toString("base64");

    // Retrieve Uteke Memory Context for transcription/media summaries
    const recalledMemories = ConfigManager.loadConfig() ? require("./memory").MemoryManager.recallMemories("global", "media") : [];
    let utekeContext = "";
    if (recalledMemories && recalledMemories.length > 0) {
        utekeContext = recalledMemories.map(m => `• ${m.text}`).join("\n");
    }

    const promptText = `Kamu adalah AI Transcriber & Summarizer Profesional.
Tolong olah berkas media (suara/audio/video) terlampir:

${utekeContext ? `INGATAN JANGKA PANJANG PENTING PENGGUNA:\n${utekeContext}\n` : ""}

1. Buatkan TRANSKRIP LENGKAP secara utuh dan akurat dalam Bahasa Indonesia.
2. Buatkan RANGKUMAN INTI yang terstruktur (poin utama, ide penting, dan kesimpulan).

Wajib gunakan pemisah tag ini secara tepat:
---TRANSKRIP_AWAL---
(Tulis seluruh transkrip lengkap kata-demi-kata di sini)
---TRANSKRIP_AKHIR---

---RANGKUMAN_AWAL---
(Tulis rangkuman inti terstruktur di sini)
---RANGKUMAN_AKHIR---`;

    const response = await axios.post(
        `${GEMINI_URL}?key=${apiKey}`,
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
            timeout: 180000
        }
    );

    const replyText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const transcriptMatch = replyText.match(/---TRANSKRIP_AWAL---([\s\S]*?)---TRANSKRIP_AKHIR---/i);
    const summaryMatch = replyText.match(/---RANGKUMAN_AWAL---([\s\S]*?)---RANGKUMAN_AKHIR---/i);

    const fullTranscript = transcriptMatch ? transcriptMatch[1].trim() : replyText;
    const coreSummary = summaryMatch ? summaryMatch[1].trim() : "Rangkuman inti terlampir dalam transkrip.";

    return {
        fullTranscript,
        coreSummary,
        rawReply: replyText
    };
}

const { chromium } = require("playwright");

async function extractAndDownloadMediaFromUrl(url) {
    let browser = null;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
        });
        const context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport: { width: 1280, height: 720 }
        });

        const page = await context.newPage();
        await page.goto(url, { waitUntil: "networkidle", timeout: 35000 });

        // Extract video or audio element src URL from page DOM
        const videoSrc = await page.evaluate(() => {
            const v = document.querySelector("video") || document.querySelector("audio");
            if (v) {
                return v.src || v.querySelector("source")?.src || null;
            }
            return null;
        });

        if (!videoSrc) {
            throw new Error("Tidak menemukan elemen media video/audio pada halaman web ini. Tautan mungkin diproteksi kata sandi atau membutuhkan login.");
        }

        // Fetch direct media stream buffer
        const response = await axios.get(videoSrc, {
            responseType: "arraybuffer",
            timeout: 180000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Referer": url
            }
        });

        const buffer = Buffer.from(response.data);
        const contentTypeHeader = response.headers["content-type"] || "video/mp4";
        const mimeType = contentTypeHeader.split(";")[0].trim();

        return {
            buffer,
            mimeType,
            videoSrc
        };
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

module.exports = {
    transcribeAndSummarizeMedia,
    extractAndDownloadMediaFromUrl
};
