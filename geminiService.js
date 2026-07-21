const axios = require("axios");
const { ConfigManager } = require("./configManager");

const GEMINI_DIRECT_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";

/**
 * Direct call to Google Gemini 1.5 Pro API using user's official GEMINI_API_KEY
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} temperature
 * @returns {Promise<string>}
 */
async function askGeminiDirect(messages, temperature = 0.2) {
    const apiKey = ConfigManager.getApiKey("GEMINI_API_KEY");

    if (!apiKey) {
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
        maxOutputTokens: 2048
    };

    const response = await axios.post(
        `${GEMINI_DIRECT_URL}?key=${apiKey}`,
        payload,
        {
            headers: { "Content-Type": "application/json" },
            timeout: 45000
        }
    );

    const replyText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!replyText) {
        throw new Error("Respon dari Google Gemini 1.5 Pro kosong.");
    }

    return replyText;
}

module.exports = {
    askGeminiDirect
};
