const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const { ConfigManager } = require("./configManager");
const { askGeminiDirect } = require("./geminiService");

const BACKUP_DIR = path.join(__dirname, ".backups");
const HERMES_MODEL = "nousresearch/hermes-3-llama-3.1-70b";

class HermesSelfHealingService {
    constructor() {
        this.pendingPatches = new Map();
        this.ensureBackupDir();
    }

    ensureBackupDir() {
        if (!fs.existsSync(BACKUP_DIR)) {
            try {
                fs.mkdirSync(BACKUP_DIR, { recursive: true });
            } catch (err) {
                console.error("[HermesSelfHealing] Gagal membuat direktori backup:", err.message);
            }
        }
    }

    /**
     * Parse error stack trace to locate target file and line number within project
     */
    extractErrorLocation(err) {
        if (!err) return null;
        const stack = err.stack || String(err);
        const lines = stack.split("\n");

        for (const line of lines) {
            // Match pattern like at Object.<anonymous> (D:\Kerja\telegram-bot\index.js:1856:15)
            // or at file.js:123:45
            const match = line.match(/(?:at\s+.*?\s+\(?|\()([a-zA-Z]:[\\\/][^():\r\n]+\.js|\.[\\\/][^():\r\n]+\.js|[^():\r\n]+\.js):(\d+):(\d+)\)?/i);
            if (match) {
                const rawPath = match[1];
                const lineNumber = parseInt(match[2], 10);
                const colNumber = parseInt(match[3], 10);

                // Ignore node_modules and internal node libraries
                if (rawPath.includes("node_modules") || rawPath.startsWith("node:")) {
                    continue;
                }

                const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
                if (fs.existsSync(resolvedPath)) {
                    return {
                        filePath: resolvedPath,
                        fileName: path.basename(resolvedPath),
                        line: lineNumber,
                        column: colNumber
                    };
                }
            }
        }

        return null;
    }

    /**
     * Run syntax verification using node --check
     */
    verifySyntax(filePath) {
        return new Promise((resolve) => {
            exec(`node --check "${filePath}"`, { cwd: process.cwd(), timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ valid: false, error: stderr || stdout || error.message });
                } else {
                    resolve({ valid: true });
                }
            });
        });
    }

    /**
     * Request code repair plan from Nous Hermes 3 (or Gemini Flash fallback)
     */
    async queryHermesAgent(promptText) {
        const openrouterKey = ConfigManager.getApiKey("OPENROUTER_API_KEY");

        // 1. Try Nous Hermes 3 on OpenRouter if key is present
        if (openrouterKey) {
            try {
                const response = await axios.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    {
                        model: HERMES_MODEL,
                        messages: [
                            {
                                role: "system",
                                content: "You are Nous Hermes Autonomous Code Repair Specialist. Return ONLY a valid JSON object matching the requested schema. No surrounding markdown backticks or commentary."
                            },
                            {
                                role: "user",
                                content: promptText
                            }
                        ],
                        temperature: 0.1,
                        max_tokens: 3000
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${openrouterKey}`,
                            "HTTP-Referer": "https://github.com/Alqurtubi17/citcat",
                            "X-Title": "CitCat Hermes Self-Healing",
                            "Content-Type": "application/json"
                        },
                        timeout: 35000
                    }
                );

                const reply = response.data?.choices?.[0]?.message?.content;
                if (reply) return reply;
            } catch (err) {
                console.warn("[HermesSelfHealing] OpenRouter Hermes error:", err.message);
            }
        }

        // 2. High-speed Direct Google Gemini Flash Fallback
        const geminiKey = ConfigManager.getApiKey("GEMINI_API_KEY");
        if (geminiKey) {
            const geminiMessages = [
                {
                    role: "system",
                    content: "You are Hermes Code Repair Specialist. Return ONLY a valid JSON object matching the requested schema. Do not output anything else."
                },
                {
                    role: "user",
                    content: promptText
                }
            ];
            return await askGeminiDirect(geminiMessages, 0.1, "gemini-flash-latest", 3000);
        }

        throw new Error("Tidak ada API Key aktif (OPENROUTER_API_KEY atau GEMINI_API_KEY) untuk menjalankan Hermes Code Repair.");
    }

    /**
     * Diagnose an error, consult Hermes agent, validate patch syntax, and prepare reviewable patch
     */
    async diagnoseAndProposeFix(err, context = {}) {
        const location = this.extractErrorLocation(err);
        if (!location) {
            return {
                success: false,
                reason: "Lokasi file sumber error tidak dapat diidentifikasi dari stack trace."
            };
        }

        const { filePath, fileName, line } = location;
        const fileContent = fs.readFileSync(filePath, "utf8");
        const lines = fileContent.split("\n");

        // Extract surrounding code snippet (up to 40 lines around error)
        const startLine = Math.max(0, line - 25);
        const endLine = Math.min(lines.length, line + 25);
        const snippetLines = lines.slice(startLine, endLine);
        const snippetWithNumbers = snippetLines
            .map((l, i) => `${startLine + i + 1}: ${l}`)
            .join("\n");

        const promptText = `ANALISIS & PERBAIKI BUG SUMBER KODE JAVASCRIPT:

File Target: ${fileName}
Baris Error: ${line}
Pesan Error: ${err.message || String(err)}
Stack Trace:
${err.stack || "N/A"}

Potongan Kode di Sekitar Baris Error:
\`\`\`javascript
${snippetWithNumbers}
\`\`\`

TUGASMU:
1. Temukan akar masalah penyebab runtime error tersebut.
2. Tentukan potongan blok kode lama yang rusak ("targetCode"). Pastikan teks targetCode merupakan substring persis yang ada di dalam file (karakter, indentasi, newline harus identik).
3. Buat blok kode pengganti yang sudah diperbaiki ("replacementCode") dengan sintaks JavaScript Node.js yang valid dan aman.
4. Tuliskan penjelasan singkat dalam Bahasa Indonesia ("explanation").

KEMBALIKAN HANYA JSON MURNI DENGAN FORMAT BERIKUT (TANPA KATA PEMBUKA/PENUTUP):
{
  "explanation": "Penjelasan ringkas perbaikan bug",
  "targetCode": "kode persis yang akan diganti",
  "replacementCode": "kode baru pengganti yang valid"
}`;

        console.log(`[HermesSelfHealing] Menganalisis bug pada ${fileName}:${line} dengan Hermes Agent...`);
        const rawResponse = await this.queryHermesAgent(promptText);

        // Parse JSON from response
        let parsed = null;
        try {
            const cleanJson = rawResponse
                .replace(/^```(?:json)?/im, "")
                .replace(/```$/im, "")
                .trim();
            parsed = JSON.parse(cleanJson);
        } catch (jsonErr) {
            const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    parsed = JSON.parse(jsonMatch[0]);
                } catch (e) { }
            }
        }

        if (!parsed || !parsed.targetCode || !parsed.replacementCode) {
            return {
                success: false,
                reason: "Hermes Agent tidak mengembalikan format patch JSON yang valid.",
                rawResponse
            };
        }

        const targetCode = parsed.targetCode.trim();
        const replacementCode = parsed.replacementCode.trim();

        // Verify targetCode exists uniquely in fileContent
        if (!fileContent.includes(targetCode)) {
            return {
                success: false,
                reason: "Target kode lama yang ingin diganti oleh Hermes tidak ditemukan secara presisi di file sumber.",
                targetCode
            };
        }

        const patchedContent = fileContent.replace(targetCode, replacementCode);

        // Sandbox Syntax Validation
        const tempTestPath = path.join(path.dirname(filePath), `.tmp_verify_${Date.now()}.js`);
        try {
            fs.writeFileSync(tempTestPath, patchedContent, "utf8");
            const syntaxResult = await this.verifySyntax(tempTestPath);

            if (!syntaxResult.valid) {
                return {
                    success: false,
                    reason: `Hasil patch Hermes gagal dalam pengujian sintaks (node --check): ${syntaxResult.error}`,
                    syntaxError: syntaxResult.error
                };
            }
        } finally {
            if (fs.existsSync(tempTestPath)) {
                try { fs.unlinkSync(tempTestPath); } catch (e) { }
            }
        }

        // Generate Diff preview
        const patchId = "patch_" + Date.now().toString(36);
        const diffText = `--- ${fileName} (Old)\n+++ ${fileName} (Hermes Patch)\n` +
            targetCode.split("\n").map(l => `- ${l}`).join("\n") + "\n" +
            replacementCode.split("\n").map(l => `+ ${l}`).join("\n");

        const patchRecord = {
            id: patchId,
            filePath,
            fileName,
            errorLine: line,
            errorMessage: err.message,
            explanation: parsed.explanation || "Perbaikan otomatis dari Hermes Agent.",
            targetCode,
            replacementCode,
            diffText,
            createdAt: new Date().toISOString()
        };

        this.pendingPatches.set(patchId, patchRecord);

        return {
            success: true,
            patchId,
            fileName,
            errorLine: line,
            errorMessage: err.message,
            explanation: patchRecord.explanation,
            diffText,
            syntaxValid: true
        };
    }

    /**
     * Apply patch safely with automatic backup and instant rollback on failure
     */
    async applyPatch(patchId) {
        const patch = this.pendingPatches.get(patchId);
        if (!patch) {
            throw new Error(`Patch ID "${patchId}" tidak ditemukan atau sudah kedaluwarsa.`);
        }

        const { filePath, fileName, targetCode, replacementCode } = patch;
        const currentContent = fs.readFileSync(filePath, "utf8");

        if (!currentContent.includes(targetCode)) {
            throw new Error(`File ${fileName} telah berubah sejak patch dibuat. Target kode tidak lagi cocok.`);
        }

        // 1. Create Timestamped Backup
        const backupFileName = `${fileName}.${Date.now()}.bak`;
        const backupPath = path.join(BACKUP_DIR, backupFileName);
        fs.writeFileSync(backupPath, currentContent, "utf8");

        // 2. Apply Replacement
        const newContent = currentContent.replace(targetCode, replacementCode);
        fs.writeFileSync(filePath, newContent, "utf8");

        // 3. Post-apply Syntax Verification
        const check = await this.verifySyntax(filePath);
        if (!check.valid) {
            // Immediate Rollback
            console.error(`[HermesSelfHealing] CRITICAL: Syntax check gagal setelah patch diaplikasikan. Melakukan rollback instan...`);
            fs.writeFileSync(filePath, currentContent, "utf8");
            throw new Error(`Gagal sintaks setelah aplikasi: ${check.error}. File berhasil di-rollback.`);
        }

        this.pendingPatches.delete(patchId);
        console.log(`[HermesSelfHealing] Patch ${patchId} sukses diaplikasikan ke ${fileName}. Backup disimpan di ${backupPath}`);

        return {
            success: true,
            fileName,
            filePath,
            backupPath
        };
    }

    /**
     * Reject and remove pending patch
     */
    rejectPatch(patchId) {
        return this.pendingPatches.delete(patchId);
    }

    getPendingPatch(patchId) {
        return this.pendingPatches.get(patchId);
    }

    getAllPendingPatches() {
        return Array.from(this.pendingPatches.values());
    }

    listBackups(limit = 5) {
        if (!fs.existsSync(BACKUP_DIR)) return [];
        try {
            const files = fs.readdirSync(BACKUP_DIR);
            return files
                .map(f => {
                    const stats = fs.statSync(path.join(BACKUP_DIR, f));
                    return { file: f, time: stats.mtime, size: stats.size };
                })
                .sort((a, b) => b.time - a.time)
                .slice(0, limit);
        } catch {
            return [];
        }
    }
}

module.exports = {
    HermesSelfHealing: new HermesSelfHealingService()
};
