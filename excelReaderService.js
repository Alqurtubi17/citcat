const XLSX = require("xlsx");

/**
 * Reads and parses an Excel (.xlsx / .xls / .csv) file buffer into concise text per sheet
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {string} Formatted text representation of all sheets
 */
function parseExcelFileBuffer(buffer, filename = "document.xlsx") {
    try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        let resultText = `\n--- BERKAS EXCEL: ${filename} ---\n`;

        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            resultText += `\n[SHEET: "${sheetName}"]\n`;

            if (!jsonData || jsonData.length === 0) {
                resultText += "(Sheet kosong)\n";
                continue;
            }

            const sheetLines = jsonData
                .filter(row => Array.isArray(row) && row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== ""))
                .map(row => row.map(cell => String(cell || "").trim()).filter(Boolean).join(" | "))
                .filter(Boolean)
                .join("\n");

            // Cap at 6000 chars per sheet for maximum processing speed (1-2s response time)
            resultText += sheetLines.substring(0, 6000) + "\n";
        }

        return resultText;
    } catch (err) {
        console.error("[ExcelReaderService] Error parsing Excel buffer:", err.message);
        return `\n--- BERKAS EXCEL: ${filename} (Gagal diparse: ${err.message}) ---\n`;
    }
}

module.exports = {
    parseExcelFileBuffer
};
