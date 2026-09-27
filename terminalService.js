const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ConfigManager } = require("./configManager");

const MAX_OUTPUT_LENGTH = 4000;
const DEFAULT_TIMEOUT_MS = 45000;
const BACKUP_DIR = path.join(__dirname, ".backups");

class TerminalService {
    static isAuthorizedAdmin(chatId) {
        if (!chatId) return false;
        const adminId = ConfigManager.getAdminUserId();
        // If no admin is explicitly configured yet, allow the first user who sets it
        if (!adminId) return true; 
        return String(chatId).trim() === String(adminId).trim();
    }

    static ensureBackupDir() {
        if (!fs.existsSync(BACKUP_DIR)) {
            try {
                fs.mkdirSync(BACKUP_DIR, { recursive: true });
            } catch (err) {
                console.error("[TerminalService] Gagal membuat direktori backup:", err.message);
            }
        }
    }

    static createBackup(filePath) {
        try {
            this.ensureBackupDir();
            const fileName = path.basename(filePath);
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupFileName = `${fileName}.${timestamp}.bak`;
            const backupPath = path.join(BACKUP_DIR, backupFileName);
            fs.copyFileSync(filePath, backupPath);
            return backupPath;
        } catch (err) {
            console.warn(`[TerminalService] Gagal membuat backup untuk ${filePath}:`, err.message);
            return null;
        }
    }

    static verifySyntax(filePath) {
        return new Promise((resolve) => {
            const ext = path.extname(filePath).toLowerCase();
            let checkCmd = null;
            if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
                checkCmd = `node --check "${filePath}"`;
            } else if (ext === ".py") {
                checkCmd = `python -m py_compile "${filePath}"`;
            } else if (ext === ".json") {
                try {
                    JSON.parse(fs.readFileSync(filePath, "utf8"));
                    return resolve({ valid: true });
                } catch (e) {
                    return resolve({ valid: false, error: e.message });
                }
            } else {
                return resolve({ valid: true });
            }

            exec(checkCmd, { cwd: process.cwd(), timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ valid: false, error: stderr || stdout || error.message });
                } else {
                    resolve({ valid: true });
                }
            });
        });
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

    static readFile(filePath, startLine = null, endLine = null) {
        try {
            const resolvedPath = path.resolve(process.cwd(), filePath);
            if (!fs.existsSync(resolvedPath)) {
                return { success: false, error: `File tidak ditemukan: ${filePath}` };
            }
            const content = fs.readFileSync(resolvedPath, "utf8");
            const lines = content.split("\n");
            const totalLines = lines.length;

            if (startLine !== null && endLine !== null) {
                const s = Math.max(1, parseInt(startLine, 10)) - 1;
                const e = Math.min(totalLines, parseInt(endLine, 10));
                const sliceLines = lines.slice(s, e);
                const numbered = sliceLines.map((l, i) => `${s + i + 1}: ${l}`).join("\n");
                return {
                    success: true,
                    path: resolvedPath,
                    totalLines,
                    startLine: s + 1,
                    endLine: e,
                    content: numbered
                };
            }

            let out = content;
            let truncated = false;
            if (content.length > 10000) {
                out = content.substring(0, 10000) + `\n\n... (Dipotong: file memiliki total ${totalLines} baris / ${content.length} karakter. Gunakan parameter start_line & end_line untuk membaca baris spesifik)`;
                truncated = true;
            }

            return {
                success: true,
                path: resolvedPath,
                totalLines,
                content: out,
                truncated,
                fullLength: content.length
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    static async replaceInFile(filePath, targetCode, replacementCode) {
        try {
            const resolvedPath = path.resolve(process.cwd(), filePath);
            if (!fs.existsSync(resolvedPath)) {
                return { success: false, error: `File tidak ditemukan: ${filePath}` };
            }

            const originalContent = fs.readFileSync(resolvedPath, "utf8");

            const normOrig = originalContent.replace(/\r\n/g, "\n");
            const normTarget = targetCode.replace(/\r\n/g, "\n").trim();
            const normRepl = replacementCode.replace(/\r\n/g, "\n");

            if (!normOrig.includes(normTarget)) {
                return {
                    success: false,
                    error: `Target kode yang ingin diganti tidak ditemukan secara persis di ${filePath}. Pastikan teks kode lama identik.`
                };
            }

            // Create safety backup
            const backupPath = this.createBackup(resolvedPath);

            // Perform replacement
            const newContent = normOrig.replace(normTarget, normRepl);
            fs.writeFileSync(resolvedPath, newContent, "utf8");

            // Syntax validation check
            const syntaxResult = await this.verifySyntax(resolvedPath);
            if (!syntaxResult.valid) {
                // Auto-rollback immediately
                fs.writeFileSync(resolvedPath, originalContent, "utf8");
                return {
                    success: false,
                    error: `Gagal sintaks (${syntaxResult.error}). Perubahan telah otomatis di-rollback ke versi awal.`,
                    rollback: true,
                    syntaxError: syntaxResult.error
                };
            }

            return {
                success: true,
                path: resolvedPath,
                backupPath,
                output: `✅ Berhasil me-rewrite/mengganti blok kode pada ${path.basename(resolvedPath)}. Sintaks lolos verifikasi dan backup tersimpan di ${path.basename(backupPath)}.`
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    static async writeFile(filePath, content) {
        try {
            const resolvedPath = path.resolve(process.cwd(), filePath);
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            let backupPath = null;
            let originalContent = null;
            if (fs.existsSync(resolvedPath)) {
                originalContent = fs.readFileSync(resolvedPath, "utf8");
                backupPath = this.createBackup(resolvedPath);
            }

            fs.writeFileSync(resolvedPath, content, "utf8");

            // Verify syntax if code file
            const syntaxResult = await this.verifySyntax(resolvedPath);
            if (!syntaxResult.valid && originalContent !== null) {
                // Auto-rollback to original
                fs.writeFileSync(resolvedPath, originalContent, "utf8");
                return {
                    success: false,
                    error: `Kode yang ditulis memiliki error sintaks: ${syntaxResult.error}. File telah otomatis di-rollback.`,
                    rollback: true
                };
            }

            return {
                success: true,
                path: resolvedPath,
                backupPath,
                output: `✅ File ${path.basename(resolvedPath)} berhasil ditulis dan diverifikasi sintaksnya.` + (backupPath ? ` (Backup: ${path.basename(backupPath)})` : "")
            };
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
