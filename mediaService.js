const axios = require("axios");
const { ConfigManager } = require("./configManager");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";

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

module.exports = {
    transcribeAndSummarizeMedia
};
