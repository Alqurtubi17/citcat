const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");

const defaultConfig = {
    primaryModel: process.env.MODEL || "google/gemma-4-26b-a4b-it:free",
    modelChain: [
        process.env.MODEL || "google/gemma-4-26b-a4b-it:free",
        "google/gemma-4-31b-it:free",
        "openai/gpt-oss-20b:free",
        "cohere/north-mini-code:free"
    ],
    apiKeys: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
    }
};

class ConfigManager {
    static loadConfig() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const data = fs.readFileSync(CONFIG_PATH, "utf8");
                return JSON.parse(data);
            }
        } catch (err) {
            console.error("[ConfigManager] Gagal membaca config.json:", err.message);
        }
        return { ...defaultConfig };
    }

    static saveConfig(config) {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
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
        if (!cfg.modelChain.includes(modelName)) {
            cfg.modelChain.unshift(modelName);
        }
        this.saveConfig(cfg);
        return cfg;
    }

    static addModelToChain(modelName) {
        const cfg = this.loadConfig();
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
