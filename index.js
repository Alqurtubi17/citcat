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
const { parseExcelFileBuffer, computeCrossFileMissingItems } = require("./excelReaderService");
const { transcribeAndSummarizeMedia, extractAndDownloadMediaFromUrl } = require("./mediaService");
const { processImageOcr } = require("./ocrService");
const { askGeminiDirect } = require("./geminiService");
const { BROWSER_SERVICES, saveBrowserAccount, listBrowserAccounts, removeBrowserAccount, askViaBrowser, closeAllBrowserSessions } = require("./playwrightService");
const { TerminalService } = require("./terminalService");
const { HermesSelfHealing } = require("./hermesSelfHealingService");
const { AutonomousToolService } = require("./autonomousToolService");


const chatAgent = require("./agents/chat");
const hermesAgent = require("./agents/hermes");
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
        // Dinaikkan dari 4000 -- nilai lama memotong jawaban panjang (mis. tabel
        // perbandingan Excel puluhan/ratusan baris) di tengah kalimat. TelegramPresenter
        // sekarang memecah jawaban panjang jadi beberapa pesan (lihat sendLongMessage),
        // jadi batas ini hanya jaring pengaman terakhir, bukan batas praktis.
        MAX_OUTPUT_LENGTH: 12000,
        MAX_SEARCH_RESULTS: 15,
        // Dinaikkan dari 1500 -- nilai lama membuat output terpotong untuk jawaban
        // terstruktur panjang seperti tabel Markdown berisi puluhan/ratusan baris.
        MAX_TOKENS_GEN: 4000,
        // Token budget lebih besar khusus untuk analisis batch dokumen/Excel, karena
        // hasilnya bisa berupa tabel sangat panjang (ratusan baris perbandingan).
        MAX_TOKENS_GEN_DOCUMENT: 8000
    },
    TIMEOUTS: {
        ROUTER_MS: 5000,
        OPENROUTER_MS: 35000,
        FETCH_MS: 8000
    }
};

class Logger {
    static logsBuffer = [];

    static pushLog(level, message, args = []) {
        const timeStr = new Date().toLocaleTimeString("id-ID", { hour12: false });
        const argStr = args.length > 0 ? " " + args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ") : "";
        const cleanMsg = `${message}${argStr}`.replace(/[`*_\\]/g, "");
        const entry = `• \`[${timeStr}]\` *[${level}]* ${cleanMsg}`;

        this.logsBuffer.push(entry);
        if (this.logsBuffer.length > 50) {
            this.logsBuffer.shift();
        }
    }

    static info(message, ...args) {
        console.log(`[INFO] [${new Date().toISOString()}] ${message}`, ...args);
        this.pushLog("INFO", message, args);
    }

    static warn(message, ...args) {
        console.warn(`[WARN] [${new Date().toISOString()}] ${message}`, ...args);
        this.pushLog("WARN", message, args);
    }

    static error(message, ...args) {
        console.error(`[ERROR] [${new Date().toISOString()}] ${message}`, ...args);
        this.pushLog("ERROR", message, args);
    }

    static getRecentLogs(limit = 15) {
        if (this.logsBuffer.length === 0) return ["(Belum ada log aktivitas tercatat)"];
        return this.logsBuffer.slice(-limit);
    }

    static clearLogs() {
        this.logsBuffer = [];
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
            // Mencegah Prompt Leakage: hapus tag context/memory jika model mengulanginya
            .replace(/\[?INGATAN JANGKA PANJANG UTEKE(?:\s*\(.*?\))?\]?:?\s*/gi, "")
            .replace(/\[?MEMORI JANGKA PANJANG(?:\s*\(.*?\))?\]?:?\s*/gi, "")
            .replace(/\[?KOREKSI USER SEBELUMNYA(?:\s*\(.*?\))?\]?:?\s*/gi, "")
            .replace(/\[?WAKTU REAL-TIME SEKARANG.*?\]:?\s*/gi, "")
            .replace(/\[?INFORMASI SERVING VM REAL-TIME.*?\]:?\s*/gi, "")
            .replace(/\[?HASIL PENCARIAN & SCRAPING WEB REAL-TIME.*?\]:?\s*/gi, "")
            .replace(/\[?HASIL PENCARIAN WEB RISET AKADEMIK.*?\]:?\s*/gi, "")
            .replace(/\[?DOKUMEN TERLAMPIR.*?\]:?\s*/gi, "")
            .replace(/\[?PERTANYAAN USER\]?:?\s*/gi, "")
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")        // Convert Markdown headers (#, ##, ###) to Telegram bold (*Header*)
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

const BLOCKED_SCRAPE_DOMAINS = [
    "instagram.com",
    "facebook.com",
    "fb.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "linkedin.com",
    "threads.net",
    "pinterest.com",
    "t.me",
    "telegram.me"
];

class DocumentService {
    static isRestrictedDomain(url) {
        if (!url || typeof url !== "string") return true;
        try {
            const parsed = new URL(url);
            const host = parsed.hostname.toLowerCase();
            return BLOCKED_SCRAPE_DOMAINS.some(d => host === d || host.endsWith("." + d));
        } catch {
            return true;
        }
    }

    static extractUrls(text) {
        if (!text) return [];
        const matches = text.match(/https?:\/\/\S+/gi);
        return matches ? [...new Set(matches)] : [];
    }

    static async fetchUrlContent(url) {
        if (!url || typeof url !== "string") return null;

        if (this.isRestrictedDomain(url)) {
            Logger.warn(`[Scraper] Melewati domain terproteksi / anti-bot crawler: ${url}`);
            return null;
        }

        try {
            Logger.info(`Fetching document/URL: ${url}`);
            const isPdf = url.toLowerCase().includes(".pdf");
            const response = await axios.get(url, {
                timeout: CONFIG.TIMEOUTS.FETCH_MS,
                responseType: isPdf ? "arraybuffer" : "text",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CitCatBot/1.0",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                },
                // validateStatus: () => true mencegah Axios melempar unhandled exception saat status 404, 403, 500 dll
                validateStatus: () => true
            });

            if (!response || response.status < 200 || response.status >= 300 || !response.data) {
                Logger.warn(`[Scraper] URL ${url} mengembalikan status ${response?.status || 'gagal'}, dilewati.`);
                return null;
            }

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
                $("script, style, nav, footer, header, noscript, iframe, svg").remove();
                const cleanText = $("body").text().replace(/[\t\r]/g, " ").replace(/\n\s*\n/g, "\n").replace(/ {2,}/g, " ").trim();
                return cleanText.substring(0, 8000);
            }
        } catch (err) {
            Logger.warn(`Gagal membaca isi URL ${url}:`, err.message);
            return null;
        }
    }
}

class AiService {
    // Scoring-based agent classifier (menggantikan first-match cascade lama).
    // Setiap agent punya beberapa pola; skor tertinggi yang menang, sehingga
    // kalimat yang mengandung kata kunci dari >1 agent tetap terklasifikasi
    // dengan lebih akurat (mis. "convert hasil scan ke excel pakai OCR" -> OCR,
    // tapi "cara export data ke excel pakai javascript" -> Coding).
    static AGENT_RULES = [
        {
            agent: ocrAgent,
            patterns: [/\b(ocr)\b/i, /\b(scan|kuitansi|nota|invoice)\b/i, /\b(foto|gambar)\b/i]
        },
        {
            agent: transcribeAgent,
            patterns: [/\b(transkrip|rekaman|voice note)\b/i, /\b(audio|video|voice|speech)\b/i, /\byoutube\b/i]
        },
        {
            agent: devopsAgent,
            patterns: [/\b(docker|nginx|pm2|tailscale)\b/i, /\b(ubuntu|linux|ssh|devops|bash|cron|sudo)\b/i, /\bserver\b/i]
        },
        {
            agent: codingAgent,
            patterns: [/\b(code|coding|bug|error|script)\b/i, /\b(react|nextjs|javascript|typescript|express|node)\b/i, /\b(api|function|html|css|excel|xlsx)\b/i]
        },
        {
            agent: hermesAgent,
            patterns: [/\b(hermes|reasoning|deep think|logika mendalam|akar masalah|analisis mendalam|otonom)\b/i]
        },
        {
            agent: researchAgent,
            patterns: [/\b(jurnal|paper|penelitian|research)\b/i, /\b(arxiv|ieee|sinta|doi|springer|acm)\b/i]
        }
    ];

    static selectAgent(text) {
        if (!text) return chatAgent;
        const lower = text.toLowerCase();

        let bestAgent = chatAgent;
        let bestScore = 0;

        for (const rule of this.AGENT_RULES) {
            let score = 0;
            for (const pattern of rule.patterns) {
                if (pattern.test(lower)) score++;
            }
            if (score > bestScore) {
                bestScore = score;
                bestAgent = rule.agent;
            }
        }

        return bestAgent;
    }

    // In-process response cache untuk pertanyaan yang identik/mirip.
    // Ini adalah "self-contained fallback" -- jika MemoryManager sudah punya
    // getCachedResponse/setCachedResponse sendiri, itu tetap dipakai lebih dulu;
    // cache lokal ini hanya jaring pengaman kedua supaya fitur cache TIDAK PERNAH
    // kosong seperti sebelumnya (bug: getCachedResponse dipanggil tapi tak pernah diisi).
    static _localCache = new Map(); // key -> { answer, expiresAt }
    static LOCAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 jam
    static LOCAL_CACHE_MAX_ENTRIES = 500;

    static _cacheKey(text) {
        return text.trim().toLowerCase().replace(/\s+/g, " ");
    }

    static getLocalCachedResponse(text) {
        const key = this._cacheKey(text);
        const entry = this._localCache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this._localCache.delete(key);
            return null;
        }
        return entry.answer;
    }

    static setLocalCachedResponse(text, answer) {
        const key = this._cacheKey(text);
        if (this._localCache.size >= this.LOCAL_CACHE_MAX_ENTRIES) {
            const oldestKey = this._localCache.keys().next().value;
            this._localCache.delete(oldestKey);
        }
        this._localCache.set(key, { answer, expiresAt: Date.now() + this.LOCAL_CACHE_TTL_MS });
    }

    // Model cooldown map: model yang baru gagal/timeout di-skip sementara supaya
    // request berikutnya tidak menunggu timeout yang sama berulang-ulang (lebih cepat).
    static _modelCooldown = new Map(); // model -> timestamp kapan boleh dicoba lagi
    static MODEL_COOLDOWN_MS = 5 * 60 * 1000; // 5 menit

    static isModelOnCooldown(model) {
        const until = this._modelCooldown.get(model);
        return !!until && Date.now() < until;
    }

    static markModelFailed(model) {
        this._modelCooldown.set(model, Date.now() + this.MODEL_COOLDOWN_MS);
    }

    static markModelSuccess(model) {
        this._modelCooldown.delete(model);
    }

    static checkSearchNeed(text) {
        if (!text) return false;
        const lower = text.toLowerCase();

        // 1. If explicitly asking to search/find ("carikan", "cari"), ALWAYS search!
        const explicitSearchTrigger = ["carikan", "cari", "temukan", "lakukan pencarian"];
        const isExplicitSearch = explicitSearchTrigger.some(kw => lower.includes(kw));

        // 2. Text Editing / Grammar Check / Translation Bypass
        const textEditingKeywords = [
            "cek grammar", "grammar", "tata bahasa", "koreksi", "perbaiki", 
            "ejaan", "typo", "terjemahkan", "paraphrase", "bacaan"
        ];

        if (!isExplicitSearch && textEditingKeywords.some(kw => lower.includes(kw))) {
            Logger.info("Pesan meminta koreksi tata bahasa / penyuntingan teks -> Melewati pencarian web.");
            return false;
        }

        // 3. Pure History Operation Bypass
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

        // 4. Identity / General Questions Bypass (Do NOT search web for identity)
        const identityKeywords = ["kamu siapa", "siapa kamu", "siapa anda", "anda siapa", "siapa dirimu", "apa nama bot", "siapa pembuatmu"];
        if (identityKeywords.some(kw => lower.includes(kw))) {
            return false;
        }

        // Use word boundary regex for actual real-time/lookup keywords to avoid false matches
        const searchKeywordsRegex = /\b(carikan|cari|jurnal|paper|sinta|berita|terkini|terbaru|hari ini|cuaca|gempa|kurs|saham|klasemen|juara pildun|jadwal sholat|jadwal bola)\b/i;

        return searchKeywordsRegex.test(lower);
    }

    static buildSearchQuery(userText, history = []) {
        if (!history || history.length === 0) return userText;

        const lastUserMsgs = history
            .filter(m => m.role === "user")
            .slice(-2)
            .map(m => m.content);

        if (lastUserMsgs.length === 0) return userText;

        const lastMsg = lastUserMsgs[lastUserMsgs.length - 1];
        // Only combine if user is clearly referring to the previous context with pronouns
        const isFollowUp = /\b(yang tadi|itu|tersebut|dia|mereka|lanjutkan|linknya|pdfnya|detailnya|sumbernya)\b/i.test(userText.trim());

        if (isFollowUp && lastMsg) {
            const combined = `${lastMsg} ${userText}`.replace(/[?\!.,]/g, " ").trim();
            Logger.info(`Context-Aware Search Query constructed: "${combined}"`);
            return combined;
        }

        return userText;
    }

    static async askWithFallback(messages, temperature = 0.2, maxTokens = CONFIG.LIMITS.MAX_TOKENS_GEN, preferredModel = null) {
        let lastError = null;
        const openrouterKey = ConfigManager.getApiKey("OPENROUTER_API_KEY") || CONFIG.OPENROUTER_API_KEY;

        // 0. Prioritaskan Preferred Model (misal: Nous Hermes 3 saat menggunakan Hermes Agent) jika OpenRouter API Key aktif
        if (preferredModel && openrouterKey && !this.isModelOnCooldown(preferredModel)) {
            try {
                Logger.info(`Memanggil Preferred Model OpenRouter (${preferredModel})...`);
                const response = await axios.post(
                    CONFIG.OPENROUTER_URL,
                    {
                        model: preferredModel,
                        messages,
                        temperature,
                        max_tokens: maxTokens
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${openrouterKey}`,
                            "HTTP-Referer": "https://github.com/Alqurtubi17/citcat",
                            "X-Title": "CitCat Bot",
                            "Content-Type": "application/json"
                        },
                        timeout: CONFIG.TIMEOUTS.OPENROUTER_MS
                    }
                );
                const content = response.data?.choices?.[0]?.message?.content;
                if (content !== undefined && content !== null) {
                    Logger.info(`Preferred Model OpenRouter ${preferredModel} sukses merespons.`);
                    this.markModelSuccess(preferredModel);
                    return content;
                }
            } catch (err) {
                lastError = err;
                this.markModelFailed(preferredModel);
                const errDetail = err.response?.data?.error?.message || err.message;
                Logger.warn(`Preferred Model ${preferredModel} gagal (${err.response?.status || ''} ${errDetail}). Melanjutkan ke model fallback...`);
            }
        }

        // 1. Try Direct Google Gemini Official API First (Ultra-Fast 1-2s Response Engine)
        const geminiApiKey = ConfigManager.getApiKey("GEMINI_API_KEY");
        if (geminiApiKey) {
            try {
                Logger.info("Memanggil Google Gemini Direct API (Ultra-Fast Auto-Fallback Engine)...");
                const geminiReply = await askGeminiDirect(messages, temperature, "gemini-flash-latest", maxTokens);
                if (geminiReply) return geminiReply;
            } catch (err) {
                lastError = err;
                Logger.warn(`Google Gemini Direct API gagal (${err.response?.status || err.message}). Melanjutkan ke OpenRouter Model Chain...`);
            }
        }

        // 2. OpenRouter Model Chain Fallback
        const OPENROUTER_DEPRECATED_MAP = {
            "google/gemini-1.5-pro": "nex-agi/nex-n2.5-pro:free",
            "google/gemini-pro-1.5": "nex-agi/nex-n2.5-pro:free",
            "google/gemini-1.5-flash": "nex-agi/nex-n2.5-mini:free",
            "google/gemini-flash-1.5": "nex-agi/nex-n2.5-mini:free",
            "google/gemini-2.5-flash": "nex-agi/nex-n2.5-mini:free",
            "meta-llama/llama-3.3-70b-instruct:free": "nex-agi/nex-n2.5-pro:free",
            "google/gemma-2-9b-it:free": "nex-agi/nex-n2.5-pro:free",
            "qwen/qwen-2.5-coder-32b-instruct:free": "cohere/north-mini-code:free",
            "deepseek/deepseek-r1-distill-llama-70b:free": "nex-agi/nex-n2.5-pro:free",
            "google/gemma-4-26b-a4b-it:free": "nex-agi/nex-n2.5-pro:free",
            "qwen/qwen3.8-27b:free": "dots-studio/dots-3-note-preview:free",
            "google/gemma-4-31b-it:free": "inclusionai/ling-3.0-flash-vl:free"
        };

        let modelChain = ConfigManager.getModelChain().map(m => OPENROUTER_DEPRECATED_MAP[m] || m);

        // Add guaranteed active free models if not already in chain
        const defaultFreeModels = [
            "nex-agi/nex-n2.5-pro:free",
            "inclusionai/ling-3.0-flash-vl:free",
            "dots-studio/dots-3-note-preview:free",
            "nex-agi/nex-n2.5-mini:free",
            "liquid/lfm-2.5-2.6b:free",
            "cohere/north-mini-code:free"
        ];
        for (const freeModel of defaultFreeModels) {
            if (!modelChain.includes(freeModel)) modelChain.push(freeModel);
        }

        if (openrouterKey) {
            // Pisahkan model yang sedang "cooldown" (baru gagal <5 menit lalu) supaya tidak menunggu timeout berulang
            const readyModels = modelChain.filter(m => !this.isModelOnCooldown(m));
            const cooldownModels = modelChain.filter(m => this.isModelOnCooldown(m));
            const orderedChain = [...readyModels, ...cooldownModels];

            for (const model of orderedChain) {
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
                                "HTTP-Referer": "https://github.com/Alqurtubi17/citcat",
                                "X-Title": "CitCat Bot",
                                "Content-Type": "application/json"
                            },
                            timeout: CONFIG.TIMEOUTS.OPENROUTER_MS
                        }
                    );

                    const content = response.data?.choices?.[0]?.message?.content;
                    if (content !== undefined && content !== null) {
                        Logger.info(`Model OpenRouter ${model} sukses merespons.`);
                        this.markModelSuccess(model);
                        return content;
                    }
                } catch (err) {
                    lastError = err;
                    this.markModelFailed(model);
                    const errDetail = err.response?.data?.error?.message || err.message;
                    Logger.warn(`Model OpenRouter ${model} gagal (${err.response?.status || ''} ${errDetail}). Mencoba model berikutnya...`);
                }
            }
        }

        if (lastError) {
            const status = lastError.response?.status;
            const errData = lastError.response?.data?.error;
            const errDetail = typeof errData === "object" ? (errData.message || JSON.stringify(errData)) : String(errData || lastError.message || "");
            const combinedErr = `${status || ''} ${errDetail} ${lastError.message}`.toLowerCase();

            Logger.error("Seluruh model AI gagal merespons. Detail:", { status, errDetail, message: lastError.message });

            if (status === 404 || combinedErr.includes("404") || combinedErr.includes("not found") || combinedErr.includes("no endpoints found")) {
                return "⚠️ *Model / Endpoint Tidak Ditemukan (404)*\n\nModel AI yang dituju saat ini sedang dinonaktifkan atau dalam transisi versi oleh penyedia layanan. Bot telah otomatis menyesuaikan model cadangan.\n\nUntuk memastikan akses stabil tanpa kendala, pasang Google Gemini API Key gratis Anda:\n1. Kunjungi: https://aistudio.google.com/app/apikey\n2. Klik **Create API Key** (salin yang berawalan `AIzaSy...`)\n3. Ketik di Telegram ini:\n`/setkey GEMINI_API_KEY <api_key_anda>`";
            }

            if (status === 401 || status === 400 || combinedErr.includes("api key not valid") || combinedErr.includes("authentication") || combinedErr.includes("401")) {
                return "⚠️ *Kunci API Key Tidak Valid atau Belum Dikonfigurasi!*\n\nKunci API Key Anda belum disetel atau tidak dikenali oleh penyedia AI.\n\n**Cara Cepat Mendapatkan Kunci Resmi Gratis:**\n1. Buka situs Google: https://aistudio.google.com/app/apikey\n2. Klik **Create API Key**\n3. Ketik di Telegram ini:\n`/setkey GEMINI_API_KEY AIzaSy...`";
            }

            if (status === 429 || combinedErr.includes("quota") || combinedErr.includes("rate limit") || combinedErr.includes("429")) {
                return "⚠️ *Batas Kuota / Rate Limit Tercapai (429)*\n\nLayanan model AI gratis saat ini sedang padat. Silakan tunggu sekitar 20-30 detik lalu ajukan kembali pertanyaan Anda.";
            }

            return `⚠️ *Kendala Layanan AI*\n\n${errDetail || lastError.message}\n\nSilakan coba beberapa saat lagi atau periksa kunci API Anda via \`/status\`.`;
        }

        return "⚠️ Tidak ada model AI yang aktif merespons saat ini. Pastikan kunci API sudah disetel via `/setkey GEMINI_API_KEY <kunci_anda>`.";
    }
}

class TelegramPresenter {
    // Telegram membatasi 1 pesan maksimal 4096 karakter. Sebelumnya jawaban panjang
    // (mis. tabel perbandingan Excel ratusan baris) akan gagal terkirim atau terpotong
    // brutal oleh TextSanitizer. Sekarang dipecah jadi beberapa pesan berurutan,
    // dengan pemotongan di baris terdekat (bukan di tengah kata/baris tabel).
    static TELEGRAM_MAX_CHARS = 3500;

    static splitLongMessage(text, maxChars = this.TELEGRAM_MAX_CHARS) {
        if (text.length <= maxChars) return [text];

        const chunks = [];
        let remaining = text;

        while (remaining.length > maxChars) {
            let cutAt = remaining.lastIndexOf("\n", maxChars);
            if (cutAt < maxChars * 0.5) cutAt = maxChars; // kalau tidak ada newline yang bagus, potong paksa
            chunks.push(remaining.substring(0, cutAt));
            remaining = remaining.substring(cutAt).trimStart();
        }
        if (remaining) chunks.push(remaining);

        return chunks;
    }

    static async reply(ctx, text, extra = {}) {
        const formattedText = TextSanitizer.convertTablesToBullets(text);
        const chunks = this.splitLongMessage(formattedText);

        for (let i = 0; i < chunks.length; i++) {
            const partLabel = chunks.length > 1 ? `_(bagian ${i + 1}/${chunks.length})_\n\n` : "";
            const chunkText = partLabel + chunks[i];
            try {
                await ctx.reply(chunkText, {
                    parse_mode: "Markdown",
                    disable_web_page_preview: true,
                    ...extra
                });
            } catch (err) {
                Logger.warn("Markdown parse failed, falling back to plain text:", err.message);
                await ctx.reply(chunkText, {
                    disable_web_page_preview: true,
                    ...extra
                });
            }
        }
    }
}

function getMainMenuMarkup(chatId = null) {
    const isAdmin = TerminalService.isAuthorizedAdmin(chatId);
    const configuredAdmin = ConfigManager.getAdminUserId();
    const isConfigured = !!configuredAdmin;

    const rows = [
        [
            Markup.button.callback("🧠 Hermes Agent", "MODE_HERMES"),
            Markup.button.callback("💻 Koding Specialist", "MODE_CODING")
        ],
        [
            Markup.button.callback("🖼️ OCR Vision & Excel", "MODE_OCR"),
            Markup.button.callback("🎙️ Transkrip & PDF", "MODE_TRANSCRIBE")
        ],
        [
            Markup.button.callback("📚 Riset & Jurnal", "MODE_RESEARCH"),
            Markup.button.callback("🛠️ DevOps & Linux", "MODE_DEVOPS")
        ],
        [
            Markup.button.callback("🤖 Atur Model AI", "SHOW_MODEL_SETTINGS"),
            Markup.button.callback("🌐 Browser AI", "SHOW_BROWSER_ACCOUNTS")
        ]
    ];

    const utilityRow = [];

    // Hanya tampilkan tombol Admin jika user adalah Admin yang terotorisasi
    // (atau jika belum ada admin yang di-set sama sekali agar owner bisa mendaftar pertama kali).
    if (isAdmin || !isConfigured) {
        utilityRow.push(Markup.button.callback(isAdmin ? "🔑 Status Admin VM" : "🔐 Setup Admin VM", "SHOW_ADMIN_STATUS"));
    }
    if (utilityRow.length > 0) {
        rows.push(utilityRow);
    }

    if (isAdmin) {
        rows.push([
            Markup.button.callback("🩺 Hermes Self-Healing", "SHOW_SELFHEALING"),
            Markup.button.callback("📋 Cek Log Sistem", "SHOW_LOGS")
        ]);
    }

    const bottomRow = [
        Markup.button.callback("🧹 Reset Memori", "RESET_MEMORY")
    ];
    rows.push(bottomRow);

    return Markup.inlineKeyboard(rows);
}

function getModelPresetKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("🧠 Hermes 3 (70B)", "SET_MODEL_hermes"),
            Markup.button.callback("⚡ Gemma 4 (26B Free)", "SET_MODEL_gemma26")
        ],
        [
            Markup.button.callback("💻 Qwen 3.8 (27B Free)", "SET_MODEL_qwen27"),
            Markup.button.callback("🌟 Gemma 4 (31B Free)", "SET_MODEL_gemma31")
        ],
        [
            Markup.button.callback("🚀 Nemotron 3.5 (Free)", "SET_MODEL_nemotron"),
            Markup.button.callback("💎 Claude 3.5 Sonnet", "SET_MODEL_claude35")
        ],
        [
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

if (!CONFIG.TELEGRAM_TOKEN) {
    Logger.error("CRITICAL ERROR: TELEGRAM_TOKEN belum dikonfigurasi pada file .env!");
}

const bot = new Telegraf(CONFIG.TELEGRAM_TOKEN, { handlerTimeout: 600000 });

async function notifyAdminSelfHealingPatch(botInstance, adminChatId, patch) {
    if (!adminChatId || !patch || !patch.patchId) return;
    const msg = `🩺 *[Hermes Self-Healing] Usulan Perbaikan Bug Otomatis*\n\n` +
        `• *ID Patch:* \`${patch.patchId}\`\n` +
        `• *File Target:* \`${patch.fileName || "unknown"}\` (Baris ${patch.errorLine || "?"})\n` +
        `• *Penyebab:* ${patch.errorMessage || "Unknown Error"}\n` +
        `• *Diagnosa Hermes:* ${patch.explanation}\n\n` +
        `*Review Usulan Diff:*\n\`\`\`diff\n${(patch.diffText || "Tidak ada diff visual").substring(0, 1500)}\n\`\`\`\n\n` +
        `_Apakah Anda ingin menerapkan perbaikan ini secara otomatis? (Telah diverifikasi via node --check & backup otomatis dibuat di .backups/)_`;

    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback("✅ Terapkan Patch", `APPLY_PATCH_${patch.patchId}`),
            Markup.button.callback("❌ Tolak Perbaikan", `REJECT_PATCH_${patch.patchId}`)
        ]
    ]);

    try {
        await botInstance.telegram.sendMessage(adminChatId, msg, { parse_mode: "Markdown", ...keyboard });
    } catch (e) {
        Logger.warn("Gagal mengirim notifikasi Hermes Self-Healing ke admin:", e.message);
    }
}

bot.catch(async (err, ctx) => {
    Logger.error(`Telegraf Catch Error (${ctx?.updateType || "unknown"}):`, err.message);
    const adminUserId = ConfigManager.getAdminUserId();
    if (adminUserId) {
        HermesSelfHealing.diagnoseAndProposeFix(err, { updateType: ctx?.updateType })
            .then(patch => {
                if (patch && patch.success) {
                    notifyAdminSelfHealingPatch(bot, adminUserId, patch);
                }
            })
            .catch(e => Logger.warn("Hermes Self-Healing error in bot.catch:", e.message));
    }
});

async function registerTelegramCommandScopes(botInstance) {
    try {
        const publicCommands = [
            { command: "start", description: "Tampilkan menu utama & greeting" },
            { command: "myid", description: "Cek Telegram User ID Anda" },
            { command: "hermes", description: "Hermes Autonomous Reasoning Agent (Nous Hermes 3)" },
            { command: "ocr", description: "OCR Foto/Dokumen ke Excel & PDF (Gemini Vision)" },
            { command: "transcribe", description: "Transkrip Voice/Audio/Video ke PDF (Gemini Pro)" },
            { command: "model", description: "Cek & ganti model AI aktif" },
            { command: "research", description: "Riset Jurnal & Paper Akademik" },
            { command: "coding", description: "Bantuan Fullstack Koding & Scripting" },
            { command: "devops", description: "Bantuan Server, Docker & Linux" },
            { command: "ingat", description: "Simpan ingatan permanen Uteke Engine (/ingat <teks>)" },
            { command: "memori", description: "Lihat ingatan permanen Uteke Engine" },
            { command: "lupa", description: "Hapus ingatan permanen (/lupa <id_atau_kata>)" },
            { command: "singkatan", description: "Lihat memori singkatan kustom" },
            { command: "benar", description: "Konfirmasi jawaban terakhir sudah benar" },
            { command: "salah", description: "Koreksi jawaban terakhir (/salah <jawaban benar>)" },
            { command: "reset", description: "Hapus riwayat percakapan" }
        ];

        const adminCommands = [
            ...publicCommands,
            { command: "selfhealing", description: "Status & perbaikan otomatis Hermes Agent" },
            { command: "rewrite", description: "Rewrite / refactor kode sumber file (/rewrite <file> <instruksi>)" },
            { command: "cmd", description: "Eksekusi perintah terminal VM (/cmd <perintah>)" },
            { command: "setadmin", description: "Set Admin VM (/setadmin <user_id>)" },
            { command: "setkey", description: "Set API Key (/setkey <KEY> <VALUE>)" },
            { command: "logs", description: "Tampilkan log aktivitas & error sistem penting" },
            { command: "gantimodel", description: "Set model utama (/gantimodel <nama>)" },
            { command: "tambahmodel", description: "Tambah model fallback (/tambahmodel <nama>)" }
        ];

        const adminUserId = ConfigManager.getAdminUserId();

        if (!adminUserId) {
            await botInstance.telegram.setMyCommands([
                ...publicCommands,
                { command: "setadmin", description: "Set Admin VM (/setadmin <user_id>)" }
            ], { scope: { type: "default" } });
            Logger.info("Telegram command list registered (Default Scope - Admin not set yet).");
        } else {
            // 1. Scope Publik (Pengguna non-admin HANYA melihat publicCommands)
            await botInstance.telegram.setMyCommands(publicCommands, { scope: { type: "default" } });

            // 2. Scope Admin Khusus (HANYA Chat ID Admin yang melihat adminCommands)
            await botInstance.telegram.setMyCommands(adminCommands, {
                scope: { type: "chat", chat_id: Number(adminUserId) || String(adminUserId) }
            });
            Logger.info(`Telegram command list registered & scoped specifically for Admin ID ${adminUserId}.`);
        }
    } catch (err) {
        Logger.warn("Register Telegram Command Scopes error:", err.message);
    }
}

bot.start(async (ctx) => {
    const chatId = String(ctx.chat.id);
    await TelegramPresenter.reply(
        ctx,
        `Halo 👋 Selamat datang di *CitCat Production AI Agent*!\n\nPilih mode spesialis dari menu tombol interaktif di bawah atau tekan tombol \`/\` di keyboard Telegram Anda:`,
        getMainMenuMarkup(chatId)
    );
});

// SYSTEM LOG COMMANDS
bot.command(["logs", "log"], async (ctx) => {
    const logs = Logger.getRecentLogs(15);
    const logText = logs.join("\n");
    await TelegramPresenter.reply(ctx, `📋 *Log Aktivitas Sistem Penting CitCat (15 Terakhir):*\n\n${logText}`);
});

bot.command("clearlogs", async (ctx) => {
    Logger.clearLogs();
    await TelegramPresenter.reply(ctx, "🧹 *Log sistem berhasil dibersihkan!*");
});

// HERMES AUTONOMOUS SELF-HEALING COMMAND
bot.command(["selfhealing", "heal"], async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!TerminalService.isAuthorizedAdmin(chatId)) {
        await TelegramPresenter.reply(ctx, "⛔ Akses ditolak. Fitur Hermes Self-Healing hanya dapat diakses oleh Admin terotorisasi.");
        return;
    }

    const pendingPatches = HermesSelfHealing.getAllPendingPatches();
    const backups = HermesSelfHealing.listBackups(5);

    let text = `🩺 *Hermes Autonomous Self-Healing Engine*\n\n` +
        `• *Status:* 🟢 Aktif & Siaga\n` +
        `• *Model Perbaikan:* \`nousresearch/hermes-3-llama-3.1-70b\` (Fallback: Gemini Flash)\n` +
        `• *Keamanan:* Sandboxed Syntax Check (\`node --check\`) + Auto-Rollback + Timestamped Backup\n\n`;

    if (pendingPatches.length > 0) {
        text += `⚠️ *Ada ${pendingPatches.length} Usulan Patch Menunggu Persetujuan:*\n`;
        for (const p of pendingPatches) {
            text += `\n• *ID:* \`${p.id}\` | *File:* \`${p.fileName}:${p.errorLine}\`\n  ${p.explanation}\n`;
        }
        text += `\nGunakan tombol di bawah pesan notifikasi usulan untuk menerapkan atau menolak.`;
    } else {
        text += `✨ *Tidak ada bug yang tertunda.* Sistem berjalan normal.\n\n`;
    }

    if (backups.length > 0) {
        text += `💾 *Riwayat Backup Kode (.backups/):*\n`;
        for (const b of backups) {
            const timeStr = new Date(b.time).toLocaleString("id-ID");
            text += `• \`${b.file}\` (${Math.round(b.size / 1024)} KB) — _${timeStr}_\n`;
        }
    } else {
        text += `💾 *Direktori Backup:* \`.backups/\` (Belum ada file backup)`;
    }

    let inlineKeyboard = [];
    if (pendingPatches.length > 0) {
        for (const p of pendingPatches) {
            inlineKeyboard.push([
                Markup.button.callback(`✅ Terapkan ${p.id}`, `APPLY_PATCH_${p.id}`),
                Markup.button.callback(`❌ Tolak ${p.id}`, `REJECT_PATCH_${p.id}`)
            ]);
        }
    }

    await TelegramPresenter.reply(ctx, text, inlineKeyboard.length > 0 ? Markup.inlineKeyboard(inlineKeyboard) : undefined);
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

// SELF-LEARNING FEEDBACK COMMANDS
bot.command("benar", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const last = lastExchangeMap.get(chatId);

    if (!last) {
        await TelegramPresenter.reply(ctx, "⚠️ Belum ada jawaban terakhir yang bisa dikonfirmasi di sesi ini.");
        return;
    }

    MemoryManager.storeLongTermMemory(
        chatId,
        `[Terverifikasi Benar oleh User] Q: "${last.question}" -> A: "${last.answer.substring(0, 400)}"`,
        ["verified", "feedback-positive"]
    );
    Logger.info(`[Feedback Engine] Jawaban dikonfirmasi BENAR oleh user (${chatId}): "${last.question}"`);
    await TelegramPresenter.reply(ctx, "✅ *Terima kasih atas konfirmasinya!* Saya akan mengingat bahwa jawaban tadi sudah benar.");
});

bot.command("salah", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);
    const correction = parts.slice(1).join(" ").trim();
    const last = lastExchangeMap.get(chatId);

    if (!correction) {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/salah <jawaban_yang_benar>`\n\nContoh:\n`/salah Ketua RT nya adalah Pak Budi, bukan Pak Andi`");
        return;
    }

    const questionRef = last ? last.question : "(pertanyaan sebelumnya tidak diketahui)";

    // Disimpan dengan tag prioritas tinggi supaya idealnya diprioritaskan
    // oleh recallMemories() di atas fakta hasil self-learning biasa.
    MemoryManager.storeLongTermMemory(
        chatId,
        `[KOREKSI PRIORITAS TINGGI] Untuk pertanyaan "${questionRef}", jawaban yang BENAR adalah: ${correction}`,
        ["correction", "high-priority"]
    );

    // Buang entri cache lama untuk pertanyaan ini supaya jawaban salah tidak terulang dari cache.
    if (last?.question) {
        AiService._localCache.delete(AiService._cacheKey(last.question));
    }

    Logger.info(`[Feedback Engine] Koreksi disimpan untuk chat ${chatId}: "${correction}"`);
    await TelegramPresenter.reply(ctx, `📝 *Koreksi Tersimpan!*\nSaya akan menggunakan informasi ini untuk pertanyaan serupa ke depannya:\n\n"${correction}"`);
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
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/gantimodel <nama_model>`\n\nContoh: `/gantimodel google/gemini-2.5-flash`");
        return;
    }

    const newModel = parts[1].trim();
    ConfigManager.setPrimaryModel(newModel);
    Logger.info(`Model utama diganti oleh pengguna ke: ${newModel}`);
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
    Logger.info(`Model ${newModel} ditambahkan ke fallback chain.`);
    await TelegramPresenter.reply(ctx, `✅ *Model Berhasil Ditambahkan ke Fallback Chain!*\n\nDaftar Chain saat ini:\n${chain.map(m => `• \`${m}\``).join("\n")}`);
});

bot.command("setkey", async (ctx) => {
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    let keyName = "";
    let keyValue = "";

    if (parts.length >= 3) {
        keyName = parts[1].trim().toUpperCase();
        keyValue = parts.slice(2).join(" ").trim();
    } else if (parts.length === 2) {
        keyValue = parts[1].trim();
        if (keyValue.startsWith("sk-or-")) {
            keyName = "OPENROUTER_API_KEY";
        } else {
            keyName = "GEMINI_API_KEY";
        }
    } else {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/setkey <NAMA_KEY> <VALUE_KEY>` atau cukup `/setkey <VALUE_KEY>`\n\nContoh:\n`/setkey GEMINI_API_KEY AIzaSy...`\n`/setkey AQ.Ab8RN6...`");
        return;
    }

    keyValue = keyValue.replace(/^["']|["']$/g, "").trim();

    ConfigManager.setApiKey(keyName, keyValue);
    Logger.info(`API Key ${keyName} berhasil diperbarui.`);
    await TelegramPresenter.reply(ctx, `🔑 *API Key Berhasil Disimpan!*\n\n• Key: \`${keyName}\`\n• Status: Tersimpan aman di server VM Anda`);
});

// SYSTEM TERMINAL & ADMIN EXECUTION COMMANDS
bot.command("myid", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const isAdmin = TerminalService.isAuthorizedAdmin(chatId);
    await TelegramPresenter.reply(ctx, `🆔 *ID Telegram Anda:* \`${chatId}\`\n\n• Status Admin: ${isAdmin ? "✅ *TEROTORISASI (ADMIN)*" : "❌ *Bukan Admin*"}\n\n*Pasang Admin:* \`/setadmin ${chatId}\``);
});

bot.command("setadmin", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const currentAdmin = ConfigManager.getAdminUserId();

    if (currentAdmin && !TerminalService.isAuthorizedAdmin(chatId)) {
        await TelegramPresenter.reply(ctx, `⛔ *Akses Ditolak!*\n\nAdmin VM sudah terkonfigurasi untuk ID: \`${currentAdmin}\`.\nHanya Admin terdaftar yang berhak merubah ID Admin.`);
        return;
    }

    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
        await TelegramPresenter.reply(ctx, `⚠️ *Format Salah!*\nGunakan format: \`/setadmin <user_id>\`\n\nID Telegram Anda: \`${chatId}\`\nKetik: \`/setadmin ${chatId}\` untuk mendaftarkan akun ini sebagai Admin VM.`);
        return;
    }

    const targetAdminId = parts[1].trim();
    ConfigManager.setAdminUserId(targetAdminId);
    Logger.info(`Admin User ID diperbarui ke: ${targetAdminId}`);

    // Update command scope di Telegram secara real-time!
    await registerTelegramCommandScopes(bot);

    await TelegramPresenter.reply(ctx, `🔐 *Admin User ID Berhasil Disimpan!*\n\n• ID Admin Aktif: \`${targetAdminId}\`\n• Perintah Admin (/cmd, /setadmin, /setkey, /logs) sekarang di-scope khusus HANYA untuk akun ini.\n• Pengguna publik/non-admin tidak akan lagi melihat menu admin di keyboard Telegram mereka!`);
});

bot.command(["cmd", "exec", "sys", "terminal"], async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!TerminalService.isAuthorizedAdmin(chatId)) {
        await TelegramPresenter.reply(ctx, `⛔ *Akses Ditolak!*\n\nAnda tidak memiliki izin untuk mengeksekusi perintah terminal di VM ini.\n\nID Anda: \`${chatId}\`\nJika ini server Anda, set akun ini sebagai Admin dengan perintah:\n\`/setadmin ${chatId}\``);
        return;
    }

    const text = ctx.message.text.trim();
    const commandToRun = text.replace(/^\/(cmd|exec|sys|terminal)\s*/i, "").trim();

    if (!commandToRun) {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format: `/cmd <perintah_terminal>`\n\nContoh:\n`/cmd pm2 status`\n`/cmd dir` atau `/cmd ls -la`\n`/cmd git status`");
        return;
    }

    await TelegramPresenter.reply(ctx, `⚙️ *Mengeksekusi perintah di VM:* \`${commandToRun}\`...\n\nHarap tunggu...`);
    await ctx.sendChatAction("typing");

    const result = await TerminalService.executeCommand(commandToRun);
    const statusEmoji = result.success ? "✅" : "❌";
    
    await TelegramPresenter.reply(ctx, `${statusEmoji} *Hasil Eksekusi Terminal:* \`[Code ${result.code}]\`\n\n\`\`\`text\n${result.output}\n\`\`\``);
});

bot.command("rewrite", async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!TerminalService.isAuthorizedAdmin(chatId)) {
        await TelegramPresenter.reply(ctx, "⛔ Akses ditolak. Hanya Admin terotorisasi yang dapat me-rewrite kode server.");
        return;
    }

    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
        await TelegramPresenter.reply(ctx, "⚠️ *Format Salah!*\nGunakan format:\n`/rewrite <file_path> <instruksi_rewrite>`\n\nContoh:\n`/rewrite agents/hermes.js perbaiki prompt penalaran`\n`/rewrite configManager.js tambahkan model baru`");
        return;
    }

    const targetFile = parts[1].trim();
    const instruction = parts.slice(2).join(" ").trim();

    const readResult = TerminalService.readFile(targetFile);
    if (!readResult.success) {
        await TelegramPresenter.reply(ctx, `❌ Gagal membaca file target: ${readResult.error}\nPastikan path file relatif terhadap root proyek.`);
        return;
    }

    await TelegramPresenter.reply(ctx, `🧠 *Hermes Autonomous Code Rewrite Aktif*\n• *File Target:* \`${targetFile}\` (${readResult.totalLines} baris)\n• *Instruksi:* ${instruction}\n\nSedang menganalisis kode dan menerapkan perbaikan/rewrite... (Mohon tunggu sebentar)`);
    await ctx.sendChatAction("typing");

    const systemPrompt = hermesAgent.getPrompt() +
        `\n\n[INFORMASI SERVING VM REAL-TIME]: OS: ${process.platform} | Node.js: ${process.version} | Working Directory: ${process.cwd()} | Admin Status: TEROTORISASI` +
        `\n${AutonomousToolService.getToolSystemPrompt(process.platform)}`;

    const userPrompt = `[PERINTAH REWRITE KODE DARI ADMIN]:
File Target: ${targetFile}
Instruksi Rewrite: ${instruction}

Kutipan Isi File Sumber Saat Ini:
\`\`\`
${readResult.content}
\`\`\`

TUGASMU:
Lakukan rewrite atau perbaikan pada file di atas sesuai instruksi Admin.
Gunakan tag <replace_in_file path="${targetFile}"> untuk mengganti potongan kode yang ditargetkan secara presisi, ATAU tag <write_file path="${targetFile}"> jika menulis ulang seluruh file.
Pastikan kode hasil perbaikan memiliki sintaks yang valid, aman, dan siap jalan.`;

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ];

    try {
        const rewriteResult = await AutonomousToolService.runAutonomousLoop({
            messages,
            askAiFn: (msgs) => AiService.askWithFallback(msgs, 0.1, CONFIG.LIMITS.MAX_TOKENS_GEN, hermesAgent.preferredModel),
            onProgress: async (progressText) => {
                try {
                    await ctx.sendChatAction("typing");
                    await TelegramPresenter.reply(ctx, progressText);
                } catch (e) {
                    Logger.warn("Rewrite progress notification error:", e.message);
                }
            },
            maxIterations: 4
        });

        const finalReport = TextSanitizer.sanitizeOutput(AutonomousToolService.cleanToolTags(rewriteResult)) || "Proses rewrite selesai tanpa laporan teks.";
        await TelegramPresenter.reply(ctx, `✅ *Laporan Selesai Rewrite Kode (Hermes Agent):*\n\n${finalReport}`);
    } catch (err) {
        Logger.error("Error during /rewrite:", err.message);
        await TelegramPresenter.reply(ctx, `❌ Terjadi kendala saat proses rewrite: ${err.message}`);
    }
});

bot.command("ocr", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "OCR");
    await TelegramPresenter.reply(ctx, "🖼️ Mode diaktifkan: *OCR Vision & Data Specialist (Google Gemini Vision)*\n\nKirimkan foto/scan dokumen, kuitansi, nota, atau tabel. Bot akan mengekstrak teksnya dan mengonversi sesuai permintaan Anda (**Excel .xlsx**, **PDF**, atau **Teks**)!");
});

// ─── BROWSER AI (PLAYWRIGHT) COMMANDS ─────────────────────────────────────────

// /setbrowser gemini akun1 email@gmail.com password123
bot.command("setbrowser", async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 5) {
        await TelegramPresenter.reply(ctx,
            "⚠️ *Format Salah!*\nGunakan:\n`/setbrowser <layanan> <alias> <email> <password>`\n\n*Layanan tersedia:* `gemini`, `notebooklm`, `chatgpt`\n\nContoh:\n`/setbrowser gemini akun1 emailku@gmail.com passwordku`");
        return;
    }
    const [, serviceId, alias, email, ...passParts] = parts;
    const password = passParts.join(" ");
    const key = saveBrowserAccount(serviceId.toLowerCase(), alias, email, password);
    Logger.info(`Browser account "${key}" ditambahkan.`);
    await TelegramPresenter.reply(ctx, `✅ *Akun Browser Berhasil Disimpan!*\n\n• Layanan: \`${serviceId}\`\n• Alias: \`${alias}\`\n• Email: \`${email}\`\n\nGunakan dengan: \`/browser ${serviceId} ${alias} <pertanyaan Anda>\``);
});

// /browser gemini akun1 Apa itu AI?
bot.command("browser", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 4) {
        await TelegramPresenter.reply(ctx,
            "⚠️ *Format Salah!*\nGunakan:\n`/browser <layanan> <alias> <pertanyaan>`\n\nContoh:\n`/browser gemini akun1 Apa itu machine learning?`");
        return;
    }
    const [, serviceId, alias, ...promptParts] = parts;
    const userPrompt = promptParts.join(" ");

    await TelegramPresenter.reply(ctx, `🌐 *Browser AI Aktif!*\nMenembakkan pertanyaan ke *${serviceId}* (akun: \`${alias}\`)...\n\nHarap tunggu 20-30 detik...`);
    await ctx.sendChatAction("typing");

    try {
        const result = await askViaBrowser(serviceId.toLowerCase(), alias, userPrompt, 25000);
        if (!result) throw new Error("Tidak ada respons yang diterima dari browser.");

        // Simpan ke Uteke Memory sebagai pengetahuan baru
        const learnedFact = `[Browser AI - ${serviceId}]: Q: ${userPrompt.substring(0, 100)} -> A: ${result.substring(0, 300)}`;
        MemoryManager.storeLongTermMemory(chatId, learnedFact, ["browser-ai", serviceId]);
        Logger.info(`[Browser AI] Self-learned from ${serviceId}: "${userPrompt.substring(0, 60)}..."`);

        await TelegramPresenter.reply(ctx, `🌐 *Jawaban dari ${BROWSER_SERVICES[serviceId.toLowerCase()]?.name || serviceId}:*\n\n${result}\n\n_[Hasil telah disimpan ke memori Uteke untuk pembelajaran mandiri]_`);
    } catch (err) {
        Logger.error(`Browser AI error (${serviceId}:${alias}):`, err.message);
        await TelegramPresenter.reply(ctx, `❌ *Browser AI Gagal:* ${err.message}\n\nPastikan akun sudah ditambahkan via \`/setbrowser\` dan kredensialnya valid.`);
    }
});

// /delbrowser gemini akun1
bot.command("delbrowser", async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 3) {
        await TelegramPresenter.reply(ctx, "⚠️ Format: `/delbrowser <layanan> <alias>`");
        return;
    }
    const [, serviceId, alias] = parts;
    const key = `${serviceId.toLowerCase()}:${alias}`;
    const removed = removeBrowserAccount(key);
    if (removed) {
        await TelegramPresenter.reply(ctx, `🗑️ Akun \`${key}\` berhasil dihapus dari Browser AI.`);
    } else {
        await TelegramPresenter.reply(ctx, `⚠️ Akun \`${key}\` tidak ditemukan.`);
    }
});

// /browserlist
bot.command("browserlist", async (ctx) => {
    const accounts = listBrowserAccounts();
    const keys = Object.keys(accounts);

    if (keys.length === 0) {
        await TelegramPresenter.reply(ctx, "🌐 *Browser AI:* Belum ada akun terdaftar.\n\nTambahkan via: `/setbrowser <layanan> <alias> <email> <password>`");
        return;
    }

    const list = keys.map((k, i) => {
        const a = accounts[k];
        return `${i + 1}. *[${a.serviceId}]* \`${a.alias}\` — ${a.email}`;
    }).join("\n");

    await TelegramPresenter.reply(ctx, `🌐 *Browser AI — Daftar Akun Terdaftar:*\n\n${list}`);
});

// CALLBACK BUTTON HANDLERS
bot.action("SHOW_SELFHEALING", async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!TerminalService.isAuthorizedAdmin(chatId)) {
        await ctx.answerCbQuery("⛔ Akses ditolak. Hanya Admin terotorisasi.", { show_alert: true });
        return;
    }
    await ctx.answerCbQuery();
    const pendingPatches = HermesSelfHealing.getAllPendingPatches();
    const backups = HermesSelfHealing.listBackups(5);

    let text = `🩺 *Hermes Autonomous Self-Healing Engine*\n\n` +
        `• *Status:* 🟢 Aktif & Siaga\n` +
        `• *Model Perbaikan:* \`nousresearch/hermes-3-llama-3.1-70b\` (Fallback: Gemini Flash)\n` +
        `• *Keamanan:* Sandboxed Syntax Check (\`node --check\`) + Auto-Rollback + Timestamped Backup\n\n`;

    if (pendingPatches.length > 0) {
        text += `⚠️ *Ada ${pendingPatches.length} Usulan Patch Menunggu Persetujuan:*\n`;
        for (const p of pendingPatches) {
            text += `\n• *ID:* \`${p.id}\` | *File:* \`${p.fileName}:${p.errorLine}\`\n  ${p.explanation}\n`;
        }
    } else {
        text += `✨ *Tidak ada bug yang tertunda.* Sistem berjalan normal.\n\n`;
    }

    if (backups.length > 0) {
        text += `💾 *Riwayat Backup Kode (.backups/):*\n`;
        for (const b of backups) {
            const timeStr = new Date(b.time).toLocaleString("id-ID");
            text += `• \`${b.file}\` (${Math.round(b.size / 1024)} KB) — _${timeStr}_\n`;
        }
    }

    let inlineKeyboard = [];
    if (pendingPatches.length > 0) {
        for (const p of pendingPatches) {
            inlineKeyboard.push([
                Markup.button.callback(`✅ Terapkan ${p.id}`, `APPLY_PATCH_${p.id}`),
                Markup.button.callback(`❌ Tolak ${p.id}`, `REJECT_PATCH_${p.id}`)
            ]);
        }
    }

    await TelegramPresenter.reply(ctx, text, inlineKeyboard.length > 0 ? Markup.inlineKeyboard(inlineKeyboard) : undefined);
});

bot.action(/^APPLY_PATCH_(.+)$/, async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!TerminalService.isAuthorizedAdmin(chatId)) {
        await ctx.answerCbQuery("⛔ Akses ditolak. Hanya Admin terotorisasi.", { show_alert: true });
        return;
    }
    const patchId = ctx.match[1];
    await ctx.answerCbQuery("Menerapkan patch kode...");
    try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch {
        // ignore
    }

    try {
        const result = await HermesSelfHealing.applyPatch(patchId);
        if (result && result.success) {
            await TelegramPresenter.reply(
                ctx,
                `✅ *Patch Berhasil Diterapkan!*\n\n• *File:* \`${result.fileName}\`\n• *Backup:* \`${result.backupPath}\`\n• *Validasi Sintaks:* LULUS (\`node --check\` OK)\n\nSilakan restart bot jika diperlukan (\`/cmd pm2 restart citcat\` atau sesuai konfigurasi).`
            );
        }
    } catch (err) {
        await TelegramPresenter.reply(
            ctx,
            `❌ *Gagal Menerapkan Patch:*\n${err.message}`
        );
    }
});

bot.action(/^REJECT_PATCH_(.+)$/, async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!TerminalService.isAuthorizedAdmin(chatId)) {
        await ctx.answerCbQuery("⛔ Akses ditolak.", { show_alert: true });
        return;
    }
    const patchId = ctx.match[1];
    HermesSelfHealing.rejectPatch(patchId);
    await ctx.answerCbQuery("Patch ditolak.");
    try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch {
        // ignore
    }
    await TelegramPresenter.reply(ctx, `❌ Patch \`${patchId}\` telah dibatalkan dan dihapus dari antrean perbaikan.`);
});

bot.action("SHOW_LOGS", async (ctx) => {
    const logs = Logger.getRecentLogs(15);
    const logText = logs.join("\n");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, `📋 *Log Aktivitas Sistem Penting CitCat (15 Terakhir):*\n\n${logText}`);
});

bot.action("SHOW_ADMIN_STATUS", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const isAdmin = TerminalService.isAuthorizedAdmin(chatId);
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, `🆔 *Status Admin & ID Telegram Anda:*\n\n• User ID: \`${chatId}\`\n• Status Otorisasi: ${isAdmin ? "✅ *TEROTORISASI (ADMIN)*" : "❌ *Bukan Admin*"}\n\n*Perintah Admin VM:*\n• Set Admin: \`/setadmin ${chatId}\`\n• Cek ID: \`/myid\`\n• Perintah Terminal: \`/cmd <perintah>\` (misal: \`/cmd pm2 status\`)`);
});

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

bot.action("SHOW_BROWSER_ACCOUNTS", async (ctx) => {
    await ctx.answerCbQuery();
    const accounts = listBrowserAccounts();
    const keys = Object.keys(accounts);

    const servicesList = Object.entries(BROWSER_SERVICES)
        .map(([id, s]) => `• \`${id}\` — ${s.name}`)
        .join("\n");

    if (keys.length === 0) {
        await TelegramPresenter.reply(ctx,
            `🌐 *Browser AI (Playwright Engine)*\n\nBelum ada akun terdaftar.\n\n*Layanan yang Didukung:*\n${servicesList}\n\n*Tambah Akun:*\n\`/setbrowser <layanan> <alias> <email> <password>\`\n\nContoh:\n\`/setbrowser gemini akun1 email@gmail.com passwordku\`\n\`/setbrowser notebooklm kerja email@gmail.com pass123\`\n\`/setbrowser chatgpt utama email@gmail.com pass456\``
        );
        return;
    }

    const accountList = keys.map((k, i) => {
        const a = accounts[k];
        return `${i + 1}. *[${a.serviceId}]* \`${a.alias}\` — ${a.email} _(ditambahkan ${new Date(a.addedAt).toLocaleDateString("id-ID")})_`;
    }).join("\n");

    await TelegramPresenter.reply(ctx,
        `🌐 *Browser AI — Daftar Akun Terdaftar:*\n\n${accountList}\n\n*Gunakan Akun:* \`/browser <layanan> <alias> <pertanyaan>\`\nContoh: \`/browser gemini akun1 Apa itu blockchain?\`\n\n*Hapus Akun:* \`/delbrowser <layanan> <alias>\`\n*Tambah Akun Baru:* \`/setbrowser <layanan> <alias> <email> <password>\``
    );
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

bot.action("SET_MODEL_hermes", async (ctx) => {
    ConfigManager.setPrimaryModel("nousresearch/hermes-3-llama-3.1-70b");
    Logger.info("Model diganti ke: nousresearch/hermes-3-llama-3.1-70b");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `nousresearch/hermes-3-llama-3.1-70b` (Nous Hermes 3 Reasoning Engine)");
});

bot.action("SET_MODEL_gemma26", async (ctx) => {
    ConfigManager.setPrimaryModel("google/gemma-4-26b-a4b-it:free");
    Logger.info("Model diganti ke: google/gemma-4-26b-a4b-it:free");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `google/gemma-4-26b-a4b-it:free` (Free Fast Engine)");
});

bot.action("SET_MODEL_qwen27", async (ctx) => {
    ConfigManager.setPrimaryModel("qwen/qwen3.8-27b:free");
    Logger.info("Model diganti ke: qwen/qwen3.8-27b:free");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `qwen/qwen3.8-27b:free` (Free Reasoning Engine)");
});

bot.action("SET_MODEL_gemma31", async (ctx) => {
    ConfigManager.setPrimaryModel("google/gemma-4-31b-it:free");
    Logger.info("Model diganti ke: google/gemma-4-31b-it:free");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `google/gemma-4-31b-it:free` (Free High-Precision Engine)");
});

bot.action("SET_MODEL_nemotron", async (ctx) => {
    ConfigManager.setPrimaryModel("nvidia/nemotron-3.5-lightning:free");
    Logger.info("Model diganti ke: nvidia/nemotron-3.5-lightning:free");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `nvidia/nemotron-3.5-lightning:free`");
});

bot.action("SET_MODEL_claude35", async (ctx) => {
    ConfigManager.setPrimaryModel("anthropic/claude-3.5-sonnet");
    Logger.info("Model diganti ke: anthropic/claude-3.5-sonnet");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `anthropic/claude-3.5-sonnet`");
});

bot.action("SET_MODEL_gpt4o", async (ctx) => {
    ConfigManager.setPrimaryModel("openai/gpt-4o");
    Logger.info("Model diganti ke: openai/gpt-4o");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "✅ Model utama diganti ke: `openai/gpt-4o`");
});

bot.action("MODE_HERMES", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "HERMES");
    await ctx.answerCbQuery();
    await TelegramPresenter.reply(ctx, "🧠 Mode diaktifkan: *Hermes Autonomous & Reasoning Agent (Nous Hermes 3)*\n\nSpesialis penalaran mendalam, analisis multi-langkah, logika pemecahan masalah kompleks, dan eksekusi tugas otonom. Silakan sampaikan instruksi Anda!");
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
    Logger.info(`Riwayat percakapan dihapus untuk chat: ${chatId}`);
    await ctx.answerCbQuery();
    await ctx.reply("🧹 Riwayat percakapan berhasil dihapus!");
});

bot.command("reset", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.clear(chatId);
    Logger.info(`Riwayat percakapan dihapus untuk chat: ${chatId}`);
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

bot.command("hermes", async (ctx) => {
    const chatId = String(ctx.chat.id);
    MemoryManager.setMode(chatId, "HERMES");
    await TelegramPresenter.reply(ctx, "🧠 Mode diaktifkan: *Hermes Autonomous & Reasoning Agent (Nous Hermes 3)*\n\nSpesialis penalaran mendalam, analisis multi-langkah, logika pemecahan masalah kompleks, dan eksekusi tugas otonom. Silakan sampaikan instruksi Anda!");
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
bot.on(["photo"], async (ctx, next) => {
    try {
        const message = ctx.message;
        const photos = message.photo;

        if (!photos || photos.length === 0) return next();

        const fileId = photos[photos.length - 1].file_id;
        const mimeType = "image/jpeg";
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
            Logger.info("Berhasil meng-generate file Excel (.xlsx) dari OCR.");
        }

        // Send PDF file ONLY if PDF is requested or if plain document text and user didn't ask ONLY Excel/Text
        if (asksPdf || (!tableData && !asksExcel && !asksText)) {
            const pdfBuffer = await createPdfBuffer("HASIL OCR DOKUMEN (Google Gemini Vision)", ocrText);
            await ctx.replyWithDocument({
                source: pdfBuffer,
                filename: "Hasil_OCR_Dokumen.pdf"
            });
            Logger.info("Berhasil meng-generate file PDF (.pdf) dari OCR.");
        }

    } catch (err) {
        Logger.error("OCR Processing Error:", err.message);
        await TelegramPresenter.reply(ctx, `❌ Gagal memproses OCR gambar: ${err.message}`);
    }
});

// MEDIA HANDLER (Voice Notes, Audio, Video Files)
bot.on(["voice", "audio", "video"], async (ctx, next) => {
    try {
        const message = ctx.message;
        const fileObj = message.voice || message.audio || message.video;

        if (!fileObj) return next();

        const mimeType = message.voice ? "audio/ogg" : (fileObj.mime_type || "audio/mp3");

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
        Logger.info("Berhasil meng-generate PDF Transkrip & Rangkuman Media.");

    } catch (err) {
        Logger.error("Media Processing Error:", err.message);
        await TelegramPresenter.reply(ctx, `❌ Gagal memproses media: ${err.message}`);
    }
});

// SELF-LEARNING FEEDBACK ENGINE: menyimpan pertukaran (pertanyaan, jawaban) terakhir
// per chat, supaya user bisa mengoreksi via /benar atau /salah <koreksi>.
const lastExchangeMap = new Map(); // chatId -> { question, answer }

// DOCUMENT / EXCEL FILE HANDLER (DEEP MULTI-SHEET DATA ANALYSIS ENGINE)
// MULTI-DOCUMENT BATCH QUEUE COLLECTOR ENGINE
const documentBatchMap = new Map();

// Simpan hasil diff terakhir per chatId agar user bisa minta ulang file Excel kapan saja
// mis. "kirim excelnya" / "hasil excelnya" tanpa perlu upload file ulang.
const lastDiffResultMap = new Map(); // chatId -> diffResult

async function processDocumentBatch(ctx, batch) {
    try {
        await ctx.reply(`🔍 *Sedang menganalisis ${batch.files.length} berkas Excel secara bersamaan via Google Gemini Pro...*`);
        await ctx.sendChatAction("typing");

        let combinedExtractedContext = "";

        for (const file of batch.files) {
            if (file.isExcel) {
                combinedExtractedContext += parseExcelFileBuffer(file.buffer, file.filename) + "\n\n";
            } else {
                combinedExtractedContext += `\n--- BERKAS DOKUMEN: ${file.filename} ---\n` + file.buffer.toString("utf-8").substring(0, 10000) + "\n\n";
            }
        }

        const userCaption = batch.caption || "Tolong analisa seluruh berkas terlampir secara teliti, cocokkan data antar file & sheet, dan sajikan hasilnya dalam bentuk tabel Markdown yang rapi.";
        const currentDateWib = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "full", timeStyle: "medium" });

        // MESIN DIFF DETERMINISTIK: kalau caption user berpola "cocokkan/bandingkan
        // ... kecuali sheet X ... dengan sheet Y", hitung selisih data SECARA PASTI
        // di kode (bukan cuma minta LLM menebak dari teks mentah). Ini menjamin
        // kelengkapan hasil untuk perbandingan ratusan baris yang tidak reliable
        // kalau diserahkan sepenuhnya ke LLM. Sepenuhnya defensif -- kalau gagal
        // mendeteksi struktur apapun, fallback normal ke analisis LLM biasa.
        let autoComputedBlock = "";
        try {
            const excelFiles = batch.files.filter(f => f.isExcel);
            if (excelFiles.length >= 2) {
                const captionLower = userCaption.toLowerCase();

                // Deteksi sheet yang harus dikecualikan dari caption, contoh:
                // "kecuali sheet Notes Bahan Makanan dan Master Menu"
                const excludeSheetNames = [];
                const excludeMatch = userCaption.match(/kecuali sheet ([^.]+?)(?:,? dengan|\.|$)/i);
                if (excludeMatch) {
                    excludeMatch[1].split(/,| dan /i).map(s => s.trim()).filter(Boolean).forEach(s => excludeSheetNames.push(s));
                }

                // Deteksi nama sheet referensi, contoh: "dengan sheet di Excel Daftar
                // Produk Bahan SPPG (sheet Produk)" -> ambil "Produk"
                const referenceSheetHints = [];
                const refMatch = userCaption.match(/sheet\s+([a-z0-9 _-]+?)\)/i) || userCaption.match(/\(sheet\s+([a-z0-9 _-]+)\)/i);
                if (refMatch) referenceSheetHints.push(refMatch[1].trim());

                const diffResult = computeCrossFileMissingItems(excelFiles, { excludeSheetNames, referenceSheetHints });

                // Persist result for later Excel export via chat ("kirim excelnya")
                if (diffResult) {
                    const batchChatId = String(ctx.chat.id);
                    lastDiffResultMap.set(batchChatId, diffResult);
                }

                if (diffResult && diffResult.missing.length > 0) {
                    // KIRIM LANGSUNG hasil deterministik sebagai jawaban utama, TANPA
                    // dititipkan ke LLM untuk ditranskrip ulang. LLM (bahkan dengan
                    // instruksi eksplisit) tetap berisiko meringkas/melewatkan sebagian
                    // baris kalau daftarnya panjang -- ini menjamin 100% lengkap karena
                    // langsung dari hasil perhitungan kode, bukan hasil LLM menyalin ulang.
                    const grouped = new Map(); // sheet -> [values]
                    for (const m of diffResult.missing) {
                        if (!grouped.has(m.sheet)) grouped.set(m.sheet, []);
                        grouped.get(m.sheet).push(m.value);
                    }

                    let tableMd = `📋 *Hasil Perbandingan Otomatis (Deterministik)*\n\n` +
                        `Dibandingkan terhadap sheet referensi *"${diffResult.referenceSheets.join(", ")}"* di berkas \`${diffResult.referenceFile}\`.\n` +
                        `Ditemukan *${diffResult.missing.length} item* yang ada di data sumber tapi belum terdaftar:\n\n`;

                    let counter = 1;
                    for (const [sheet, values] of grouped.entries()) {
                        tableMd += `\n*${sheet}* (${values.length} item):\n`;
                        tableMd += `| No | Nama Item |\n|---|---|\n`;
                        for (const v of values) {
                            tableMd += `| ${counter} | ${v} |\n`;
                            counter++;
                        }
                    }

                    tableMd += `\n_Dihitung otomatis & pasti oleh sistem (bukan estimasi AI) -- membandingkan setiap sel data terhadap sheet referensi, bukan sampling._`;

                    Logger.info(`Auto-diff engine: ${diffResult.missing.length} item missing terdeteksi & dikirim langsung (deterministik).`);
                    await TelegramPresenter.reply(ctx, TextSanitizer.sanitizeOutput(tableMd));

                    // Kirim juga file .xlsx hasil diff secara langsung ke Telegram
                    try {
                        const xlsxRows = [["No", "Sheet Sumber", "Nama Item"]];
                        let rowNo = 1;
                        for (const m of diffResult.missing) {
                            xlsxRows.push([rowNo++, m.sheet, m.value]);
                        }
                        const xlsxBuf = createExcelBuffer(xlsxRows, "Item Belum Ada");
                        await ctx.replyWithDocument({ source: xlsxBuf, filename: `CitCat_Diff_${Date.now()}.xlsx` }, { caption: `📎 *File Excel hasil perbandingan deterministik (${diffResult.missing.length} item belum terdaftar)*` });
                    } catch (xlsxErr) {
                        Logger.warn("Gagal mengirim file xlsx diff:", xlsxErr.message);
                    }
                    return; // selesai -- tidak perlu panggil LLM lagi untuk kasus ini
                } else if (diffResult) {
                    autoComputedBlock = `\n\n[HASIL PERHITUNGAN OTOMATIS SISTEM]: Sheet referensi "${diffResult.referenceSheets.join(", ")}" di berkas "${diffResult.referenceFile}" terdeteksi, tapi sistem tidak menemukan item yang hilang secara otomatis. Kalaupun begitu, tetap periksa manual dari teks mentah karena heuristik otomatis bisa saja melewatkan sesuatu.\n`;
                }
            }
        } catch (autoErr) {
            Logger.warn("Auto-diff engine gagal, fallback ke analisis LLM biasa:", autoErr.message);
        }

        const chatId = String(ctx.chat.id);
        const recalledMemories = MemoryManager.recallMemories(chatId, userCaption);
        let utekeMemoryContext = "";
        if (recalledMemories && recalledMemories.length > 0) {
            utekeMemoryContext = recalledMemories
                .map(m => `• [Uteke Memory]: ${m.text}`)
                .join("\n");
        }

        let promptPayload = `[WAKTU REAL-TIME SEKARANG (WIB)]: ${currentDateWib}\n\nBERKAS DOKUMEN/EXCEL TERLAMPIR (${batch.files.length} FILE BERSAMAAN):\n${combinedExtractedContext}${autoComputedBlock}\n\nPERINTAH PENGGUNA:\n${userCaption}`;

        if (utekeMemoryContext) {
            promptPayload = `INGATAN JANGKA PANJANG UTEKE (INGATAN PENGGUNA RELEVAN):\n${utekeMemoryContext}\n\n${promptPayload}`;
        }

        const messages = [
            {
                role: "system",
                content: "Kamu adalah CitCat Multi-Document & Excel Data Specialist. Tugasmu adalah menganalisis dan membandingkan SELURUH berkas Excel/dokumen yang terlampir secara teliti, mencocokkan data antar file dan sheet (seperti membandingkan bahan di file Siklus Menu dengan file Master Produk), menemukan data yang belum ada/berbeda, dan menyajikan hasilnya dalam bentuk tabel Markdown yang rapi, teliti, dan lengkap. ATURAN WAJIB: proses dan sajikan SETIAP baris/item yang relevan satu per satu tanpa terkecuali -- JANGAN meringkas, JANGAN menyampel sebagian saja, JANGAN berhenti di tengah walau daftarnya panjang (puluhan/ratusan item). Kalau ada [HASIL PERHITUNGAN OTOMATIS SISTEM] di prompt, itu adalah data yang SUDAH dihitung pasti oleh kode -- WAJIB pakai semuanya sebagai dasar jawaban, jangan menghilangkan satupun."
            },
            {
                role: "user",
                content: promptPayload
            }
        ];

        Logger.info(`Analyzing document batch (${batch.files.length} files) via Gemini Pro...`);
        const rawAnswer = await AiService.askWithFallback(messages, 0.2, CONFIG.LIMITS.MAX_TOKENS_GEN_DOCUMENT);
        const finalAnswer = TextSanitizer.sanitizeOutput(rawAnswer);

        await TelegramPresenter.reply(ctx, finalAnswer || "Berhasil menganalisis seluruh berkas.");

    } catch (err) {
        Logger.error("Document Batch Processing Error:", err.message);
        await TelegramPresenter.reply(ctx, `❌ Gagal memproses berkas dokumen: ${err.message}`);
    }
}

bot.on("document", async (ctx, next) => {
    try {
        const message = ctx.message;
        const document = message.document;

        if (!document) return next();

        const filename = document.file_name || "document.xlsx";
        const mimeType = document.mime_type || "";
        const lowerName = filename.toLowerCase();

        // Pass images or media documents to next handler
        if (mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
            return next();
        }

        const isExcel = /\.(xlsx|xls|csv)$/i.test(lowerName) || mimeType.includes("spreadsheet") || mimeType.includes("excel") || mimeType.includes("csv");
        if (!isExcel) return next();

        const chatId = String(ctx.chat.id);
        const fileLink = await ctx.telegram.getFileLink(document.file_id);
        const response = await axios.get(fileLink.href, { responseType: "arraybuffer" });
        const fileBuffer = Buffer.from(response.data);

        const caption = message.caption || "";

        if (!documentBatchMap.has(chatId)) {
            documentBatchMap.set(chatId, {
                files: [],
                timer: null,
                caption: ""
            });
        }

        const batch = documentBatchMap.get(chatId);
        batch.files.push({ filename, buffer: fileBuffer, isExcel });
        if (caption) batch.caption = caption;

        if (batch.timer) clearTimeout(batch.timer);

        await ctx.reply(`📊 *Menerima berkas (${batch.files.length}):* \`${filename}\`... (Menunggu berkas lainnya)...`);

        batch.timer = setTimeout(async () => {
            const currentBatch = documentBatchMap.get(chatId);
            documentBatchMap.delete(chatId);
            if (currentBatch && currentBatch.files.length > 0) {
                await processDocumentBatch(ctx, currentBatch);
            }
        }, 2000);

    } catch (err) {
        Logger.error("Document Queue Error:", err.message);
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
                getMainMenuMarkup(chatId)
            );
            return;
        }

        // EXCEL EXPORT REQUEST HANDLER
        // Ketika user meminta file Excel dari hasil analisis terakhir (mis. "kirim excelnya",
        // "buat excelnya", "hasil excelnya"), buat & kirimkan file .xlsx langsung ke Telegram
        // menggunakan data dari lastDiffResultMap -- tanpa perlu analisis ulang.
        const isExcelRequest = /(?:kirim|buat|generate|export|unduh|download|hasilkan|hasil)[\s\w]*excel(?:nya|[ _-]?file)?/i.test(userText) ||
            /(?:excel|xlsx)[\s\w]*(?:nya|file|aja|dong|please)/i.test(userText) ||
            /minta[\s\w]*excel/i.test(userText);

        if (isExcelRequest) {
            const lastDiff = lastDiffResultMap.get(chatId);
            if (lastDiff && lastDiff.missing && lastDiff.missing.length > 0) {
                try {
                    const xlsxRows = [["No", "Sheet Sumber", "Nama Item"]];
                    let rowNo = 1;
                    for (const m of lastDiff.missing) {
                        xlsxRows.push([rowNo++, m.sheet, m.value]);
                    }
                    const xlsxBuf = createExcelBuffer(xlsxRows, "Item Belum Ada");
                    await ctx.replyWithDocument(
                        { source: xlsxBuf, filename: `CitCat_Diff_${Date.now()}.xlsx` },
                        { caption: `📎 File Excel hasil perbandingan deterministik (${lastDiff.missing.length} item belum terdaftar di daftar produk)` }
                    );
                    Logger.info(`[Excel Export] Sent xlsx of last diff result (${lastDiff.missing.length} items) to chatId ${chatId}`);
                } catch (xlErr) {
                    await TelegramPresenter.reply(ctx, `❌ Gagal membuat file Excel: ${xlErr.message}`);
                }
            } else {
                await TelegramPresenter.reply(ctx, "⚠️ Belum ada hasil perbandingan Excel yang tersimpan. Kirimkan terlebih dahulu kedua file Excel Anda, lalu minta hasil perbandingannya.");
            }
            return;
        }


        // Catatan: sebelumnya cache ini TIDAK PERNAH terisi (bug) karena tidak ada
        // pemanggilan setter di manapun. Sekarang diisi di akhir handler (lihat bawah),
        // dan ditambah local cache sebagai lapis kedua agar tetap berfungsi walau
        // MemoryManager belum mengimplementasikan cache-nya sendiri.
        const cachedAnswer = (typeof MemoryManager.getCachedResponse === "function"
            ? MemoryManager.getCachedResponse(userText)
            : null) || AiService.getLocalCachedResponse(userText);

        if (cachedAnswer) {
            Logger.info(`[Instant Fast-Cache Hit] Answered "${userText}" in 0.01s from Memory!`);
            MemoryManager.addMessagePair(chatId, userText, cachedAnswer);
            await TelegramPresenter.reply(ctx, cachedAnswer);
            return;
        }

        await ctx.sendChatAction("typing");

        // 1. AUTO IMPLICIT MEMORY EXTRACTION ENGINE (Hanya simpan profil/fakta personal asli, bukan pertanyaan/kondisional)
        const isQuestionOrInquiry = /[?]|^(?:jika|kalau|apakah|bagaimana|gimana|bisakah|adakah|bisa|tolong|coba|mohon|misal|seandainya|kenapa|mengapa|apa|siapa|berapa)\b/i.test(userText.trim());

        if (!isQuestionOrInquiry) {
            const memoryFactPatterns = [
                /^(?:nama|email|dosen|pembimbing|vps|ip|server|alamat|nomor|telepon|wa)\s+(?:saya|ku)\s*(?:adalah|:)\s+(.+)/i,
                /^(?:saya|ku)\s+(?:bekerja|kuliah|tinggal)\s+di\s+(.+)/i,
                /^(?:ingat|catat|simpan)\s+(?:bahwa|informasi)?\s+(.+)/i
            ];

            for (const pattern of memoryFactPatterns) {
                if (pattern.test(userText.trim())) {
                    const stored = MemoryManager.storeLongTermMemory(chatId, userText, ["user-fact"]);
                    Logger.info(`[Auto-Memory Extractor] Otomatis mengingat fakta profil baru (${stored.id}): "${userText}"`);
                    break;
                }
            }
        }

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

        // 2. UTEKE SEMANTIC RECALL ENGINE (HIGH-PRECISION KNOWLEDGE RECALL)
        const recalledMemories = MemoryManager.recallMemories(chatId, userText);
        let utekeMemoryContext = "";
        if (recalledMemories && recalledMemories.length > 0) {
            const formattedMemories = recalledMemories
                .map(m => `• ${m.text}`)
                .join("\n");
            utekeMemoryContext = `[MEMORI JANGKA PANJANG (FAKTA TERVERIFIKASI & RELEVAN)]:\n${formattedMemories}`;
            Logger.info(`Uteke Memory Engine recalled ${recalledMemories.length} relevant items for query "${userText}"`);
        }

        // 2b. SELF-LEARNING FEEDBACK ENGINE: prioritaskan koreksi user (/salah) secara eksplisit
        try {
            if (typeof MemoryManager.getLongTermMemories === "function") {
                const allMemories = MemoryManager.getLongTermMemories(chatId) || [];
                const highPriorityCorrections = allMemories.filter(m =>
                    Array.isArray(m.tags) && m.tags.includes("high-priority") &&
                    m.text && m.text.length < 500
                );
                if (highPriorityCorrections.length > 0) {
                    const correctionsText = highPriorityCorrections
                        .slice(-5)
                        .map(m => `• ${m.text}`)
                        .join("\n");
                    utekeMemoryContext = `[KOREKSI USER SEBELUMNYA - WAJIB DIPATUHI MUTLAK]:\n${correctionsText}\n\n${utekeMemoryContext}`.trim();
                }
            }
        } catch (err) {
            Logger.warn("Gagal memuat koreksi prioritas tinggi:", err.message);
        }

        const chatHistory = MemoryManager.getHistory(chatId);
        const userMode = MemoryManager.getMode(chatId);
        const currentDateWib = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "full", timeStyle: "medium" });

        const isIdentityQuery = /^(kamu siapa|siapa kamu|siapa anda|anda siapa|siapa dirimu|apa nama bot|siapa pembuatmu|siapa namamu|siapa kamu\?|kamu siapa\?)$/i.test(userText.trim());

        if (isIdentityQuery) {
            const identityReply = "Saya adalah *CitCat Production AI Agent*, asisten cerdas berbasis **Google Gemini & Nous Hermes 3**.\n\nSetiap agent saya (Hermes, OCR, Transkrip, Riset, Koding, DevOps) telah **terintegrasi langsung dengan Uteke Local-First Memory Engine**, sehingga semua informasi/ingatan penting Anda tersimpan secara otomatis dan diingat oleh seluruh spesialis!\n\n**Spesialisasi Agent:**\n• 🧠 **Hermes Autonomous & Deep Reasoning (Nous Hermes 3)**\n• 🖼️ **OCR Vision & Exporter Excel (.xlsx)**\n• 🎙️ **Transkrip Voice/Audio/Video ke PDF**\n• 📚 **Riset & Jurnal Akademik (ARS Copilot)**\n• 💻 **Koding Fullstack Specialist**\n• 🛠️ **DevOps & Server Specialist**\n\nAda yang bisa saya bantu hari ini?";
            MemoryManager.addMessagePair(chatId, userText, identityReply);
            await TelegramPresenter.reply(ctx, identityReply);
            return;
        }

        const isCasualChat = /^(kenapa begitu\??|kok begitu\??|mengapa begitu\??|oke|ok|sip|terima kasih|thanks|thank you|makasih|halo|hai|hi|p|ping|tes|test)$/i.test(userText.trim());

        let activeAgent = chatAgent;
        if (!isCasualChat) {
            if (userMode === "HERMES") activeAgent = hermesAgent;
            else if (userMode === "CODING") activeAgent = codingAgent;
            else if (userMode === "RESEARCH") activeAgent = researchAgent;
            else if (userMode === "DEVOPS") activeAgent = devopsAgent;
            else if (userMode === "TRANSCRIBE") activeAgent = transcribeAgent;
            else if (userMode === "OCR") activeAgent = ocrAgent;
            else {
                activeAgent = AiService.selectAgent(userText); // Instant local selection (0 ms)
            }
        }

        Logger.info(`User (${chatId}) -> Active Agent: ${activeAgent.name} | Question: "${userText}"`);

        const extractedUrls = DocumentService.extractUrls(userText);

        // AUTOMATED ZOOM & WEB MEDIA RECORDING TRANSCRIBER ENGINE
        // Detects Zoom recording links (zoom.us/rec) or video/audio links in Transcribe mode
        if (extractedUrls.length > 0) {
            const zoomOrMediaUrl = extractedUrls.find(u => /zoom\.us\/rec/i.test(u) || /\.(mp4|mp3|m4a|wav|ogg|webm)/i.test(u)) || (userMode === "TRANSCRIBE" ? extractedUrls[0] : null);

            if (zoomOrMediaUrl && (userMode === "TRANSCRIBE" || /transkrip|rangkum|zoom/i.test(userText))) {
                try {
                    await TelegramPresenter.reply(ctx, `🎥 *Mendeteksi tautan rekaman Zoom/Media:*\n\`${zoomOrMediaUrl}\`\n\nSedang mengekstrak & mengunduh aliran video/audio via **Playwright Engine**... (Mohon tunggu sebentar)`);
                    await ctx.sendChatAction("upload_document");

                    const { buffer, mimeType } = await extractAndDownloadMediaFromUrl(zoomOrMediaUrl);
                    Logger.info(`[Zoom/Web Transcriber] Downloaded ${buffer.length} bytes (${mimeType}) from ${zoomOrMediaUrl}`);

                    await ctx.reply("🎙️ Media berhasil diekstrak! Memproses transkripsi & rangkuman via **Google Gemini Pro**...");

                    const { fullTranscript, coreSummary } = await transcribeAndSummarizeMedia(buffer, mimeType);

                    await ctx.reply("📄 *Transkripsi & Rangkuman Selesai!* Menggenerasi dokumen PDF...");

                    const transcriptPdfBuffer = await createPdfBuffer("TRANSKRIP LENGKAP MEDIA (Zoom / Web Video)", fullTranscript);
                    const summaryPdfBuffer = await createPdfBuffer("RANGKUMAN INTI PENELITIAN & REKAMAN MEDIA", coreSummary);

                    const shortSummaryPreview = TextSanitizer.sanitizeOutput(coreSummary).substring(0, 800);
                    await TelegramPresenter.reply(ctx, `📌 *RANGKUMAN INTI REKAMAN ZOOM/MEDIA:* \n\n${shortSummaryPreview}\n\n*(Dokumen PDF lengkap dilampirkan di bawah)*`);

                    await ctx.replyWithDocument({
                        source: summaryPdfBuffer,
                        filename: "Rangkuman_Inti_Zoom.pdf"
                    });

                    await ctx.replyWithDocument({
                        source: transcriptPdfBuffer,
                        filename: "Transkrip_Lengkap_Zoom.pdf"
                    });
                    Logger.info("Berhasil meng-generate PDF Transkrip & Rangkuman dari tautan Zoom/Web Media.");
                    return; // Finished processing Zoom/Media URL
                } catch (mediaUrlErr) {
                    Logger.warn(`Gagal ekstraksi otomatis tautan Zoom/Media (${zoomOrMediaUrl}):`, mediaUrlErr.message);
                    await TelegramPresenter.reply(ctx, `⚠️ *Pemberitahuan Ekstraksi Zoom:* ${mediaUrlErr.message}\n\nMelanjutkan dengan analisis teks halaman web biasa...`);
                }
            }
        }

        let documentContext = "";
        if (extractedUrls.length > 0) {
            const urlsToFetch = extractedUrls.slice(0, 2);
            // Fetch semua URL secara paralel (sebelumnya sequential -> 2x lebih lambat)
            const fetchedResults = await Promise.allSettled(
                urlsToFetch.map(url => DocumentService.fetchUrlContent(url))
            );
            fetchedResults.forEach((result, idx) => {
                if (result.status === "fulfilled" && result.value) {
                    documentContext += `\nISI DOKUMEN/URL (${urlsToFetch[idx]}):\n${result.value}\n`;
                }
            });
        }

        const needsSearch = !isCasualChat && AiService.checkSearchNeed(userText); // Instant local classification (0 ms)
        let searchContext = "";

        if (needsSearch && !documentContext) {
            const contextAwareSearchQuery = AiService.buildSearchQuery(userText, chatHistory);
            Logger.info(`Searching web via SearXNG for ${activeAgent.name} using query: "${contextAwareSearchQuery}"...`);

            const searchResults = await searchWeb(contextAwareSearchQuery);
            if (searchResults.length > 0) {
                let rawSearchText = searchResults
                    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nRingkasan: ${r.snippet}`)
                    .join("\n\n");

                // AUTOMATED WEBPAGE HTML SCRAPER ENGINE
                // Scrape top 2 search result URLs to extract exact numeric data, pricing tables, and live figures!
                // Filter out social media & anti-bot domains (Instagram, Facebook, X/Twitter, etc.)
                let scrapedPagesContext = "";
                const topUrls = searchResults
                    .map(r => r.url)
                    .filter(targetUrl => !DocumentService.isRestrictedDomain(targetUrl))
                    .slice(0, 2);

                if (topUrls.length > 0) {
                    const scrapeResults = await Promise.allSettled(
                        topUrls.map(targetUrl => DocumentService.fetchUrlContent(targetUrl))
                    );
                    scrapeResults.forEach((result, idx) => {
                        const targetUrl = topUrls[idx];
                        if (result.status === "fulfilled" && result.value && result.value.length > 50) {
                            scrapedPagesContext += `\n--- ISI DETAIL HASIL SCRAPING WEBPAGE (${targetUrl}) ---\n${result.value.substring(0, 5000)}\n`;
                        } else if (result.status === "rejected") {
                            Logger.warn(`Scraping URL ${targetUrl} error:`, result.reason?.message || result.reason);
                        }
                    });
                }

                searchContext = rawSearchText + (scrapedPagesContext ? `\n\n${scrapedPagesContext}` : "");
            }
        }

        // Susun prompt sistem dengan rapi agar konteks TIDAK bocor ke role "user" (mencegah Prompt Leakage)
        let systemPrompt = activeAgent.getPrompt();
        systemPrompt += `\n\n[WAKTU REAL-TIME SEKARANG (WIB)]: ${currentDateWib}`;

        const isAdmin = TerminalService.isAuthorizedAdmin(chatId);
        if (isAdmin) {
            const sysInfo = `[INFORMASI SERVING VM REAL-TIME]: OS: ${process.platform} | Node.js: ${process.version} | Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB | Working Directory: ${process.cwd()} | Admin Status: TEROTORISASI`;
            systemPrompt += `\n${sysInfo}`;
            systemPrompt += `\n${AutonomousToolService.getToolSystemPrompt(process.platform)}`;
        }

        if (utekeMemoryContext) {
            systemPrompt += `\n\n${utekeMemoryContext}`;
        }

        if (documentContext) {
            systemPrompt += `\n\n[DOKUMEN TERLAMPIR]:\n${documentContext}`;
        } else if (searchContext) {
            if (userMode === "RESEARCH") {
                systemPrompt += `\n\n[HASIL PENCARIAN WEB RISET AKADEMIK]:\n${searchContext}\n\nPetunjuk Riset: Tampilkan analisis ringkas ilmiah, judul jurnal utuh, dan URL ASLI yang tertera di atas.`;
            } else {
                systemPrompt += `\n\n[HASIL PENCARIAN & SCRAPING WEB REAL-TIME]:\n${searchContext}\n\nPetunjuk Utama: Jawab pertanyaan pengguna secara langsung, fokus, dan tepat sasaran berdasarkan data di atas. Jangan mengulang teks prompt, instruksi sistem, atau label internal ke dalam jawaban Anda. Sertakan URL sumber di akhir jika relevan.`;
            }
        }

        const messages = [
            {
                role: "system",
                content: systemPrompt
            },
            ...chatHistory,
            {
                role: "user",
                content: userText
            }
        ];

        let rawAnswer = "";
        let toolsWereExecuted = false;

        if (isAdmin) {
            rawAnswer = await AutonomousToolService.runAutonomousLoop({
                messages,
                askAiFn: (msgs) => AiService.askWithFallback(msgs, 0.2, CONFIG.LIMITS.MAX_TOKENS_GEN, activeAgent.preferredModel),
                onProgress: async (progressText) => {
                    toolsWereExecuted = true;
                    try {
                        await ctx.sendChatAction("typing");
                        await TelegramPresenter.reply(ctx, progressText);
                    } catch (e) {
                        Logger.warn("Progress notification error:", e.message);
                    }
                },
                maxIterations: 3
            });
        } else {
            rawAnswer = await AiService.askWithFallback(messages, 0.2, CONFIG.LIMITS.MAX_TOKENS_GEN, activeAgent.preferredModel);
        }

        let finalAnswer = TextSanitizer.sanitizeOutput(AutonomousToolService.cleanToolTags(rawAnswer));

        if (!finalAnswer && searchContext) {
            Logger.warn("Search payload resulted in empty response, falling back to conversational memory...");
            const fallbackMessages = [
                { role: "system", content: activeAgent.getPrompt() },
                ...chatHistory,
                { role: "user", content: userText }
            ];
            rawAnswer = await AiService.askWithFallback(fallbackMessages, 0.2, CONFIG.LIMITS.MAX_TOKENS_GEN, activeAgent.preferredModel);
            finalAnswer = TextSanitizer.sanitizeOutput(AutonomousToolService.cleanToolTags(rawAnswer));
        }

        if (!finalAnswer) {
            finalAnswer = "Maaf, saya belum dapat menemukan informasi yang tepat untuk pertanyaan tersebut. Bisa tolong perjelas?";
        }

        MemoryManager.addMessagePair(chatId, userText, finalAnswer);
        lastExchangeMap.set(chatId, { question: userText, answer: finalAnswer });

        // FIX: isi cache supaya fast-cache di awal handler benar-benar berguna.
        // Tidak di-cache jika hasilnya bergantung pada pencarian web/dokumen real-time
        // atau eksekusi perintah terminal otonom
        const isCacheable = finalAnswer &&
            !needsSearch &&
            !documentContext &&
            !toolsWereExecuted &&
            finalAnswer.length < 3000;

        if (isCacheable) {
            if (typeof MemoryManager.setCachedResponse === "function") {
                MemoryManager.setCachedResponse(userText, finalAnswer);
            }
            AiService.setLocalCachedResponse(userText, finalAnswer);
        }

        await TelegramPresenter.reply(ctx, finalAnswer);

    } catch (err) {
        Logger.error("Unhandled Bot Error:", err.message);
        const adminUserId = ConfigManager.getAdminUserId();
        if (adminUserId) {
            HermesSelfHealing.diagnoseAndProposeFix(err, { messageText: userText, chatId })
                .then(patch => {
                    if (patch && patch.success) {
                        notifyAdminSelfHealingPatch(bot, adminUserId, patch);
                    }
                })
                .catch(e => Logger.warn("Hermes Self-Healing error in text handler:", e.message));
        }
        let errorMsg = "⚠️ Maaf, terjadi kendala saat memproses permintaan Anda. Silakan coba kirim ulang pesan Anda beberapa saat lagi.";
        if (err.message && err.message.includes("404")) {
            errorMsg = "⚠️ *Model / Endpoint Tidak Ditemukan (404)*\n\nModel AI sedang mengalami transisi versi. Sistem telah dialihkan ke model cadangan. Silakan coba ulangi pertanyaan Anda.";
        } else if (err.message && err.message.includes("429")) {
            errorMsg = "⚠️ *Layanan Sibuk (429)*\n\nBatas permintaan rate-limit tercapai. Mohon tunggu 15-30 detik lalu coba lagi.";
        }
        await TelegramPresenter.reply(ctx, errorMsg);
    }
});

// Automatic Webhook Cleanup & Long Polling Launch Engine
(async () => {
    try {
        if (!CONFIG.TELEGRAM_TOKEN) {
            Logger.error("CRITICAL ERROR: TELEGRAM_TOKEN belum dikonfigurasi pada file .env!");
            return;
        }

        Logger.info("Pembersihan Webhook lama & reset pending updates Telegram...");
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });

        await registerTelegramCommandScopes(bot);
        Logger.info("🚀 Bot CitCat sukses terhubung ke Telegram & aktif menerima pesan via Long Polling!");
        await bot.launch();
    } catch (err) {
        Logger.error("CRITICAL ERROR saat meluncurkan Telegraf Bot:", err.message);
    }
})();

process.on("unhandledRejection", (reason, promise) => {
    Logger.error("Unhandled Rejection:", reason?.stack || reason);
});

process.on("uncaughtException", (err) => {
    Logger.error("Uncaught Exception:", err?.stack || err);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
