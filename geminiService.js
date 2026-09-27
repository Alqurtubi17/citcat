const axios = require("axios");
const { ConfigManager } = require("./configManager");

/**
 * Direct call to Google Gemini Official API using user's official GEMINI_API_KEY
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} temperature
 * @param {string} modelName Default: "gemini-flash-latest" (Google-maintained auto-updating
 *   alias, currently resolves to gemini-3.5-flash). NOTE: all Gemini 1.0/1.5 models were
 *   permanently shut down by Google and now return HTTP 404 -- do not hardcode "gemini-1.5-*".
 * @param {number} maxOutputTokens Default 1500. Dinaikkan oleh pemanggil untuk jawaban
 *   panjang/terstruktur (mis. tabel perbandingan Excel) supaya tidak terpotong.
 * @returns {Promise<string>}
 */
const GEMINI_ACTIVE_MODELS = [
    "gemini-flash-lite-latest",
    "gemini-flash-latest"
];

/**
 * Direct call to Google Gemini Official API using user's official GEMINI_API_KEY
 * Automatically falls back between active models if one fails with 404, 429, or 503.
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} temperature
 * @param {string} modelName
 * @param {number} maxOutputTokens
 * @returns {Promise<string>}
 */
let currentKeyIndex = 0;

function getOrderedApiKeys() {
    const keys = ConfigManager.getGeminiApiKeys();
    if (keys.length <= 1) return keys;
    // Rotate starting key (Round-Robin) to distribute traffic evenly
    const startIndex = currentKeyIndex % keys.length;
    currentKeyIndex = (currentKeyIndex + 1) % keys.length;
    return [...keys.slice(startIndex), ...keys.slice(0, startIndex)];
}

async function askGeminiDirect(messages, temperature = 0.2, modelName = "gemini-flash-lite-latest", maxOutputTokens = 1500) {
    const candidateKeys = getOrderedApiKeys();

    if (candidateKeys.length === 0) {
        throw new Error("GEMINI_API_KEY tidak ditemukan. Silakan atur dengan: `/setkey GEMINI_API_KEY <api_key>`");
    }

    // Format chat history into Gemini contents payload
    const contents = [];
    let systemInstructionText = "";

    for (const msg of messages) {
        if (msg.role === "system") {
            systemInstructionText += msg.content + "\n";
        } else if (msg.role === "user") {
            contents.push({
                role: "user",
                parts: [{ text: msg.content }]
            });
        } else if (msg.role === "assistant") {
            contents.push({
                role: "model",
                parts: [{ text: msg.content }]
            });
        }
    }

    const payload = {
        contents: contents
    };

    if (systemInstructionText) {
        payload.system_instruction = {
            parts: [{ text: systemInstructionText }]
        };
    }

    payload.generationConfig = {
        temperature: temperature,
        maxOutputTokens: maxOutputTokens
    };

    // Candidates: primary requested model first, followed by active fallbacks
    const candidateModels = [modelName, ...GEMINI_ACTIVE_MODELS.filter(m => m !== modelName)];
    let lastErr = null;

    // Multi-key pool rotation & rate-limit auto-failover
    for (const apiKey of candidateKeys) {
        const maskedKey = apiKey.length > 8 ? `...${apiKey.slice(-4)}` : "key";
        for (const currentModel of candidateModels) {
            const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`;
            try {
                const response = await axios.post(
                    `${endpointUrl}?key=${apiKey}`,
                    payload,
                    {
                        headers: { "Content-Type": "application/json" },
                        timeout: 8000
                    }
                );

                const replyText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (replyText) {
                    return replyText;
                }
            } catch (err) {
                lastErr = err;
                const status = err.response?.status;
                if (status === 429) {
                    console.warn(`[Gemini Direct] API Key (${maskedKey}) terkena Rate Limit (429). Beralih ke API Key berikutnya...`);
                    // Break model loop to try next API key in the pool immediately!
                    break;
                }
                if (status === 400 || status === 401) {
                    console.warn(`[Gemini Direct] API Key (${maskedKey}) tidak valid / unauthorized (${status}). Mencoba key lain...`);
                    break;
                }
                // For 404, 503, try next candidate model on same key
                console.warn(`[Gemini Direct] Model ${currentModel} on key ${maskedKey} returned ${status || err.message}. Mencoba model alternatif...`);
            }
        }
    }

    throw lastErr || new Error("Semua model dan API Key Google Gemini gagal merespons.");
}

module.exports = {
    askGeminiDirect
};
