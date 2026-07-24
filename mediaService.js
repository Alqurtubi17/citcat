const axios = require("axios");
const { ConfigManager } = require("./configManager");

// Alias resmi Google yang auto-update, bukan versi hardcoded. "gemini-1.5-pro" sudah
// dimatikan permanen oleh Google (semua request akan 404) sejak awal 2026.
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-latest:generateContent";

async function transcribeAndSummarizeMedia(buffer, mimeType = "audio/ogg") {
    const rawKeys = ConfigManager.getApiKey("GEMINI_API_KEY") || "";
    const apiKeys = rawKeys.split(/[\s,]+/).map(k => k.trim()).filter(Boolean);
    const openrouterKey = ConfigManager.getApiKey("OPENROUTER_API_KEY") || process.env.OPENROUTER_API_KEY;

    if (apiKeys.length === 0 && !openrouterKey) {
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

    const models = ["gemini-flash-latest", "gemini-pro-latest"];
    let lastError = null;
    let replyText = "";

    // 1. Try Google Direct API with key rotation & backoff retry
    for (const apiKey of apiKeys) {
        if (replyText) break;
        for (const model of models) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const response = await axios.post(
                        url,
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

                    replyText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
                    if (replyText) break;
                } catch (err) {
                    lastError = err;
                    const isRateLimit = err.response?.status === 429;
                    if (isRateLimit && attempt < 2) {
                        console.warn(`[Media Transcribe] ${model} hit 429 rate limit (attempt ${attempt}). Waiting 6s before retry...`);
                        await new Promise(res => setTimeout(res, 6000));
                    } else {
                        break;
                    }
                }
            }
            if (replyText) break;
        }
    }

    // 2. OpenRouter Multimodal Fallback if Direct API hit 429 or failed
    if (!replyText && openrouterKey) {
        console.warn("[Media Transcribe] Direct Google API failed/rate-limited. Attempting OpenRouter multimodal fallback...");
        const openrouterModels = ["google/gemini-2.5-flash", "google/gemini-flash-1.5"];
        for (const orModel of openrouterModels) {
            try {
                const response = await axios.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    {
                        model: orModel,
                        messages: [
                            {
                                role: "user",
                                content: [
                                    { type: "text", text: promptText },
                                    {
                                        type: "image_url",
                                        image_url: {
                                            url: `data:${mimeType};base64,${base64Data}`
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${openrouterKey}`,
                            "Content-Type": "application/json"
                        },
                        timeout: 180000
                    }
                );
                replyText = response.data?.choices?.[0]?.message?.content || "";
                if (replyText) break;
            } catch (orErr) {
                lastError = orErr;
            }
        }
    }

    if (!replyText) {
        if (lastError?.response?.status === 429) {
            throw new Error("Batas kuota gratis Google AI Studio (HTTP 429 Rate Limit) terlampaui. Harap tunggu 1-2 menit sebelum mencoba lagi, atau tambahkan API Key cadangan dipisah koma via `/setkey GEMINI_API_KEY key1,key2`.");
        }
        throw lastError || new Error("Gagal mendapatkan respons transkripsi dari model Gemini.");
    }

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

async function extractAndDownloadMediaFromUrl(url) {
    let playwright;
    try {
        playwright = require("playwright");
    } catch (err) {
        throw new Error("Modul Playwright belum terinstal di VM Anda. Jalankan perintah `npm install` dan `npx playwright install chromium` di server VM.");
    }
    const { chromium } = playwright;

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

        // Fetch direct media stream buffer using Playwright context.request to retain Zoom cookies & session tokens
        const response = await context.request.get(videoSrc, {
            headers: {
                "Referer": page.url(),
                "Range": "bytes=0-8000000"
            },
            timeout: 120000
        });

        if (!response.ok() && response.status() !== 206) {
            throw new Error(`Server media mengembalikan HTTP status ${response.status()}`);
        }

        const buffer = await response.body();
        const contentTypeHeader = response.headers()["content-type"] || "video/mp4";
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
