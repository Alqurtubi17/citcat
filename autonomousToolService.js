const { TerminalService } = require("./terminalService");

class AutonomousToolService {
    /**
     * System instruction specifically for authorized Admin to enable autonomous tool execution
     */
    static getToolSystemPrompt(osPlatform = process.platform) {
        return `
[KEMAMPUAN OTONOM REWRITE KODE, TERMINAL & SISTEM SERVER (KHUSUS ADMIN)]:
Anda TERHUBUNG LANGSUNG ke sistem operasi (${osPlatform}) dan direktori proyek bot ini dengan hak eksekusi aktif.

DILARANG KERAS:
- DILARANG mengatakan "Saya adalah model AI berbasis teks yang tidak dapat mengedit/membaca file atau mengakses terminal".
- DILARANG menolak jika Admin meminta Anda membaca file, menulis ulang (rewrite) kode, memperbaiki bug, merefaktor, atau mengeksekusi perintah terminal. Anda memiliki izin dan perkakas lengkap untuk melakukannya!

FORMAT PENGGUNAAN TOOL:
Jika Admin meminta Anda membaca, menulis ulang kode, atau mengeksekusi perintah, sertakan tag aksi berikut di dalam respon Anda:

1. Menulis Ulang / Mengganti Potongan Kode (Surgical Rewrite & Refactoring):
Gunakan tag ini untuk mengubah, memperbaiki, atau me-rewrite sebagian kode pada file yang ada. Kode otomatis dibackup ke .backups/ dan divalidasi sintaksnya (node --check):
<replace_in_file path="path/file/tujuan">
<target_code>
potongan kode lama persis yang akan diganti
</target_code>
<replacement_code>
kode baru pengganti yang sudah direwrite/diperbaiki
</replacement_code>
</replace_in_file>

2. Membaca Isi File Kode (Bisa Seluruhnya atau Per Baris):
<read_file path="path/file/tujuan" />
Atau jika file panjang, baca rentang baris tertentu:
<read_file path="path/file/tujuan" start_line="1" end_line="80" />

3. Menulis File Baru atau Menulis Ulang File Utuh:
<write_file path="path/file/tujuan">
isi konten file lengkap di sini
</write_file>

4. Mengeksekusi Perintah Terminal / Shell:
<execute_command>
perintah terminal di sini (misal: node -c index.js, git status, npm test)
</execute_command>

5. Melihat Daftar File di Folder:
<list_dir path="path/folder" />

ALUR KERJA REWRITE KODE:
- Saat diminta me-rewrite kode:
  1. Jika belum tahu persis baris/isinya, gunakan <read_file> untuk membaca kode target terlebih dahulu.
  2. Gunakan <replace_in_file> untuk mengganti potongan fungsi/blok kode lama dengan kode baru hasil rewrite secara presisi, ATAU gunakan <write_file> jika menulis ulang file kecil/baru.
  3. Setiap perubahan file kode JavaScript otomatis diverifikasi dengan 'node --check'. Jika sintaks salah, sistem otomatis me-rollback perubahan dan memberi tahu errornya agar Anda dapat memperbaikinya.
- Sistem bot akan mengeksekusi tag aksi tersebut secara nyata dan mengembalikan hasilnya (<tool_result>) kepada Anda.
`;
    }

    /**
     * Check if a text contains any recognized tool tags
     */
    static hasToolCalls(text) {
        if (!text || typeof text !== "string") return false;
        return (
            /<replace_in_file[\s\S]*?<\/replace_in_file>/i.test(text) ||
            /<execute_command>[\s\S]*?<\/execute_command>/i.test(text) ||
            /<write_file\s+path=["']([^"']+)["']>[\s\S]*?<\/write_file>/i.test(text) ||
            /<read_file\s+path=["']([^"']+)["']/i.test(text) ||
            /<list_dir\s*(?:path=["']([^"']+)["'])?\s*\/?\>/i.test(text)
        );
    }

    /**
     * Parse tool calls from model output text
     */
    static parseToolCalls(text) {
        const calls = [];
        if (!text || typeof text !== "string") return calls;

        // 1. Parse <replace_in_file path="..."> <target_code>...</target_code> <replacement_code>...</replacement_code> </replace_in_file>
        const replaceFileRegex = /<replace_in_file\s+path=["']([^"']+)["']>[\s\S]*?<target_code>([\s\S]*?)<\/target_code>[\s\S]*?<replacement_code>([\s\S]*?)<\/replacement_code>[\s\S]*?<\/replace_in_file>/gi;
        let match;
        while ((match = replaceFileRegex.exec(text)) !== null) {
            calls.push({
                type: "replace_in_file",
                path: match[1].trim(),
                targetCode: match[2],
                replacementCode: match[3]
            });
        }

        // 2. Parse <write_file path="...">content</write_file>
        const writeFileRegex = /<write_file\s+path=["']([^"']+)["']>([\s\S]*?)<\/write_file>/gi;
        while ((match = writeFileRegex.exec(text)) !== null) {
            calls.push({
                type: "write_file",
                path: match[1].trim(),
                content: match[2].trim()
            });
        }

        // 3. Parse <execute_command>command</execute_command>
        const execCommandRegex = /<execute_command>([\s\S]*?)<\/execute_command>/gi;
        while ((match = execCommandRegex.exec(text)) !== null) {
            const command = match[1].trim();
            if (command) {
                calls.push({
                    type: "execute_command",
                    command
                });
            }
        }

        // 4. Parse <read_file path="..." start_line="..." end_line="..." />
        const readFileRegex = /<read_file\s+path=["']([^"']+)["'](?:\s+start_line=["']?(\d+)["']?)?(?:\s+end_line=["']?(\d+)["']?)?\s*\/?\>/gi;
        while ((match = readFileRegex.exec(text)) !== null) {
            calls.push({
                type: "read_file",
                path: match[1].trim(),
                startLine: match[2] ? parseInt(match[2], 10) : null,
                endLine: match[3] ? parseInt(match[3], 10) : null
            });
        }

        // 5. Parse <list_dir path="..." />
        const listDirRegex = /<list_dir(?:\s+path=["']([^"']+)["'])?\s*\/?\>/gi;
        while ((match = listDirRegex.exec(text)) !== null) {
            calls.push({
                type: "list_dir",
                path: match[1] ? match[1].trim() : "."
            });
        }

        return calls;
    }

    /**
     * Clean tool tags from text for presentation
     */
    static cleanToolTags(text) {
        if (!text || typeof text !== "string") return "";
        return text
            .replace(/<replace_in_file[\s\S]*?<\/replace_in_file>/gi, "")
            .replace(/<execute_command>[\s\S]*?<\/execute_command>/gi, "")
            .replace(/<write_file\s+path=["'][^"']+["']>[\s\S]*?<\/write_file>/gi, "")
            .replace(/<read_file[\s\S]*?\/?\>/gi, "")
            .replace(/<list_dir(?:\s+path=["'][^"']+["'])?\s*\/?\>/gi, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    /**
     * Execute a single tool call
     */
    static async executeTool(toolCall) {
        switch (toolCall.type) {
            case "replace_in_file": {
                const result = await TerminalService.replaceInFile(toolCall.path, toolCall.targetCode, toolCall.replacementCode);
                return {
                    tool: "replace_in_file",
                    path: toolCall.path,
                    success: result.success,
                    output: result.output || result.error
                };
            }
            case "write_file": {
                const result = await TerminalService.writeFile(toolCall.path, toolCall.content);
                return {
                    tool: "write_file",
                    path: toolCall.path,
                    success: result.success,
                    output: result.output || result.error
                };
            }
            case "read_file": {
                const result = TerminalService.readFile(toolCall.path, toolCall.startLine, toolCall.endLine);
                return {
                    tool: "read_file",
                    path: toolCall.path,
                    success: result.success,
                    output: result.success
                        ? result.content
                        : `Gagal membaca file: ${result.error}`
                };
            }
            case "execute_command": {
                const result = await TerminalService.executeCommand(toolCall.command);
                return {
                    tool: "execute_command",
                    command: toolCall.command,
                    success: result.success,
                    code: result.code,
                    output: result.output
                };
            }
            case "list_dir": {
                const result = TerminalService.listDir(toolCall.path);
                if (!result.success) {
                    return {
                        tool: "list_dir",
                        path: toolCall.path,
                        success: false,
                        output: `Gagal membaca direktori: ${result.error}`
                    };
                }
                const formatted = result.items
                    .map(i => `${i.isDirectory ? "[DIR] " : "[FILE]"} ${i.name}`)
                    .join("\n");
                return {
                    tool: "list_dir",
                    path: toolCall.path,
                    success: true,
                    output: formatted || "(Direktori kosong)"
                };
            }
            default:
                return {
                    tool: toolCall.type,
                    success: false,
                    output: `Tool '${toolCall.type}' tidak dikenali.`
                };
        }
    }

    /**
     * Run autonomous loop:
     * Calls AI -> parses tools -> executes -> feeds result back -> repeat until done or max iterations reached.
     */
    static async runAutonomousLoop({
        messages,
        askAiFn,
        onProgress = async () => {},
        maxIterations = 4
    }) {
        const conversationMessages = [...messages];
        let iteration = 0;
        let lastAiResponse = "";
        const allExecutedResults = [];

        while (iteration < maxIterations) {
            iteration++;
            try {
                lastAiResponse = await askAiFn(conversationMessages);
            } catch (err) {
                console.warn(`[AutonomousToolService] AI call iteration ${iteration} error:`, err.message);
                break;
            }

            if (!lastAiResponse) break;

            const toolCalls = this.parseToolCalls(lastAiResponse);
            if (toolCalls.length === 0) {
                // No tools called, return response directly
                return this.cleanToolTags(lastAiResponse) || lastAiResponse;
            }

            // Clean visible text from tool tags to display as interim thought if needed
            const thoughtText = this.cleanToolTags(lastAiResponse);
            if (thoughtText) {
                await onProgress(`💬 *CitCat:* ${thoughtText}`);
            }

            // Execute all requested tools sequentially
            const currentTurnResults = [];
            for (const call of toolCalls) {
                let actionSummary = "";
                if (call.type === "replace_in_file") {
                    actionSummary = `Me-rewrite/memperbaiki kode: \`${call.path}\``;
                } else if (call.type === "write_file") {
                    actionSummary = `Membuat/menulis file: \`${call.path}\``;
                } else if (call.type === "read_file") {
                    const range = call.startLine ? ` (baris ${call.startLine}-${call.endLine})` : "";
                    actionSummary = `Membaca file: \`${call.path}\`${range}`;
                } else if (call.type === "execute_command") {
                    actionSummary = `Mengeksekusi terminal: \`${call.command}\``;
                } else if (call.type === "list_dir") {
                    actionSummary = `Melihat isi folder: \`${call.path}\``;
                }

                await onProgress(`⚙️ *CitCat Autonomous Action:*\n${actionSummary}...`);
                const res = await this.executeTool(call);
                currentTurnResults.push(res);
                allExecutedResults.push(res);
            }

            // Format results into system/user feedback block
            const formattedResults = currentTurnResults.map(r => {
                const statusStr = r.success ? "BERHASIL" : "GAGAL";
                const detail = r.command ? ` [Command: ${r.command}]` : r.path ? ` [Path: ${r.path}]` : "";
                return `<tool_result tool="${r.tool}" status="${statusStr}"${detail}>\n${r.output}\n</tool_result>`;
            }).join("\n\n");

            // Append assistant response with tools and the execution results back to messages
            conversationMessages.push({
                role: "assistant",
                content: lastAiResponse
            });

            // If we reached max iterations, ask specifically for final wrap-up report
            const isLastTurn = iteration >= maxIterations;
            conversationMessages.push({
                role: "user",
                content: isLastTurn
                    ? `[HASIL EKSEKUSI OTONOM DI SERVER/VM]:\n${formattedResults}\n\nSeluruh rangkaian perintah eksekusi awal telah selesai. Sekarang, tolong berikan analisis hasil di atas, status sistem saat ini, serta kesimpulan/rekomendasi akhir secara jelas kepada Admin (DILARANG menggunakan tag tool lagi).`
                    : `[HASIL EKSEKUSI OTONOM DI SERVER/VM]:\n${formattedResults}\n\nSilakan evaluasi hasil di atas. Jika semua perintah sudah selesai, berikan laporan konfirmasi akhir kepada Admin. Jika masih ada langkah berikutnya (misal: verifikasi sintaks atau langkah rewrite selanjutnya), gunakan tag tool yang sesuai.`
            });

            if (isLastTurn) {
                try {
                    const finalSummary = await askAiFn(conversationMessages);
                    if (finalSummary) {
                        return this.cleanToolTags(finalSummary) || finalSummary;
                    }
                } catch (summaryErr) {
                    console.warn("[AutonomousToolService] Final summary error:", summaryErr.message);
                }
            }
        }

        // Clean final answer if available
        const cleanAnswer = this.cleanToolTags(lastAiResponse);
        if (cleanAnswer) {
            return cleanAnswer;
        }

        // If tools were executed but AI didn't provide final text, format fallback summary from executed tools
        if (allExecutedResults.length > 0) {
            const summaryList = allExecutedResults.map(r => {
                const title = r.command ? `Perintah: \`${r.command}\`` : r.path ? `File/Path: \`${r.path}\`` : r.tool;
                const status = r.success ? "✅ Berhasil" : "❌ Gagal / Ada kendala";
                const shortOutput = (r.output || "").trim().substring(0, 500);
                return `• *${title}* (${status}):\n\`\`\`text\n${shortOutput || "(Tanpa output)"}\n\`\`\``;
            }).join("\n\n");
            return `📋 *Laporan Hasil Eksekusi Otonom Server:*\n\n${summaryList}\n\nSilakan tentukan langkah selanjutnya atau ketik instruksi tambahan jika diperlukan!`;
        }

        return "";
    }
}

module.exports = {
    AutonomousToolService
};
