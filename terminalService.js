const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ConfigManager } = require("./configManager");

const MAX_OUTPUT_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 45000;

class TerminalService {
    static isAuthorizedAdmin(chatId) {
        if (!chatId) return false;
        const adminId = ConfigManager.getAdminUserId();
        // If no admin is explicitly configured yet, allow the first user who sets it,
        // or check against process.env.ADMIN_USER_ID
        if (!adminId) return true; 
        return String(chatId).trim() === String(adminId).trim();
    }

    static executeCommand(command, options = {}) {
        return new Promise((resolve) => {
            const cwd = options.cwd || process.cwd();
            const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

            exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
                let output = "";

                if (stdout) {
                    output += stdout;
                }
                if (stderr) {
                    output += (output ? "\n[STDERR]\n" : "") + stderr;
                }

                if (error) {
                    if (error.killed) {
                        output += "\n⚠️ [TIMEOUT]: Perintah dibatalkan karena melebihi batas waktu (45 detik).";
                    } else if (!output) {
                        output = `❌ Error: ${error.message}`;
                    }
                }

                output = output.trim();
                if (!output) {
                    output = "✅ Perintah berhasil dieksekusi tanpa output teks.";
                }

                if (output.length > MAX_OUTPUT_LENGTH) {
                    output = output.substring(0, MAX_OUTPUT_LENGTH - 100) + "\n\n*(Output dipotong karena batas panjang pesan)*";
                }

                resolve({
                    success: !error,
                    output,
                    code: error ? (error.code || 1) : 0
                });
            });
        });
    }

    static readFile(filePath) {
        try {
            const resolvedPath = path.resolve(process.cwd(), filePath);
            if (!fs.existsSync(resolvedPath)) {
                return { success: false, error: `File tidak ditemukan: ${filePath}` };
            }
            const content = fs.readFileSync(resolvedPath, "utf8");
            const truncated = content.length > 8000 ? content.substring(0, 8000) + "\n...(dipotong karena terlalu panjang)" : content;
            return { success: true, content: truncated, fullLength: content.length };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    static writeFile(filePath, content) {
        try {
            const resolvedPath = path.resolve(process.cwd(), filePath);
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(resolvedPath, content, "utf8");
            return { success: true, path: resolvedPath };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    static listDir(dirPath = ".") {
        try {
            const resolvedPath = path.resolve(process.cwd(), dirPath);
            if (!fs.existsSync(resolvedPath)) {
                return { success: false, error: `Direktori tidak ditemukan: ${dirPath}` };
            }
            const items = fs.readdirSync(resolvedPath, { withFileTypes: true });
            const result = items.map(item => ({
                name: item.name,
                isDirectory: item.isDirectory()
            }));
            return { success: true, path: resolvedPath, items: result };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
}

module.exports = {
    TerminalService
};
