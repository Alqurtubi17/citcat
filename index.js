require("dotenv").config();

const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { Telegraf } = require("telegraf");

const { MemoryManager } = require("./memory");
const { searchWeb } = require("./search");

const chatAgent = require("./agents/chat");
const codingAgent = require("./agents/coding");
const researchAgent = require("./agents/research");
const devopsAgent = require("./agents/devops");

const CONFIG = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    MODEL_CHAIN: [
        process.env.MODEL || "openai/gpt-oss-20b:free",
        "google/gemma-4-26b-a4b-it:free",
        "google/gemma-4-31b-it:free",
        "cohere/north-mini-code:free"
    ],
    OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
    LIMITS: {
        MAX_INPUT_LENGTH: 2000,
        MAX_OUTPUT_LENGTH: 4000,
        MAX_SEARCH_RESULTS: 15,
        MAX_TOKENS_GEN: 1500
    },
    TIMEOUTS: {
        ROUTER_MS: 5000,
        OPENROUTER_MS: 30000,
        FETCH_MS: 8000
    }
};

class Logger {
    static info(message, ...args) {
        console.log(`[INFO] [${new Date().toISOString()}] ${message}`, ...args);
    }

    static warn(message, ...args) {
        console.warn(`[WARN] [${new Date().toISOString()}] ${message}`, ...args);
    }

    static error(message, ...args) {
        console.error(`[ERROR] [${new Date().toISOString()}] ${message}`, ...args);
    }
}

class TextSanitizer {
    static sanitizeInput(text) {
        if (!text) return "";
        return text
            .substring(0, CONFIG.LIMITS.MAX_INPUT_LENGTH)
            .trim()
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    }

    static sanitizeOutput(text) {
        if (!text) return "";

        let cleaned = text
            .replace(/<think>[\s\S]*?<\/think>/gi, "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]*>?/gm, "")
            .replace(/[\u4e00-\u9fa5]+/g, "")
            .replace(/\\\[([\s\S]*?)\\]/g, "$1")
            .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
            .trim();

        if (cleaned.length > CONFIG.LIMITS.MAX_OUTPUT_LENGTH) {
            cleaned = cleaned.substring(0, CONFIG.LIMITS.MAX_OUTPUT_LENGTH - 60) +
                "\n\n*(Jawaban dipotong karena batas panjang pesan)*";
        }

        return cleaned;
    }

    static convertTablesToBullets(text) {
        if (!text || !text.includes("|")) return text;

        const lines = text.split("\n");
        let inTable = false;
        let headers = [];
        const formattedLines = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
                const cells = trimmed.split("|").map(c => c.trim()).filter(Boolean);

                if (cells.every(c => /^:?-+:?$/.test(c))) {
                    continue;
                }

                if (!inTable) {
                    inTable = true;
                    headers = cells;
                } else {
                    const rowText = headers.length === cells.length
                        ? cells.map((cell, idx) => `*${headers[idx]}:* ${cell}`).join(" | ")
                        : cells.join(" - ");
                    formattedLines.push(`• ${rowText}`);
                }
            } else {
                inTable = false;
                headers = [];
                formattedLines.push(line);
            }
        }

        return formattedLines.join("\n");
    }
}

class DocumentService {
    static extractUrls(text) {
        if (!text) return [];
        const matches = text.match(/https?:\/\/\S+/gi);
        return matches ? [...new Set(matches)] : [];
    }

    static async fetchUrlContent(url) {
        try {
            Logger.info(`Fetching document/URL: ${url}`);
            const isPdf = url.toLowerCase().includes(".pdf");
            const response = await axios.get(url, {
                timeout: CONFIG.TIMEOUTS.FETCH_MS,
                responseType: isPdf ? "arraybuffer" : "text",
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            });

            if (isPdf || Buffer.isBuffer(response.data)) {
                const pdfBuffer = Buffer.from(response.data);
                const rawText = pdfBuffer.toString("latin1");
                const extractedText = rawText
                    .replace(/[^\x20-\x7E\n]/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .substring(0, 8000);
                return extractedText || "Teks PDF berhasil diunduh namun memerlukan parser PDF khusus.";
            } else {
                const $ = cheerio.load(response.data);
                $("script, style, nav, footer, header").remove();
                return $("body").text().replace(/\s+/g, " ").trim().substring(0, 6000);
            }
        } catch (err) {
            Logger.warn(`Gagal membaca isi URL ${url}:`, err.message);
            return null;
        }
    }
}

class AiService {
    /**
     * Fast Instant Local Agent Selector (0 ms overhead!)
     */
    static selectAgent(text) {
        if (!text) return chatAgent;
        const lower = text.toLowerCase();

        if (/\b(code|coding|react|nextjs|javascript|typescript|express|api|node|html|css|function|bug|err|script)\b/i.test(lower)) {
            return codingAgent;
        }

        if (/\b(docker|ubuntu|linux|nginx|pm2|tailscale|server|ssh|devops|bash|cron|sudo)\b/i.test(lower)) {
            return devopsAgent;
        }

        if (/\b(jurnal|paper|penelitian|research|arxiv|ieee|sinta|pdf|doi|springer|acm)\b/i.test(lower)) {
            return researchAgent;
        }

        return chatAgent;
    }

    /**
     * Fast Instant Search Need Classifier with History Operation Detection
     */
    static checkSearchNeed(text) {
        if (!text) return false;
        const lower = text.toLowerCase();

        // 1. Bypass search if user is asking to summarize, process, or operate on existing conversation history
        const historyOperationKeywords = [
            "sebelumnya", "yang tadi", "di atas", "dari hasil", "dari jurnal",
            "ringkas hasil", "buatkan ringkasan", "rangkumkan", "rangkum",
            "terjemahkan ini", "jelaskan yang tadi", "nomor 1", "nomor 2", "point 1", "poin 1",
            "tabelkan", "listkan"
        ];

        if (historyOperationKeywords.some(kw => lower.includes(kw))) {
            Logger.info("Pesan meminta operasi dari riwayat percakapan -> Melewati pencarian web baru.");
            return false;
        }

        // 2. Explicit Search Intent Keywords
        const searchKeywords = [
            "carikan", "cari", "jurnal", "paper", "sinta", "berita", "terbaru", "hari ini",
            "siapa", "dimana", "kapan", "mengapa", "kenapa", "berapa", "presiden", "juara",
            "pildun", "piala dunia", "harga", "skor", "klasemen", "update", "2026", "2025",
            "link", "url", "situs", "artikel", "sumber", "rektor", "rektornya", "hasil", "jadwal"
        ];

        return searchKeywords.some(kw => lower.includes(kw));
    }

    /**
     * Build context-aware web search query for follow-up questions
     */
    static buildSearchQuery(userText, history = []) {
        if (!history || history.length === 0) return userText;

        const lastUserMsgs = history
            .filter(m => m.role === "user")
            .slice(-2)
            .map(m => m.content);

        if (lastUserMsgs.length === 0) return userText;

        const lastMsg = lastUserMsgs[lastUserMsgs.length - 1];
        const isFollowUp = userText.length < 35 || /\b(siapa|berapa|mana|apa|rekot|rektor|rektornya|juara|juaranya|harganya|linknya|pdfnya|itu|ini)\b/i.test(userText);

        if (isFollowUp) {
            const combined = `${lastMsg} ${userText}`.replace(/[?\!.,]/g, " ").trim();
            Logger.info(`Context-Aware Search Query constructed: "${combined}"`);
            return combined;
        }

        return userText;
    }

    static async askWithFallback(messages, temperature = 0.7, maxTokens = CONFIG.LIMITS.MAX_TOKENS_GEN) {
        let lastError = null;

        for (const model of CONFIG.MODEL_CHAIN) {
            try {
                const payload = {
                    model,
                    messages,
                    temperature,
                    max_tokens: maxTokens
                };

                const response = await axios.post(
                    CONFIG.OPENROUTER_URL,
                    payload,
                    {
                        headers: {
                            Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
                            "Content-Type": "application/json"
                        },
                        timeout: CONFIG.TIMEOUTS.OPENROUTER_MS
                    }
                );

                const content = response.data?.choices?.[0]?.message?.content;
                if (content !== undefined && content !== null) {
                    return content;
                }
            } catch (err) {
                lastError = err;
                Logger.warn(`Model ${model} timeout/failed (${err.message}). Mencoba model berikutnya...`);
            }
        }

        throw lastError || new Error("Semua model di MODEL_CHAIN gagal merespons.");
    }
}

class TelegramPresenter {
    static async reply(ctx, text) {
        const formattedText = TextSanitizer.convertTablesToBullets(text);

        try {
            await ctx.reply(formattedText, {
                parse_mode: "Markdown",
                disable_web_page_preview: true
            });
        } catch (err) {
            Logger.warn("Markdown parse failed, falling back to plain text:", err.message);
            await ctx.reply(formattedText, {
                disable_web_page_preview: true
            });
        }
    }
}

const bot = new Telegraf(CONFIG.TELEGRAM_TOKEN);

bot.start(async (ctx) => {
    await TelegramPresenter.reply(ctx,
        `Halo 👋

Saya CitCat - High-Performance Multi-Agent System!

Fitur Utama:
• Ultra Fast Response (Kecepatan Tinggi)
• Memori Pembelajaran Singkatan/Akronim
• Context History Intelligence (Ringkas & Olah Jawaban Sebelumnya)
• Research & Web Search Engine

Perintah:
/singkatan - Lihat daftar singkatan yang diingat bot
/coding - Mode Coding Specialist
/research - Mode Research Specialist
/devops - Mode DevOps Specialist
/chat - Mode General Chat
/reset - Hapus riwayat chat`
    );
});

bot.command("reset", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.clear(chatId);
    await TelegramPresenter.reply(ctx, "🧹 Riwayat percakapan berhasil dihapus!");
});

bot.command("singkatan", async (ctx) => {
    const customDict = MemoryManager.getCustomAbbreviations();
    const keys = Object.keys(customDict);

    if (keys.length === 0) {
        await TelegramPresenter.reply(ctx, "📖 Belum ada singkatan kustom yang dipelajari. Beri tahu saya format: `UNIBA itu Universitas Balikpapan`!");
        return;
    }

    const listText = keys
        .map(k => `• *${k.toUpperCase()}*: ${customDict[k]}`)
        .join("\n");

    await TelegramPresenter.reply(ctx, `📖 *Singkatan Kustom Yang Diingat Bot:*\n\n${listText}`);
});

bot.command("coding", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "CODING");
    await TelegramPresenter.reply(ctx, "💻 Mode diaktifkan: *Coding Agent* (Node.js, React, TypeScript)");
});

bot.command("research", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "RESEARCH");
    await TelegramPresenter.reply(ctx, "📚 Mode diaktifkan: *Research Agent* (Jurnal, ArXiv, IEEE, PDF)");
});

bot.command("devops", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "DEVOPS");
    await TelegramPresenter.reply(ctx, "🛠️ Mode diaktifkan: *DevOps Agent* (Docker, Linux, Nginx, PM2)");
});

bot.command("chat", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "GENERAL");
    await TelegramPresenter.reply(ctx, "🤖 Mode diaktifkan: *General Chat Agent*");
});

bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userText = TextSanitizer.sanitizeInput(ctx.message.text);

    if (!userText) return;

    try {
        await ctx.sendChatAction("typing");

        // 1. Detect User Teaching/Defining Abbreviation (e.g. "UNIBA itu Universitas Balikpapan")
        const defRegex = /(?:maksudnya\s+)?([a-z0-9]{2,10})\s+(?:itu|adalah|singkatan dari|kepanjangannya|artinya)\s+(.+)/i;
        const defMatch = userText.match(defRegex);

        if (defMatch) {
            const shortForm = defMatch[1].trim();
            const fullName = defMatch[2].trim();

            MemoryManager.setCustomAbbreviation(shortForm, fullName);
            Logger.info(`Learned new abbreviation: ${shortForm.toUpperCase()} = "${fullName}"`);

            await TelegramPresenter.reply(ctx,
                `🧠 *Memori Diperbarui!*\nSaya sudah menyimpan ingatan permanen bahwa **${shortForm.toUpperCase()}** adalah **${fullName}**.`
            );

            if (userText.length > shortForm.length + fullName.length + 15) {
                // Continue with full query
            } else {
                return;
            }
        }

        const chatHistory = MemoryManager.getHistory(chatId);
        const userMode = MemoryManager.getMode(chatId);

        let activeAgent = chatAgent;
        if (userMode === "CODING") activeAgent = codingAgent;
        else if (userMode === "RESEARCH") activeAgent = researchAgent;
        else if (userMode === "DEVOPS") activeAgent = devopsAgent;
        else {
            activeAgent = AiService.selectAgent(userText); // Instant local selection (0 ms)
        }

        Logger.info(`User (${chatId}) -> Active Agent: ${activeAgent.name} | Question: "${userText}"`);

        const extractedUrls = DocumentService.extractUrls(userText);
        let documentContext = "";
        if (extractedUrls.length > 0) {
            for (const url of extractedUrls.slice(0, 2)) {
                const content = await DocumentService.fetchUrlContent(url);
                if (content) {
                    documentContext += `\nISI DOKUMEN/URL (${url}):\n${content}\n`;
                }
            }
        }

        const needsSearch = AiService.checkSearchNeed(userText); // Instant local classification (0 ms)
        let searchContext = "";

        if (needsSearch && !documentContext) {
            const contextAwareSearchQuery = AiService.buildSearchQuery(userText, chatHistory);
            Logger.info(`Searching web via SearXNG for ${activeAgent.name} using query: "${contextAwareSearchQuery}"...`);

            const searchResults = await searchWeb(contextAwareSearchQuery);
            if (searchResults.length > 0) {
                searchContext = searchResults
                    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nRingkasan: ${r.snippet}`)
                    .join("\n\n");
            }
        }

        const messages = [
            {
                role: "system",
                content: activeAgent.getPrompt()
            },
            ...chatHistory
        ];

        let finalUserPayload = userText;
        if (documentContext) {
            finalUserPayload = `DOKUMEN TERLAMPIR:\n${documentContext}\n\nPERTANYAAN USER:\n${userText}`;
        } else if (searchContext) {
            finalUserPayload = `HASIL PENCARIAN WEB REAL-TIME:\n${searchContext}\n\nPERTANYAAN USER:\n${userText}`;
        }

        messages.push({
            role: "user",
            content: finalUserPayload
        });

        let rawAnswer = await AiService.askWithFallback(messages);
        let finalAnswer = TextSanitizer.sanitizeOutput(rawAnswer);

        if (!finalAnswer && searchContext) {
            Logger.warn("Search payload resulted in empty response, falling back to conversational memory...");
            const fallbackMessages = [
                { role: "system", content: activeAgent.getPrompt() },
                ...chatHistory,
                { role: "user", content: userText }
            ];
            rawAnswer = await AiService.askWithFallback(fallbackMessages);
            finalAnswer = TextSanitizer.sanitizeOutput(rawAnswer);
        }

        if (!finalAnswer) {
            finalAnswer = "Maaf, saya belum dapat menemukan informasi yang tepat untuk pertanyaan tersebut. Bisa tolong perjelas?";
        }

        MemoryManager.addMessagePair(chatId, userText, finalAnswer);
        await TelegramPresenter.reply(ctx, finalAnswer);

    } catch (err) {
        Logger.error("Unhandled Bot Error:", err.message);
        await TelegramPresenter.reply(ctx, "Terjadi kesalahan saat memproses permintaan.");
    }
});

bot.launch();

Logger.info(`CitCat Ultra-Fast Multi-Agent System Active (History Operation Intelligence Active)`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
