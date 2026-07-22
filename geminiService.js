const axios = require("axios");
const { ConfigManager } = require("./configManager");

/**
 * Direct call to Google Gemini Official API using user's official GEMINI_API_KEY
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} temperature
 * @param {string} modelName Default: "gemini-flash-latest" (Google-maintained auto-updating
 *   alias, currently resolves to gemini-3.5-flash). NOTE: all Gemini 1.0/1.5 models were
 *   permanently shut down by Google and now return HTTP 404 -- do not hardcode "gemini-1.5-*".
 * @returns {Promise<string>}
 */
async function askGeminiDirect(messages, temperature = 0.2, modelName = "gemini-flash-latest") {
    const apiKey = ConfigManager.getApiKey("GEMINI_API_KEY");

    if (!apiKey) {
        throw new Error("GEMINI_API_KEY tidak ditemukan. Silakan atur dengan: `/setkey GEMINI_API_KEY <api_key>`");
    }

    const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

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
        maxOutputTokens: 1500
    };

    const response = await axios.post(
        `${endpointUrl}?key=${apiKey}`,
        payload,
        {
            headers: { "Content-Type": "application/json" },
            timeout: 25000
        }
    );

    const replyText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!replyText) {
        throw new Error(`Respon dari Google ${modelName} kosong.`);
    }

    return replyText;
}

module.exports = {
    askGeminiDirect
};
