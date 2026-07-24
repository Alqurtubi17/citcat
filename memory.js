const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_HISTORY = 20;

// Batas jumlah long-term memory PER CHAT. Tanpa batas ini, addMessagePair() yang
// otomatis menyimpan hampir tiap pesan sebagai "auto-chat-knowledge" akan membuat
// memory.json tumbuh tak terbatas -- memperlambat recallMemories() (linear scan)
// dan menenggelamkan memori penting (koreksi user, fakta terverifikasi) di antara
// ribuan chat biasa. Saat limit tercapai, entri "auto-chat-knowledge" TERLAMA
// dibuang lebih dulu; tag penting (correction/verified/high-priority/manual) tidak disentuh.
const MAX_LONG_TERM_MEMORIES_PER_CHAT = 300;
const PRUNABLE_TAG = "auto-chat-knowledge";

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
            if (!data._longTermMemories) data._longTermMemories = [];
            if (!data._abbreviations) data._abbreviations = {};
            return data;
        }
    } catch (err) {
        console.error("[UtekeMemory] Error loading memory.json:", err.message);
    }
    return { _longTermMemories: [], _abbreviations: {} };
}

function saveMemory(memoryData) {
    try {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoryData, null, 2), "utf-8");
    } catch (err) {
        console.error("[UtekeMemory] Error saving memory.json:", err.message);
    }
}

// Stop-words set for filtering noise in semantic recall
const INDONESIAN_STOPWORDS = new Set([
    "ada", "adalah", "adanya", "adapun", "agaknya", "agar", "akan", "akankah", "akhirnya", "aku", "akulah",
    "amat", "anda", "andalah", "antar", "antara", "antaranya", "apa", "apaan", "apabila", "apakah", "apalagi",
    "artinya", "atau", "ataukah", "ataupun", "bagaimana", "bagaimanakah", "bagaimanapun", "bagi", "bahkan",
    "bahwa", "bahwasanya", "bisa", "bisakah", "boleh", "bolehkah", "buat", "bukan", "bukankah", "bukanlah",
    "carikan", "carinya", "cuma", "dan", "dapat", "dari", "daripada", "dengan", "dia", "dialah", "diantara",
    "diantaranya", "dikarenakan", "dimana", "dimanakah", "diri", "dirinya", "disitu", "disitulah", "disini",
    "disinilah", "ditambah", "dong", "dulu", "enggak", "gak", "hal", "hanya", "harus", "haruslah", "ia", "ialah",
    "ini", "inikah", "inilah", "itu", "itukah", "itulah", "jadi", "jangan", "jika", "jikalau", "juga", "kalau",
    "kami", "kamu", "kamulah", "kapan", "kapankah", "karena", "kata", "ke", "kecuali", "kenapa", "kepada",
    "kepadanya", "kita", "kitalah", "lagi", "lagipula", "lain", "lu", "gue", "maka", "makanya", "malah",
    "malahan", "mampu", "mana", "manakah", "masih", "masihkah", "mau", "maupun", "melainkan", "memang",
    "mengapa", "mengapakah", "mereka", "merekalah", "meskipun", "mungkin", "nah", "namun", "oleh", "olehnya",
    "pada", "padahal", "padanya", "pasti", "pengen", "pernah", "pula", "pun", "rasa", "saat", "saja", "sajalah",
    "saling", "sama", "sampai", "sangat", "saya", "sayalah", "sebab", "sebagai", "sebagian", "sebagaimana",
    "sebagainya", "sebelum", "sebelumnya", "sedang", "sedangkan", "sedikit", "sehingga", "sejak", "sekali",
    "sekalian", "sekilas", "selain", "selama", "seluruh", "semakin", "sementara", "seperti", "sepertinya",
    "sering", "serta", "siapa", "siapakah", "sudah", "sudahkah", "supaya", "tadi", "tanpa", "tapi", "tentu",
    "tentang", "tentunya", "terhadap", "termasuk", "ternyata", "tidak", "tidakkah", "toh", "untuk", "utk",
    "ya", "yaitu", "yakin", "yang", "what", "who", "where", "when", "why", "how", "the", "a", "an", "is", "are"
]);

/**
 * Uteke-Inspired Local-First Memory Engine for AI Agents
 */
class MemoryManager {
    constructor() {
        this.store = loadMemory();
    }

    getHistory(chatId) {
        return this.store[chatId]?.history || [];
    }

    getMode(chatId) {
        return this.store[chatId]?.mode || "GENERAL";
    }

    setMode(chatId, mode) {
        if (!this.store[chatId]) {
            this.store[chatId] = { mode: "GENERAL", history: [] };
        }
        this.store[chatId].mode = mode;
        saveMemory(this.store);
    }

    getCustomAbbreviations() {
        return this.store._abbreviations || {};
    }

    setCustomAbbreviation(shortForm, fullName) {
        if (!this.store._abbreviations) {
            this.store._abbreviations = {};
        }
        const cleanKey = shortForm.toLowerCase().trim();
        this.store._abbreviations[cleanKey] = fullName.trim();
        saveMemory(this.store);
    }

    // --- UTEKE LONG-TERM MEMORY ENGINE ---

    /**
     * Buang entri "auto-chat-knowledge" TERLAMA per chat jika sudah melebihi
     * MAX_LONG_TERM_MEMORIES_PER_CHAT. Memori penting (correction/verified/manual)
     * tidak pernah dibuang otomatis.
     */
    pruneLongTermMemories(chatId) {
        if (!this.store._longTermMemories) return;

        const chatIdStr = String(chatId);
        const chatMemories = this.store._longTermMemories.filter(m => m.chatId === chatIdStr);
        if (chatMemories.length <= MAX_LONG_TERM_MEMORIES_PER_CHAT) return;

        const excess = chatMemories.length - MAX_LONG_TERM_MEMORIES_PER_CHAT;
        const prunable = chatMemories
            .filter(m => Array.isArray(m.tags) && m.tags.includes(PRUNABLE_TAG))
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // terlama dulu

        const idsToRemove = new Set(prunable.slice(0, excess).map(m => m.id));
        if (idsToRemove.size > 0) {
            this.store._longTermMemories = this.store._longTermMemories.filter(m => !idsToRemove.has(m.id));
        }
    }

    storeLongTermMemory(chatId, text, tags = ["general"]) {
        if (!this.store._longTermMemories) {
            this.store._longTermMemories = [];
        }

        const newMemory = {
            id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
            chatId: String(chatId),
            text: text.trim(),
            tags: tags,
            timestamp: new Date().toISOString()
        };

        this.store._longTermMemories.push(newMemory);
        this.pruneLongTermMemories(chatId);
        saveMemory(this.store);
        return newMemory;
    }

    getLongTermMemories(chatId) {
        if (!this.store._longTermMemories) return [];
        return this.store._longTermMemories.filter(m => m.chatId === String(chatId) || m.tags.includes("global"));
    }

    deleteLongTermMemory(chatId, memoryIdOrQuery) {
        if (!this.store._longTermMemories) return false;

        const initialLength = this.store._longTermMemories.length;
        this.store._longTermMemories = this.store._longTermMemories.filter(m => {
            const matchesId = m.id === memoryIdOrQuery;
            const matchesText = m.text.toLowerCase().includes(memoryIdOrQuery.toLowerCase());
            const isUserMemory = m.chatId === String(chatId) || m.tags.includes("global");

            return !(isUserMemory && (matchesId || matchesText));
        });

        const deleted = this.store._longTermMemories.length < initialLength;
        if (deleted) saveMemory(this.store);
        return deleted;
    }

    /**
     * High-Precision Semantic Recall Engine:
     * Filters noise stop-words, calculates weighted exact-phrase & token scores,
     * and prioritizes verified facts, corrections, and explicit memories.
     */
    recallMemories(chatId, queryText, limit = 5) {
        const memories = this.getLongTermMemories(chatId);
        if (memories.length === 0) return [];

        const cleanQuery = queryText.toLowerCase().trim();
        const rawTokens = cleanQuery.replace(/[?!.,;:()'"]/g, " ").split(/\s+/).filter(Boolean);
        
        // Filter stop-words to isolate high-value keywords (e.g. "rektor", "uniba", "budi")
        let meaningfulTokens = rawTokens.filter(t => t.length >= 2 && !INDONESIAN_STOPWORDS.has(t));
        if (meaningfulTokens.length === 0) {
            meaningfulTokens = rawTokens.filter(t => t.length >= 3);
        }
        if (meaningfulTokens.length === 0) return [];

        const scored = memories.map(mem => {
            let score = 0;
            const memTextLower = mem.text.toLowerCase();

            // 1. Exact phrase match bonus (huge priority)
            if (cleanQuery.length > 5 && memTextLower.includes(cleanQuery)) {
                score += 15;
            }

            // 2. Meaningful token match (+5 per keyword)
            for (const token of meaningfulTokens) {
                if (memTextLower.includes(token)) {
                    score += 5;
                }
            }

            // 3. Tag match
            if (Array.isArray(mem.tags)) {
                for (const tag of mem.tags) {
                    if (meaningfulTokens.includes(tag.toLowerCase())) {
                        score += 4;
                    }
                }

                // Boost high priority corrections (/salah)
                if (mem.tags.includes("high-priority") || mem.tags.includes("correction")) {
                    score += 10;
                } else if (mem.tags.includes("verified")) {
                    score += 6;
                } else if (mem.tags.includes("manual") || mem.tags.includes("user-fact")) {
                    score += 8;
                }
            }

            // 4. Slight recency boost
            if (mem.timestamp) {
                const ageHours = (Date.now() - new Date(mem.timestamp).getTime()) / (1000 * 3600);
                if (ageHours < 24) score += 2;
            }

            return { ...mem, score };
        });

        return scored
            .filter(item => item.score >= 5)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    // --- RESPONSE FAST-CACHE ENGINE ---
    // Fast-cache only exact static greetings/system triggers.
    // Dynamic conversational queries are never cached globally for 24h to prevent stale answers.

    getCachedResponse(queryText) {
        if (!this.store._responseCache) return null;
        const cleanQuery = queryText.toLowerCase().trim().replace(/[?!.,]/g, "");
        const isStaticTrigger = /^(halo|hai|hi|ping|tes|test|start|\/start|\/help|\/menu)$/i.test(cleanQuery);
        
        if (!isStaticTrigger) return null; // Never fast-cache general conversational queries!

        const cached = this.store._responseCache[cleanQuery];
        if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) { // 1-hour cache for static
            return cached.text;
        }
        return null;
    }

    setCachedResponse(queryText, answerText) {
        const cleanQuery = queryText.toLowerCase().trim().replace(/[?!.,]/g, "");
        const isStaticTrigger = /^(halo|hai|hi|ping|tes|test|start|\/start|\/help|\/menu)$/i.test(cleanQuery);
        if (!isStaticTrigger) return;

        if (!this.store._responseCache) this.store._responseCache = {};
        this.store._responseCache[cleanQuery] = {
            text: answerText,
            timestamp: Date.now()
        };
        saveMemory(this.store);
    }

    addMessagePair(chatId, userText, assistantText) {
        if (!this.store[chatId]) {
            this.store[chatId] = { mode: "GENERAL", history: [] };
        }

        this.store[chatId].history.push(
            { role: "user", content: userText },
            { role: "assistant", content: assistantText }
        );

        if (this.store[chatId].history.length > MAX_HISTORY) {
            this.store[chatId].history = this.store[chatId].history.slice(-MAX_HISTORY);
        }

        // SMART FACT EXTRACTION:
        // Automatically save personal info/user facts if user expresses a clear statement
        const cleanText = userText.trim();
        const isCommand = cleanText.startsWith("/");
        const factPattern = /(?:nama|email|dosen|pembimbing|vps|ip|server|alamat|nomor|telepon|hp|wa|preferensi|hobi|pekerjaan|proyek|tugas)\s+(?:saya|ku|adalah|itu|yaitu|:)\s+(.+)/i;

        if (!isCommand && factPattern.test(cleanText)) {
            if (!this.store._longTermMemories) this.store._longTermMemories = [];

            const factSummary = `[User Fact]: ${cleanText}`;
            const exists = this.store._longTermMemories.some(m => m.chatId === String(chatId) && m.text.toLowerCase() === factSummary.toLowerCase());
            if (!exists) {
                this.store._longTermMemories.push({
                    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
                    chatId: String(chatId),
                    text: factSummary,
                    tags: ["user-fact", "manual"],
                    timestamp: new Date().toISOString()
                });
                this.pruneLongTermMemories(chatId);
            }
        }

        saveMemory(this.store);
    }

    clear(chatId) {
        if (this.store[chatId]) {
            this.store[chatId].history = [];
            saveMemory(this.store);
        }
    }
}

module.exports = {
    loadMemory,
    saveMemory,
    MemoryManager: new MemoryManager()
};
