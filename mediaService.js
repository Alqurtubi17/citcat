const axios = require("axios");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";

async function transcribeAndSummarizeMedia(buffer, mimeType = "audio/ogg") {
    if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY belum dikonfigurasi di file .env. Mohon isi GEMINI_API_KEY terlebih dahulu.");
    }

    const base64Data = buffer.toString("base64");

    const promptText = `Kamu adalah AI Transcriber & Summarizer Profesional.
Tolong olah berkas media (suara/audio/video) terlampir:

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
        `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
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
            timeout: 180000 // 3 minutes for media transcription
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
