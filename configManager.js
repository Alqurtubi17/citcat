const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");

const defaultConfig = {
    primaryModel: process.env.MODEL || "meta-llama/llama-3.3-70b-instruct:free",
    modelChain: [
        process.env.MODEL || "meta-llama/llama-3.3-70b-instruct:free",
        "google/gemma-2-9b-it:free",
        "qwen/qwen-2.5-coder-32b-instruct:free",
        "deepseek/deepseek-r1-distill-llama-70b:free"
    ],
    apiKeys: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
    }
};

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
                if (data.primaryModel === "google/gemini-1.5-pro" || data.primaryModel === "google/gemini-1.5-flash" || data.primaryModel === "google/gemini-pro-1.5") {
                    data.primaryModel = "meta-llama/llama-3.3-70b-instruct:free";
                    modified = true;
                }

                if (Array.isArray(data.modelChain)) {
                    const newChain = data.modelChain.map(m => {
                        if (m === "google/gemini-1.5-pro" || m === "google/gemini-pro-1.5") return "meta-llama/llama-3.3-70b-instruct:free";
                        if (m === "google/gemini-1.5-flash" || m === "google/gemini-flash-1.5") return "google/gemma-2-9b-it:free";
                        return m;
                    });
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
}

module.exports = {
    ConfigManager
};
