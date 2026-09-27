const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");

const defaultConfig = {
    primaryModel: process.env.MODEL || "nex-agi/nex-n2.5-pro:free",
    modelChain: [
        process.env.MODEL || "nex-agi/nex-n2.5-pro:free",
        "nousresearch/hermes-3-llama-3.1-70b",
        "inclusionai/ling-3.0-flash-vl:free",
        "dots-studio/dots-3-note-preview:free",
        "nex-agi/nex-n2.5-mini:free",
        "liquid/lfm-2.5-2.6b:free",
        "cohere/north-mini-code:free"
    ],
    apiKeys: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
    },
    adminUserId: process.env.ADMIN_USER_ID || ""
};

const DEPRECATED_MODELS_MAP = {
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

function sanitizeModelName(modelName) {
    if (!modelName) return "nex-agi/nex-n2.5-pro:free";
    return DEPRECATED_MODELS_MAP[modelName] || modelName;
}

class ConfigManager {
    // In-memory cache: config.json dibaca berulang kali per pesan (getPrimaryModel,
    // getModelChain, getApiKey x2+) sebelumnya selalu fs.readFileSync SETIAP panggilan.
    // Sekarang di-cache dan hanya dibaca ulang dari disk kalau file berubah (mtime beda)
    // atau belum pernah dibaca -- jauh lebih cepat, terutama untuk request yang sering.
    static _cache = null;
    static _cacheMtimeMs = 0;

    static loadConfig() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const stat = fs.statSync(CONFIG_PATH);
                if (this._cache && stat.mtimeMs === this._cacheMtimeMs) {
                    return this._cache; // cache masih valid, hindari baca disk lagi
                }

                const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

                let modified = false;
                const sanitizedPrimary = sanitizeModelName(data.primaryModel);
                if (sanitizedPrimary !== data.primaryModel) {
                    data.primaryModel = sanitizedPrimary;
                    modified = true;
                }

                if (Array.isArray(data.modelChain)) {
                    const newChain = data.modelChain.map(m => sanitizeModelName(m));
                    if (JSON.stringify(newChain) !== JSON.stringify(data.modelChain)) {
                        data.modelChain = newChain;
                        modified = true;
                    }
                }

                if (modified) {
                    try {
                        fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf8");
                    } catch (err) { }
                }

                this._cache = data;
                this._cacheMtimeMs = fs.existsSync(CONFIG_PATH) ? fs.statSync(CONFIG_PATH).mtimeMs : Date.now();
                return data;
            }
        } catch (err) {
            console.error("[ConfigManager] Gagal membaca config.json:", err.message);
        }
        this._cache = { ...defaultConfig };
        return this._cache;
    }

    static saveConfig(config) {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
            // Invalidate cache lokal supaya panggilan berikutnya konsisten dengan yang baru disimpan.
            this._cache = config;
            this._cacheMtimeMs = fs.existsSync(CONFIG_PATH) ? fs.statSync(CONFIG_PATH).mtimeMs : Date.now();
        } catch (err) {
            console.error("[ConfigManager] Gagal menyimpan config.json:", err.message);
        }
    }

    static getPrimaryModel() {
        const cfg = this.loadConfig();
        return cfg.primaryModel || defaultConfig.primaryModel;
    }

    static getModelChain() {
        const cfg = this.loadConfig();
        const primary = cfg.primaryModel || defaultConfig.primaryModel;
        const chain = cfg.modelChain || defaultConfig.modelChain;
        return [...new Set([primary, ...chain])];
    }

    static setPrimaryModel(modelName) {
        const cfg = this.loadConfig();
        cfg.primaryModel = modelName;
        if (!cfg.modelChain) cfg.modelChain = [...defaultConfig.modelChain];
        if (!cfg.modelChain.includes(modelName)) {
            cfg.modelChain.unshift(modelName);
        }
        this.saveConfig(cfg);
        return cfg;
    }

    static addModelToChain(modelName) {
        const cfg = this.loadConfig();
        if (!cfg.modelChain) cfg.modelChain = [...defaultConfig.modelChain];
        if (!cfg.modelChain.includes(modelName)) {
            cfg.modelChain.push(modelName);
        }
        this.saveConfig(cfg);
        return cfg;
    }

    static setApiKey(keyName, keyValue) {
        const cfg = this.loadConfig();
        if (!cfg.apiKeys) cfg.apiKeys = {};
        const normalizedKey = keyName.toUpperCase();
        cfg.apiKeys[normalizedKey] = keyValue;
        this.saveConfig(cfg);

        // Update process.env in runtime
        process.env[normalizedKey] = keyValue;
        return cfg;
    }

    static getApiKey(keyName) {
        const normalizedKey = keyName.toUpperCase();
        const cfg = this.loadConfig();
        return cfg.apiKeys?.[normalizedKey] || process.env[normalizedKey] || "";
    }

    static getGeminiApiKeys() {
        const raw = this.getApiKey("GEMINI_API_KEYS") || this.getApiKey("GEMINI_API_KEY") || this.getApiKey("GOOGLE_API_KEY") || "";
        return raw.split(/[\s,]+/).map(k => k.trim()).filter(Boolean);
    }

    static getAdminUserId() {
        const cfg = this.loadConfig();
        return cfg.adminUserId || process.env.ADMIN_USER_ID || "";
    }

    static setAdminUserId(userId) {
        const cfg = this.loadConfig();
        cfg.adminUserId = String(userId).trim();
        this.saveConfig(cfg);
        process.env.ADMIN_USER_ID = String(userId).trim();
        return cfg;
    }
}

module.exports = {
    ConfigManager
};
