require("dotenv").config();

const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { Telegraf, Markup } = require("telegraf");

const { MemoryManager } = require("./memory");
const { ConfigManager } = require("./configManager");
const { searchWeb } = require("./search");
const { createPdfBuffer } = require("./pdfService");
const { createExcelBuffer } = require("./excelService");
const { transcribeAndSummarizeMedia } = require("./mediaService");
const { processImageOcr } = require("./ocrService");

const chatAgent = require("./agents/chat");
const codingAgent = require("./agents/coding");
const researchAgent = require("./agents/research");
const devopsAgent = require("./agents/devops");
const transcribeAgent = require("./agents/transcribe");
const ocrAgent = require("./agents/ocr");

const CONFIG = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
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
            .replace(/[\u0300-\u036f]/g, "")             // Remove combining diacritical marks
            .replace(/[\u10A0-\u10FF]/g, "")             // Remove Georgian alphabet
            .replace(/[\u0400-\u04FF]/g, "")             // Remove Cyrillic alphabet
            .replace(/[\u4e00-\u9fa5]+/g, "")             // Remove Chinese/Japanese/Korean
            .replace(/\\\[([\s\S]*?)\\]/g, "$1")       // Remove display LaTeX brackets
            .replace(/\\\(([\s\S]*?)\\\)/g, "$1")       // Remove inline LaTeX brackets
            .replace(/\$+/g, "")                         // Strip LaTeX dollar signs
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
    static selectAgent(text) {
        if (!text) return chatAgent;
        const lower = text.toLowerCase();

        if (/\b(ocr|foto|gambar|scan|kuitansi|nota|invoice|excel|xlsx)\b/i.test(lower)) {
            return ocrAgent;
        }

        if (/\b(transkrip|rekaman|suara|audio|video|voice|speech|youtube)\b/i.test(lower)) {
            return transcribeAgent;
        }

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

    static checkSearchNeed(text) {
        if (!text) return false;
        const lower = text.toLowerCase();

        // 1. If explicitly asking to search/find ("carikan", "cari"), ALWAYS search!
        const explicitSearchTrigger = ["carikan", "cari", "temukan", "lakukan pencarian"];
        const isExplicitSearch = explicitSearchTrigger.some(kw => lower.includes(kw));

        // 2. Pure History Operation Bypass
        const historyOperationKeywords = [
            "sebelumnya", "yang tadi", "di atas", "dari hasil", "dari jurnal",
            "ringkas hasil", "buatkan ringkasan dari", "rangkumkan dari",
            "terjemahkan ini", "jelaskan yang tadi", "nomor 1", "nomor 2", "point 1", "poin 1",
            "tabelkan hasil", "listkan hasil"
        ];

        if (!isExplicitSearch && historyOperationKeywords.some(kw => lower.includes(kw))) {
            Logger.info("Pesan meminta operasi dari riwayat percakapan -> Melewati pencarian web baru.");
            return false;
        }

        const searchKeywords = [
            "carikan", "cari", "jurnal", "paper", "sinta", "berita", "terbaru", "hari ini",
            "siapa", "dimana", "kapan", "mengapa", "kenapa", "berapa", "presiden", "juara",
            "pildun", "piala dunia", "harga", "skor", "klasemen", "update", "2026", "2025",
            "link", "url", "situs", "artikel", "sumber", "rektor", "rektornya", "hasil", "jadwal"
        ];

        return searchKeywords.some(kw => lower.includes(kw));
    }

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

    static async askWithFallback(messages, temperature = 0.2, maxTokens = CONFIG.LIMITS.MAX_TOKENS_GEN) {
        let lastError = null;
        const modelChain = ConfigManager.getModelChain();
        const openrouterKey = ConfigManager.getApiKey("OPENROUTER_API_KEY") || CONFIG.OPENROUTER_API_KEY;

        for (const model of modelChain) {
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
                            Authorization: `Bearer ${openrouterKey}`,
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
    static async reply(ctx, text, extra = {}) {
        const formattedText = TextSanitizer.convertTablesToBullets(text);

        try {
            await ctx.reply(formattedText, {
                parse_mode: "Markdown",
                disable_web_page_preview: true,
                ...extra
            });
        } catch (err) {
            Logger.warn("Markdown parse failed, falling back to plain text:", err.message);
            await ctx.reply(formattedText, {
                disable_web_page_preview: true,
                ...extra
            });
        }
    }
}

function getMainMenuMarkup() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("🖼️ OCR Vision & Excel", "MODE_OCR"),
            Markup.button.callback("🎙️ Transkrip & PDF", "MODE_TRANSCRIBE")
        ],
        [
            Markup.button.callback("📚 Riset & Jurnal", "MODE_RESEARCH"),
            Markup.button.callback("💻 Koding Specialist", "MODE_CODING")
        ],
        [
            Markup.button.callback("🛠️ DevOps & Linux", "MODE_DEVOPS"),
            Markup.button.callback("🤖 Atur Model AI", "SHOW_MODEL_SETTINGS")
        ],
        [
            Markup.button.callback("🧠 Uteke Memori", "SHOW_UTEKE_MEMORIES"),
            Markup.button.callback("🧹 Reset Memori", "RESET_MEMORY")
        ]
    ]);
}

function getModelPresetKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("⚡ Gemma 4 (26B)", "SET_MODEL_gemma26"),
            Markup.button.callback("⚡ Gemma 4 (31B)", "SET_MODEL_gemma31")
        ],
        [
            Markup.button.callback("🤖 GPT OSS (20B)", "SET_MODEL_gptoss"),
            Markup.button.callback("🦙 Llama 3.3 (70B)", "SET_MODEL_llama70")
        ],
        [
            Markup.button.callback("💎 Claude 3.5 Sonnet", "SET_MODEL_claude35"),
            Markup.button.callback("🟢 GPT-4o", "SET_MODEL_gpt4o")
        ]
    ]);
}

function isGreeting(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    const greetingWords = [
        "halo", "hallo", "hi", "hai", "pagi", "selamat pagi", "selamat siang",
        "selamat sore", "selamat malam", "ping", "p", "permisi", "tes", "test", "start"
    ];
    return greetingWords.includes(lower);
}

const bot = new Telegraf(CONFIG.TELEGRAM_TOKEN);

bot.telegram.setMyCommands([
    { command: "start", description: "Tampilkan menu utama & greeting" },
    { command: "ingat", description: "Simpan ingatan permanen Uteke Engine (/ingat <teks>)" },
    { command: "memori", description: "Lihat ingatan permanen Uteke Engine" },
    { command: "lupa", description: "Hapus ingatan permanen (/lupa <id_atau_kata>)" },
    { command: "ocr", description: "OCR Foto/Dokumen ke Excel & PDF (Gemini Vision)" },
    { command: "transcribe", description: "Transkrip Voice/Audio/Video ke PDF (Gemini Pro)" },
    { command: "model", description: "Cek & ganti model AI aktif" },
    { command: "gantimodel", description: "Set model utama (/gantimodel <nama>)" },
    { command: "tambahmodel", description: "Tambah model fallback (/tambahmodel <nama>)" },
    { command: "setkey", description: "Set API Key (/setkey <KEY> <VALUE>)" },
    { command: "research", description: "Riset Jurnal & Paper Akademik" },
    { command: "coding", description: "Bantuan Fullstack Koding & Scripting" },
    { command: "devops", description: "Bantuan Server, Docker & Linux" },
    { command: "singkatan", description: "Lihat memori singkatan kustom" },
    { command: "reset", description: "Hapus riwayat percakapan" }
]).catch(err => Logger.warn("SetMyCommands error:", err.message));

bot.start(async (ctx) => {
    await TelegramPresenter.reply(
        ctx,
        `Halo 👋 Selamat datang di *CitCat Production AI Agent*!\n\nPilih mode spesialis dari menu tombol interaktif di bawah atau tekan tombol \`/\` di keyboard Telegram Anda:`,
        getMainMenuMarkup()
    );
});

// UTEKE MEMORY ENGINE COMMANDS
bot.command("ingat", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/ingat <informasi_penting>`\n\nContoh:\n`/ingat Email dosen: dosen@uniba.ac.id`\n`/ingat Username server VPS: root 103.12.1.5`");
        return;
    }

    const memoryContent = parts.slice(1).join(" ");
    const saved = MemoryManager.storeLongTermMemory(chatId, memoryContent);

    await TelegramPresenter.reply(ctx, `🧠 *Uteke Memory Engine - Saved!*\n\nInformasi berhasil disimpan ke ingatan jangka panjang:\n• ID: \`${saved.id}\`\n• Isi: "${saved.text}"`);
});

bot.command(["memori", "ingatan"], async (ctx) => {
    const chatId = String(ctx.chat.id);
    const memories = MemoryManager.getLongTermMemories(chatId);

    if (memories.length === 0) {
        await TelegramPresenter.reply(ctx, "🧠 *Uteke Memory Engine Kosong*\nBelum ada ingatan jangka panjang tersimpan. Ketik `/ingat <informasi>` untuk menyimpan!");
        return;
    }

    const memoryList = memories
        .map((m, i) => `${i + 1}. [\`${m.id}\`] ${m.text}`)
        .join("\n");

    await TelegramPresenter.reply(ctx, `🧠 *Daftar Ingatan Jangka Panjang Uteke Engine:*\n\n${memoryList}\n\n*Hapus Ingatan:* `/lupa <id_atau_kata>``);
});

bot.command("lupa", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/lupa <id_atau_kata_kunci>`\n\nContoh: `/lupa dosen` atau `/lupa 1a2b3c`");
        return;
    }

    const query = parts.slice(1).join(" ");
    const deleted = MemoryManager.deleteLongTermMemory(chatId, query);

    if (deleted) {
        await TelegramPresenter.reply(ctx, `🗑️ *Ingatan Berhasil Dihapus!* (${query})`);
    } else {
        await TelegramPresenter.reply(ctx, `⚠️ Ingatan tidak ditemukan untuk: "${query}"`);
    }
});

// MODEL COMMANDS
bot.command(["model", "models"], async (ctx) => {
    const primary = ConfigManager.getPrimaryModel();
    const chain = ConfigManager.getModelChain();

    const chainText = chain.map((m, i) => `  ${i + 1}. \`${m}\``).join("\n");
    const text = `🤖 *Status Model AI CitCat:*\n\n*Model Utama Aktif:* \`${primary}\`\n\n*Model Fallback Chain:*\n${chainText}\n\n*Pilih Model Cepat di Bawah, atau Ketik Command:*\n• \`/gantimodel <nama_model>\`\n• \`/tambahmodel <nama_model>\`\n\n*Kelola API Key:*\n• \`/setkey GEMINI_API_KEY <api_key>\`\n• \`/setkey OPENROUTER_API_KEY <api_key>\``;

    await TelegramPresenter.reply(ctx, text, getModelPresetKeyboard());
});

bot.command("gantimodel", async (ctx) => {
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/gantimodel <nama_model>`\n\nContoh: `/gantimodel google/gemma-4-31b-it:free`");
        return;
    }

    const newModel = parts[1].trim();
    ConfigManager.setPrimaryModel(newModel);
    await TelegramPresenter.reply(ctx, `✅ *Model Utama Berhasil Diganti!*\n\nModel aktif sekarang: \`${newModel}\``);
});

bot.command("tambahmodel", async (ctx) => {
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/tambahmodel <nama_model>`\n\nContoh: `/tambahmodel meta-llama/llama-3.3-70b-instruct:free`");
        return;
    }

    const newModel = parts[1].trim();
    ConfigManager.addModelToChain(newModel);
    const chain = ConfigManager.getModelChain();
    await TelegramPresenter.reply(ctx, `✅ *Model Berhasil Ditambahkan ke Fallback Chain!*\n\nDaftar Chain saat ini:\n${chain.map(m => `• \`${m}\``).join("\n")}`);
});

bot.command("setkey", async (ctx) => {
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/setkey <NAMA_KEY> <VALUE_KEY>`\n\nContoh:\n`/setkey GEMINI_API_KEY AIzaSy...`\n`/setkey OPENROUTER_API_KEY sk-or-v1-...`");
        return;
    }

    const keyName = parts[1].trim().toUpperCase();
    const keyValue = parts[2].trim();

    ConfigManager.setApiKey(keyName, keyValue);
    await TelegramPresenter.reply(ctx, `🔑 *API Key Berhasil Disimpan!*\n\nKey: \`${keyName}\` (Tersimpan aman di memori server)`);
});

bot.command("ocr", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "OCR");
    await TelegramPresenter.reply(ctx, "🖼️ Mode diaktifkan: *OCR Vision & Data Specialist (Google Gemini Vision)*\n\nKirimkan foto/scan dokumen, kuitansi, nota, atau tabel. Bot akan mengekstrak teksnya dan mengonversi sesuai permintaan Anda (**Excel .xlsx**, **PDF**, atau **Teks**)!");
});

// CALLBACK BUTTON HANDLERS
bot.action("SHOW_UTEKE_MEMORIES", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const memories = MemoryManager.getLongTermMemories(chatId);
    await ctx.answerCbQuery();

    if (memories.length === 0) {
        await TelegramPresenter.reply(ctx, "🧠 *Uteke Memory Engine Kosong*\nBelum ada ingatan jangka panjang tersimpan. Ketik `/ingat <informasi>` untuk menyimpan!");
        return;
    }

    const memoryList = memories
        .map((m, i) => `${i + 1}. [\`${m.id}\`] ${m.text}`)
        .join("\n");

    await TelegramPresenter.reply(ctx, `🧠 *Daftar Ingatan Jangka Panjang Uteke Engine:*\n\n${memoryList}\n\n*Hapus Ingatan:* `/lupa <id_atau_kata>``);
});

bot.action("MODE_OCR", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "OCR");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "🖼️ Mode diaktifkan: *OCR Vision & Data Specialist (Google Gemini Vision)*\n\nKirimkan foto/scan dokumen, kuitansi, nota, atau tabel. Bot akan mengekstrak teksnya dan mengonversi sesuai permintaan Anda (**Excel .xlsx**, **PDF**, atau **Teks**)!");
});

bot.action("SHOW_MODEL_SETTINGS", async (ctx) => {
    await ctx.answerCbQuery();
    const primary = ConfigManager.getPrimaryModel();
    const chain = ConfigManager.getModelChain();

    const chainText = chain.map((m, i) => `  ${i + 1}. \`${m}\``).join("\n");
    const text = `🤖 *Status Model AI CitCat:*\n\n*Model Utama Aktif:* \`${primary}\`\n\n*Model Fallback Chain:*\n${chainText}\n\n*Pilih Model Cepat di Bawah:*`;

    await TelegramPresenter.reply(ctx, text, getModelPresetKeyboard());
});

bot.action("SET_MODEL_gemma26", async (ctx) => {
    ConfigManager.setPrimaryModel("google/gemma-4-26b-a4b-it:free");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `google/gemma-4-26b-a4b-it:free`");
});

bot.action("SET_MODEL_gemma31", async (ctx) => {
    ConfigManager.setPrimaryModel("google/gemma-4-31b-it:free");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `google/gemma-4-31b-it:free`");
});

bot.action("SET_MODEL_gptoss", async (ctx) => {
    ConfigManager.setPrimaryModel("openai/gpt-oss-20b:free");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `openai/gpt-oss-20b:free`");
});

bot.action("SET_MODEL_llama70", async (ctx) => {
    ConfigManager.setPrimaryModel("meta-llama/llama-3.3-70b-instruct:free");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `meta-llama/llama-3.3-70b-instruct:free`");
});

bot.action("SET_MODEL_claude35", async (ctx) => {
    ConfigManager.setPrimaryModel("anthropic/claude-3.5-sonnet");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `anthropic/claude-3.5-sonnet`");
});

bot.action("SET_MODEL_gpt4o", async (ctx) => {
    ConfigManager.setPrimaryModel("openai/gpt-4o");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `openai/gpt-4o`");
});

bot.action("MODE_TRANSCRIBE", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "TRANSCRIBE");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "🎙️ Mode diaktifkan: *CitCat Transcribe Agent (Google Gemini Pro)*\n\nKirimkan file Voice Note, Audio (MP3/WAV/OGG), atau Video (MP4) langsung ke chat ini. Bot akan otomatis membuatkan **Transkrip Lengkap PDF** & **Rangkuman Inti PDF**!");
});

bot.action("MODE_RESEARCH", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "RESEARCH");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "📚 Mode diaktifkan: *Research Agent* (Jurnal, ArXiv, IEEE, PDF)\n\nSilakan tanyakan jurnal atau topik penelitian yang ingin Anda cari!");
});

bot.action("MODE_CODING", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "CODING");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "💻 Mode diaktifkan: *Coding Agent* (Node.js, React, TypeScript, Docker)\n\nSilakan tanyakan soal koding atau arsitektur sistem!");
});

bot.action("MODE_DEVOPS", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "DEVOPS");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "🛠️ Mode diaktifkan: *DevOps Agent* (Docker, Linux, Nginx, PM2, Tailscale)\n\nSilakan tanyakan seputar konfigurasi server dan perintah terminal!");
});

bot.action("RESET_MEMORY", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.clear(chatId);
    await ctx.answerCbQuery();
    await ctx.reply("🧹 Riwayat percakapan berhasil dihapus!");
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

bot.command("transcribe", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "TRANSCRIBE");
    await TelegramPresenter.reply(ctx,
        "🎙️ Mode diaktifkan: *CitCat Transcribe Agent (Google Gemini Pro)*\n\nKirimkan file Voice Note, Audio (MP3/WAV/OGG), atau Video (MP4) langsung ke chat ini. Bot akan otomatis membuatkan **Transkrip Lengkap PDF** & **Rangkuman Inti PDF**!"
    );
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

// PHOTO & IMAGE OCR HANDLER (SMART FORMAT EXTRACTOR)
bot.on(["photo", "document"], async (ctx, next) => {
    try {
        const message = ctx.message;
        const photos = message.photo;
        const document = message.document;

        let fileId = null;
        let mimeType = "image/jpeg";

        if (photos && photos.length > 0) {
            fileId = photos[photos.length - 1].file_id;
        } else if (document && document.mime_type && document.mime_type.startsWith("image/")) {
            fileId = document.file_id;
            mimeType = document.mime_type;
        }

        if (!fileId) return next();

        const rawCaption = message.caption || "";
        const userCaption = rawCaption.toLowerCase().trim();

        await ctx.reply("🖼️ *Menerima foto/dokumen...* Sedang mengekstrak teks via **Google Gemini Vision AI**...");
        await ctx.sendChatAction("upload_document");

        const fileLink = await ctx.telegram.getFileLink(fileId);

        const response = await axios.get(fileLink.href, { responseType: "arraybuffer" });
        const imageBuffer = Buffer.from(response.data);

        Logger.info(`Processing Vision OCR (${imageBuffer.length} bytes)...`);

        const { ocrText, tableData } = await processImageOcr(imageBuffer, mimeType, rawCaption);

        const asksExcel = /\b(excel|xlsx|csv|tabel|spreadsheet|kuitansi|nota|invoice)\b/i.test(userCaption);
        const asksPdf = /\b(pdf|dokumen|document)\b/i.test(userCaption);
        const asksText = /\b(teks|text|baca|ketik)\b/i.test(userCaption);

        const textPreview = TextSanitizer.sanitizeOutput(ocrText).substring(0, 1200);
        await TelegramPresenter.reply(ctx, `📌 *HASIL OCR:* \n\n${textPreview}`);

        // Send Excel file ONLY if Excel is requested or if tableData exists and user didn't explicitly ask ONLY PDF/Text
        if (asksExcel || (tableData && !asksPdf && !asksText)) {
            const dataToExport = tableData || ocrText;
            const excelBuffer = createExcelBuffer(dataToExport, "Hasil_OCR");
            await ctx.replyWithDocument({
                source: excelBuffer,
                filename: "Hasil_OCR_Data.xlsx"
            });
        }

        // Send PDF file ONLY if PDF is requested or if plain document text and user didn't ask ONLY Excel/Text
        if (asksPdf || (!tableData && !asksExcel && !asksText)) {
            const pdfBuffer = await createPdfBuffer("HASIL OCR DOKUMEN (Google Gemini Vision)", ocrText);
            await ctx.replyWithDocument({
                source: pdfBuffer,
                filename: "Hasil_OCR_Dokumen.pdf"
            });
        }

    } catch (err) {
        Logger.error("OCR Processing Error:", err.message);
        await TelegramPresenter.reply(ctx, `❌ Gagal memproses OCR gambar: ${err.message}`);
    }
});

// MEDIA HANDLER (Voice Notes, Audio, Video Files)
bot.on(["voice", "audio", "video", "document"], async (ctx) => {
    try {
        const message = ctx.message;
        const fileObj = message.voice || message.audio || message.video || message.document;

        if (!fileObj) return;

        const mimeType = message.voice ? "audio/ogg" : (fileObj.mime_type || "audio/mp3");

        if (!mimeType.includes("audio") && !mimeType.includes("video") && !mimeType.includes("ogg")) {
            return;
        }

        await ctx.reply("🎙️ *Menerima file media...* Sedang memproses transkripsi & rangkuman via **Google Gemini Pro** (Mohon tunggu sebentar)...");
        await ctx.sendChatAction("upload_document");

        const fileLink = await ctx.telegram.getFileLink(fileObj.file_id);

        const response = await axios.get(fileLink.href, { responseType: "arraybuffer" });
        const mediaBuffer = Buffer.from(response.data);

        Logger.info(`Processing media transcription (${mediaBuffer.length} bytes, mime: ${mimeType})...`);

        const { fullTranscript, coreSummary } = await transcribeAndSummarizeMedia(mediaBuffer, mimeType);

        await ctx.reply("📄 *Transkripsi & Rangkuman Selesai!* Menggenerasi dokumen PDF...");

        const transcriptPdfBuffer = await createPdfBuffer("TRANSKRIP LENGKAP MEDIA (Google Gemini Pro)", fullTranscript);
        const summaryPdfBuffer = await createPdfBuffer("RANGKUMAN INTI PENELITIAN & MEDIA", coreSummary);

        const shortSummaryPreview = TextSanitizer.sanitizeOutput(coreSummary).substring(0, 800);
        await TelegramPresenter.reply(ctx, `📌 *RANGKUMAN INTI:* \n\n${shortSummaryPreview}\n\n*(Dokumen PDF lengkap dilampirkan di bawah)*`);

        await ctx.replyWithDocument({
            source: summaryPdfBuffer,
            filename: "Rangkuman_Inti.pdf"
        });

        await ctx.replyWithDocument({
            source: transcriptPdfBuffer,
            filename: "Transkrip_Lengkap.pdf"
        });

    } catch (err) {
        Logger.error("Media Processing Error:", err.message);
        await TelegramPresenter.reply(ctx, `❌ Gagal memproses media: ${err.message}`);
    }
});

bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userText = TextSanitizer.sanitizeInput(ctx.message.text);

    if (!userText) return;

    try {
        if (isGreeting(userText)) {
            await TelegramPresenter.reply(
                ctx,
                `Halo 👋 Selamat datang di *CitCat Production AI Agent*!\n\nPilih mode spesialis dari menu tombol interaktif di bawah atau tekan tombol \`/\` di keyboard Telegram Anda:`,
                getMainMenuMarkup()
            );
            return;
        }

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

        // 2. UTEKE SEMANTIC RECALL ENGINE
        const recalledMemories = MemoryManager.recallMemories(chatId, userText);
        let utekeMemoryContext = "";

        if (recalledMemories.length > 0) {
            utekeMemoryContext = recalledMemories
                .map(m => `• [Uteke Memory]: ${m.text}`)
                .join("\n");
            Logger.info(`Uteke Memory Engine recalled ${recalledMemories.length} relevant items for query "${userText}"`);
        }

        const chatHistory = MemoryManager.getHistory(chatId);
        const userMode = MemoryManager.getMode(chatId);

        let activeAgent = chatAgent;
        if (userMode === "CODING") activeAgent = codingAgent;
        else if (userMode === "RESEARCH") activeAgent = researchAgent;
        else if (userMode === "DEVOPS") activeAgent = devopsAgent;
        else if (userMode === "TRANSCRIBE") activeAgent = transcribeAgent;
        else if (userMode === "OCR") activeAgent = ocrAgent;
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

        if (utekeMemoryContext) {
            finalUserPayload = `INGATAN JANGKA PANJANG UTEKE (INGATAN PENGGUNA RELEVAN):\n${utekeMemoryContext}\n\n${finalUserPayload}`;
        }

        if (documentContext) {
            finalUserPayload = `DOKUMEN TERLAMPIR:\n${documentContext}\n\nPERTANYAAN USER:\n${finalUserPayload}`;
        } else if (searchContext) {
            finalUserPayload = `HASIL PENCARIAN WEB REAL-TIME (DILARANG MENGARANG DOI/LINK BUATAN SENDIRI, HANYA GUNAKAN URL ASLI TERTERA):\n${searchContext}\n\nPERTANYAAN USER:\n${finalUserPayload}\n\nPetunjuk Ketat: HANYA tampilkan Judul Jurnal Utuh dan URL ASLI yang tertera di atas. DILARANG MERUBAH ATAU MEMBUAT DOI/LINK MENTAH BUATAN SENDIRI.`;
        }

        messages.push({
            role: "user",
            content: finalUserPayload
        });

        let rawAnswer = await AiService.askWithFallback(messages, 0.2);
        let finalAnswer = TextSanitizer.sanitizeOutput(rawAnswer);

        if (!finalAnswer && searchContext) {
            Logger.warn("Search payload resulted in empty response, falling back to conversational memory...");
            const fallbackMessages = [
                { role: "system", content: activeAgent.getPrompt() },
                ...chatHistory,
                { role: "user", content: userText }
            ];
            rawAnswer = await AiService.askWithFallback(fallbackMessages, 0.2);
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

Logger.info(`CitCat Production System Active (Uteke Local-First Memory Engine Active)`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
