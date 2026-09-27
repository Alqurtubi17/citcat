require("dotenv").config();
const { ConfigManager } = require("./configManager");

console.log("\n=========== CITCAT BOT DIAGNOSTIC ===========");
console.log("1. TELEGRAM_TOKEN    :", process.env.TELEGRAM_TOKEN ? "✅ TERPASANG (" + process.env.TELEGRAM_TOKEN.substring(0, 10) + "...)" : "❌ KOSONG / BELUM ADA DI .env");
const geminiKeys = ConfigManager.getGeminiApiKeys();
if (geminiKeys.length > 1) {
    console.log(`2. GEMINI_API_KEY    : ✅ TERPASANG (${geminiKeys.length} Keys Aktif - Multi-Key Round-Robin & 429 Failover)`);
} else if (geminiKeys.length === 1) {
    console.log("2. GEMINI_API_KEY    : ✅ TERPASANG (1 Key Aktif)");
} else {
    console.log("2. GEMINI_API_KEY    : ⚠️ KOSONG (Menggunakan OpenRouter)");
}
console.log("3. OPENROUTER_API_KEY:", ConfigManager.getApiKey("OPENROUTER_API_KEY") ? "✅ TERPASANG" : "⚠️ KOSONG");
console.log("4. MODEL UTAMA ACTIVE:", ConfigManager.getPrimaryModel());
console.log("=============================================\n");
