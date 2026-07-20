const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_HISTORY = 20;

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
        }
    } catch (err) {
        console.error("[Memory] Error loading memory.json:", err.message);
    }
    return {};
}

function saveMemory(memoryData) {
    try {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoryData, null, 2), "utf-8");
    } catch (err) {
        console.error("[Memory] Error saving memory.json:", err.message);
    }
}

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
