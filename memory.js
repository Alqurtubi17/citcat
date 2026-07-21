const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_HISTORY = 20;

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
