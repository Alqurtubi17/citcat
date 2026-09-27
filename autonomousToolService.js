const { TerminalService } = require("./terminalService");

class AutonomousToolService {
    /**
     * System instruction specifically for authorized Admin to enable autonomous tool execution
     */
    static getToolSystemPrompt(osPlatform = process.platform) {
        return `
[KEMAMPUAN OTONOM SISTEM SERVER & TERMINAL VM (KHUSUS ADMIN)]:
Anda TERHUBUNG LANGSUNG ke sistem operasi (${osPlatform}) mesin server/VM ini dengan hak eksekusi aktif melalui modul Terminal.

DILARANG KERAS:
- DILARANG mengatakan "Saya adalah asisten AI berbasis teks yang tidak memiliki akses fisik/terminal/server".
- DILARANG menolak jika Admin meminta Anda menjalankan perintah, membuat skrip, memeriksa status server, atau berkata "kamu yang jalankan aja". Anda memiliki izin dan perkakas langsung untuk melakukannya!

FORMAT PENGGUNAAN TOOL:
Jika Admin meminta Anda mengeksekusi perintah atau membuat/membaca file, Anda WAJIB menyertakan tag aksi berikut di dalam respon Anda:

1. Mengeksekusi perintah terminal / bash / shell:
<execute_command>
perintah terminal di sini
</execute_command>

2. Menulis / membuat file langsung di server:
<write_file path="path/file/tujuan">
isi konten file di sini
</write_file>

3. Membaca isi file di server:
<read_file path="path/file/tujuan" />

4. Melihat daftar file di folder:
<list_dir path="path/folder" />

ATURAN EKSEKUSI OTONOM:
- Jika Admin berkata "kamu yang jalankan aja semua", "jalankan skrip tadi", atau "eksekusi ini", segera jalankan skrip/perintah yang baru saja dibahas menggunakan tag di atas.
- Anda dapat menyertakan teks pengantar singkat sebelum tag tool.
- Sistem bot akan mengeksekusi tag tersebut di server dan mengirimkan kembali hasilnya (<tool_result>) kepada Anda secara otomatis, lalu Anda dapat memberikan laporan konfirmasi akhir kepada Admin.
`;
    }

    /**
     * Check if a text contains any recognized tool tags
     */
    static hasToolCalls(text) {
        if (!text || typeof text !== "string") return false;
        return (
            /<execute_command>[\s\S]*?<\/execute_command>/i.test(text) ||
            /<write_file\s+path=["']([^"']+)["']>[\s\S]*?<\/write_file>/i.test(text) ||
            /<read_file\s+path=["']([^"']+)["']\s*\/?\>/i.test(text) ||
            /<list_dir\s*(?:path=["']([^"']+)["'])?\s*\/?\>/i.test(text)
        );
    }

    /**
     * Parse tool calls from model output text
     */
    static parseToolCalls(text) {
        const calls = [];
        if (!text || typeof text !== "string") return calls;

        // 1. Parse <write_file path="...">content</write_file>
        const writeFileRegex = /<write_file\s+path=["']([^"']+)["']>([\s\S]*?)<\/write_file>/gi;
        let match;
        while ((match = writeFileRegex.exec(text)) !== null) {
            calls.push({
                type: "write_file",
                path: match[1].trim(),
                content: match[2].trim()
            });
        }

        // 2. Parse <execute_command>command</execute_command>
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

        // 3. Parse <read_file path="..." />
        const readFileRegex = /<read_file\s+path=["']([^"']+)["']\s*\/?\>/gi;
        while ((match = readFileRegex.exec(text)) !== null) {
            calls.push({
                type: "read_file",
                path: match[1].trim()
            });
        }

        // 4. Parse <list_dir path="..." />
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
            .replace(/<execute_command>[\s\S]*?<\/execute_command>/gi, "")
            .replace(/<write_file\s+path=["'][^"']+["']>[\s\S]*?<\/write_file>/gi, "")
            .replace(/<read_file\s+path=["'][^"']+["']\s*\/?\>/gi, "")
            .replace(/<list_dir(?:\s+path=["'][^"']+["'])?\s*\/?\>/gi, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    /**
     * Execute a single tool call
     */
    static async executeTool(toolCall) {
        switch (toolCall.type) {
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
            case "write_file": {
                const result = TerminalService.writeFile(toolCall.path, toolCall.content);
                return {
                    tool: "write_file",
                    path: toolCall.path,
                    success: result.success,
                    output: result.success
                        ? `File berhasil ditulis ke: ${result.path}`
                        : `Gagal menulis file: ${result.error}`
                };
            }
            case "read_file": {
                const result = TerminalService.readFile(toolCall.path);
                return {
                    tool: "read_file",
                    path: toolCall.path,
                    success: result.success,
                    output: result.success
                        ? result.content
                        : `Gagal membaca file: ${result.error}`
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
        maxIterations = 3
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
                if (call.type === "execute_command") {
                    actionSummary = `Mengeksekusi terminal: \`${call.command}\``;
                } else if (call.type === "write_file") {
                    actionSummary = `Membuat/menulis file: \`${call.path}\``;
                } else if (call.type === "read_file") {
                    actionSummary = `Membaca file: \`${call.path}\``;
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
                    : `[HASIL EKSEKUSI OTONOM DI SERVER/VM]:\n${formattedResults}\n\nSilakan evaluasi hasil di atas. Jika semua perintah sudah selesai, berikan laporan konfirmasi akhir kepada Admin. Jika masih ada langkah berikutnya, gunakan tag tool yang sesuai.`
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
