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
     * Uteke Semantic Recall Engine:
     * Scores stored memories based on keyword relevance and injects top recalled items.
     */
    recallMemories(chatId, queryText, limit = 5) {
        const memories = this.getLongTermMemories(chatId);
        if (memories.length === 0) return [];

        const queryTokens = queryText.toLowerCase().split(/\s+/).filter(t => t.length > 2);

        const scored = memories.map(mem => {
            let score = 0;
            const memTextLower = mem.text.toLowerCase();

            for (const token of queryTokens) {
                if (memTextLower.includes(token)) {
                    score += 2;
                }
            }

            if (mem.tags.some(tag => queryTokens.includes(tag.toLowerCase()))) {
                score += 3;
            }

            // Boost: koreksi user (/salah) dan konfirmasi (/benar) diprioritaskan
            // di atas fakta auto-chat biasa, supaya kesalahan yang sudah dikoreksi
            // tidak gampang tenggelam / terulang.
            if (mem.tags.includes("high-priority") || mem.tags.includes("correction")) {
                score += 5;
            } else if (mem.tags.includes("verified")) {
                score += 2;
            }

            return { ...mem, score };
        });

        return scored
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    // --- RESPONSE FAST-CACHE ENGINE ---

    getCachedResponse(queryText) {
        if (!this.store._responseCache) return null;
        const key = queryText.toLowerCase().trim().replace(/[?!.,]/g, "");
        const cached = this.store._responseCache[key];
        if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) { // 24-hour cache
            return cached.text;
        }
        return null;
    }

    setCachedResponse(queryText, answerText) {
        if (!this.store._responseCache) this.store._responseCache = {};
        const key = queryText.toLowerCase().trim().replace(/[?!.,]/g, "");
        this.store._responseCache[key] = {
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

        // UNIVERSAL CONTINUOUS CHAT KNOWLEDGE STORE
        // Automatically archive every user message into Uteke Long-Term Memory Store for future semantic recall!
        const cleanText = userText.trim();
        const isCommand = cleanText.startsWith("/");
        const isShortGreeting = /^(halo|hai|hi|p|ping|tes|test|start)$/i.test(cleanText);

        if (!isCommand && !isShortGreeting && cleanText.length > 5) {
            if (!this.store._longTermMemories) this.store._longTermMemories = [];

            // Check if already stored recently to prevent exact duplicate spam
            const exists = this.store._longTermMemories.some(m => m.chatId === String(chatId) && m.text.toLowerCase() === cleanText.toLowerCase());
            if (!exists) {
                this.store._longTermMemories.push({
                    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
                    chatId: String(chatId),
                    text: cleanText,
                    tags: ["auto-chat-knowledge"],
                    timestamp: new Date().toISOString()
                });
                this.pruneLongTermMemories(chatId);
            }
        }

        // Cache short conversational queries for 0.05s instant answers
        if (userText.length < 50 && assistantText) {
            this.setCachedResponse(userText, assistantText);
        } else {
            saveMemory(this.store);
        }
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
