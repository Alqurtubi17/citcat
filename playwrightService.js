/**
 * playwrightService.js
 * Browser AI Engine — menggunakan Playwright untuk masuk ke akun web AI
 * (Google Gemini, NotebookLM, ChatGPT, dll) dan menembakkan pertanyaan
 * langsung dari browser, lalu mengembalikan hasilnya ke bot.
 *
 * ARSITEKTUR:
 * - Setiap akun disimpan dalam ConfigManager (terenkripsi base64 sederhana).
 * - Satu browser instance per akun (singleton, reuse antar request).
 * - Hasil dari browser dikirim kembali ke Telegram & disimpan ke Uteke Memory.
 */

const { chromium } = require("playwright");
const { ConfigManager } = require("./configManager");

// ───────────────────────────────────────────────────────────────────────────────
// SUPPORTED SERVICE DEFINITIONS
// Tambahkan layanan baru cukup dengan menambah entri di sini.
// ───────────────────────────────────────────────────────────────────────────────
const BROWSER_SERVICES = {
    gemini: {
        name: "Google Gemini",
        url: "https://gemini.google.com/",
        inputSelector: "rich-textarea div[contenteditable='true']",
        submitSelector: "button[aria-label='Send message'], button[data-test-id='send-button']",
        responseSelector: "message-content .markdown",
        loginUrl: "https://accounts.google.com/signin",
        loginEmailSelector: "input[type='email']",
        loginPasswordSelector: "input[type='password']",
        loginNextSelector: "#identifierNext, #passwordNext"
    },
    notebooklm: {
        name: "NotebookLM",
        url: "https://notebooklm.google.com/",
        inputSelector: "textarea, div[contenteditable='true'][role='textbox']",
        submitSelector: "button[aria-label*='Send'], button[type='submit']",
        responseSelector: ".response-text, .model-response, [data-response]",
        loginUrl: "https://accounts.google.com/signin",
        loginEmailSelector: "input[type='email']",
        loginPasswordSelector: "input[type='password']",
        loginNextSelector: "#identifierNext, #passwordNext"
    },
    chatgpt: {
        name: "ChatGPT",
        url: "https://chatgpt.com/",
        inputSelector: "#prompt-textarea",
        submitSelector: "button[data-testid='send-button']",
        responseSelector: "[data-message-author-role='assistant'] .markdown",
        loginUrl: "https://chat.openai.com/auth/login",
        loginEmailSelector: "input[name='username'], input[type='email']",
        loginPasswordSelector: "input[name='password'], input[type='password']",
        loginNextSelector: "button[type='submit'], .continue-btn"
    }
};

// ───────────────────────────────────────────────────────────────────────────────
// BROWSER SESSION POOL
// Menyimpan browser instance yang sudah login supaya tidak perlu login ulang.
// ───────────────────────────────────────────────────────────────────────────────
const browserSessions = new Map(); // key: "serviceId:accountAlias" -> { browser, page }

/**
 * Simpan kredensial akun ke ConfigManager
 * @param {string} serviceId - "gemini"|"notebooklm"|"chatgpt"
 * @param {string} alias - nama singkat akun, mis. "akun1"
 * @param {string} email
 * @param {string} password
 */
function saveBrowserAccount(serviceId, alias, email, password) {
    const cfg = ConfigManager.loadConfig();
    if (!cfg.browserAccounts) cfg.browserAccounts = {};
    const key = `${serviceId}:${alias}`;
    cfg.browserAccounts[key] = {
        serviceId,
        alias,
        email,
        password: Buffer.from(password).toString("base64"), // obfuscate, bukan enkripsi kuat
        addedAt: new Date().toISOString()
    };
    ConfigManager.saveConfig(cfg);
    return key;
}

/**
 * Ambil daftar semua akun browser yang terdaftar
 */
function listBrowserAccounts() {
    const cfg = ConfigManager.loadConfig();
    return cfg.browserAccounts || {};
}

/**
 * Hapus akun browser
 */
function removeBrowserAccount(key) {
    const cfg = ConfigManager.loadConfig();
    if (cfg.browserAccounts && cfg.browserAccounts[key]) {
        delete cfg.browserAccounts[key];
        ConfigManager.saveConfig(cfg);
        // Tutup sesi browser yang aktif jika ada
        if (browserSessions.has(key)) {
            browserSessions.get(key).browser.close().catch(() => {});
            browserSessions.delete(key);
        }
        return true;
    }
    return false;
}

/**
 * Login ke layanan dan kembalikan page yang siap digunakan
 */
async function ensureLoggedInPage(serviceId, alias) {
    const key = `${serviceId}:${alias}`;
    const cfg = ConfigManager.loadConfig();
    const account = cfg.browserAccounts?.[key];

    if (!account) throw new Error(`Akun "${alias}" untuk layanan "${serviceId}" belum terdaftar. Tambahkan via /setbrowser.`);

    const service = BROWSER_SERVICES[serviceId];
    if (!service) throw new Error(`Layanan "${serviceId}" tidak dikenal. Pilihan: ${Object.keys(BROWSER_SERVICES).join(", ")}`);

    // Reuse session yang sudah ada jika masih hidup
    if (browserSessions.has(key)) {
        const session = browserSessions.get(key);
        try {
            await session.page.waitForTimeout(100); // cek masih hidup
            return session.page;
        } catch {
            browserSessions.delete(key);
        }
    }

    // Buka browser baru (headless)
    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
    });

    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    // Buka halaman login
    await page.goto(service.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Isi email
    await page.waitForSelector(service.loginEmailSelector, { timeout: 15000 });
    await page.fill(service.loginEmailSelector, account.email);
    await page.click(service.loginNextSelector.split(",")[0].trim());
    await page.waitForTimeout(2000);

    // Isi password
    await page.waitForSelector(service.loginPasswordSelector, { timeout: 15000 });
    await page.fill(service.loginPasswordSelector, Buffer.from(account.password, "base64").toString("utf8"));
    const nextBtns = service.loginNextSelector.split(",").map(s => s.trim());
    for (const btn of nextBtns) {
        try { await page.click(btn); break; } catch {}
    }
    await page.waitForTimeout(4000);

    // Navigasi ke halaman utama layanan
    await page.goto(service.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    browserSessions.set(key, { browser, page });
    return page;
}

/**
 * Kirimkan pertanyaan ke layanan AI via browser dan kembalikan jawaban
 * @param {string} serviceId
 * @param {string} alias
 * @param {string} prompt
 * @param {number} waitMs - waktu tunggu respons (ms)
 * @returns {Promise<string>}
 */
async function askViaBrowser(serviceId, alias, prompt, waitMs = 20000) {
    const service = BROWSER_SERVICES[serviceId];
    if (!service) throw new Error(`Layanan "${serviceId}" tidak dikenal.`);

    const page = await ensureLoggedInPage(serviceId, alias);

    // Pastikan di halaman yang benar
    if (!page.url().includes(new URL(service.url).hostname)) {
        await page.goto(service.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2000);
    }

    // Klik input, tulis prompt
    await page.waitForSelector(service.inputSelector, { timeout: 15000 });
    await page.click(service.inputSelector);
    await page.fill(service.inputSelector, "");
    await page.type(service.inputSelector, prompt, { delay: 20 });
    await page.waitForTimeout(500);

    // Tekan submit
    const submitBtns = service.submitSelector.split(",").map(s => s.trim());
    let submitted = false;
    for (const btn of submitBtns) {
        try {
            await page.click(btn);
            submitted = true;
            break;
        } catch {}
    }
    if (!submitted) await page.keyboard.press("Enter");

    // Tunggu respons muncul
    await page.waitForTimeout(waitMs);

    // Ambil teks respons terakhir
    const responseSelectors = service.responseSelector.split(",").map(s => s.trim());
    let responseText = "";

    for (const sel of responseSelectors) {
        try {
            const elements = await page.$$(sel);
            if (elements.length > 0) {
                const lastEl = elements[elements.length - 1];
                responseText = await lastEl.innerText();
                if (responseText.trim()) break;
            }
        } catch {}
    }

    if (!responseText.trim()) {
        // Fallback: ambil semua teks yang terlihat di body
        responseText = await page.evaluate(() => document.body.innerText.slice(-3000));
    }

    return responseText.trim();
}

/**
 * Tutup semua sesi browser (dipanggil saat bot shutdown)
 */
async function closeAllBrowserSessions() {
    for (const [key, session] of browserSessions.entries()) {
        try { await session.browser.close(); } catch {}
        browserSessions.delete(key);
    }
}

module.exports = {
    BROWSER_SERVICES,
    saveBrowserAccount,
    listBrowserAccounts,
    removeBrowserAccount,
    askViaBrowser,
    closeAllBrowserSessions
};
