const PDFDocument = require("pdfkit");

function createPdfBuffer(title, content) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50 });
            const buffers = [];

            doc.on("data", chunk => buffers.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(buffers)));

            // Title Header
            doc.fillColor("#0f172a")
               .fontSize(18)
               .text(title, { align: "center" });

            doc.moveDown(0.5);

            // Divider Line
            doc.strokeColor("#2563eb")
               .lineWidth(2)
               .moveTo(50, doc.y)
               .lineTo(545, doc.y)
               .stroke();

            doc.moveDown(1);

            // Body Text Content
            doc.fillColor("#334155")
               .fontSize(11)
               .text(content, {
                   align: "left",
                   lineGap: 4
               });

            // Footer
            const pages = doc.bufferedPageRange();
            for (let i = 0; i < pages.count; i++) {
                doc.switchToPage(i);
                doc.fontSize(9)
                   .fillColor("#94a3b8")
                   .text(
                       `Halaman ${i + 1} | CitCat Media & Transcribe Agent (Google Gemini Pro)`,
                       50,
                       doc.page.height - 40,
                       { align: "center" }
                   );
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = {
    createPdfBuffer
};
