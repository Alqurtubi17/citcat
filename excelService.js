const XLSX = require("xlsx");

/**
 * Creates an Excel (.xlsx) buffer from JSON array or raw table rows
 * @param {Array<Object> | Array<Array<string>> | string} data
 * @param {string} sheetName
 * @returns {Buffer}
 */
function createExcelBuffer(data, sheetName = "Hasil_OCR") {
    try {
        const workbook = XLSX.utils.book_new();
        let worksheet;

        if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && !Array.isArray(data[0])) {
            worksheet = XLSX.utils.json_to_sheet(data);
        } else if (Array.isArray(data) && Array.isArray(data[0])) {
            worksheet = XLSX.utils.aoa_to_sheet(data);
        } else {
            // Fallback for raw text lines
            const rows = String(data)
                .split("\n")
                .filter(Boolean)
                .map(line => line.split(/[\t,|]/).map(cell => cell.trim()));
            worksheet = XLSX.utils.aoa_to_sheet(rows);
        }

        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

        const excelBuffer = XLSX.write(workbook, {
            type: "buffer",
            bookType: "xlsx"
        });

        return excelBuffer;
    } catch (err) {
        console.error("[ExcelService] Error creating Excel buffer:", err.message);
        throw err;
    }
}

module.exports = {
    createExcelBuffer
};
