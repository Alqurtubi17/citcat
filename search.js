const axios = require("axios");
const cheerio = require("cheerio");

const SEARX_URL = process.env.SEARX_URL || "http://127.0.0.1:8080/search";
const SEARCH_TIMEOUT_MS = 15000;

function cleanSnippet(snippet) {
    if (!snippet) return "";
    return snippet
        .replace(/[\u4e00-\u9fa5]+/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function prepareQuery(query) {
    const lower = query.toLowerCase();
    const academicTerms = ["jurnal", "paper", "penelitian", "research", "arxiv", "ieee", "acm", "springer", "doi", "pdf"];
    const isAcademic = academicTerms.some(term => lower.includes(term));

    if (isAcademic && !lower.includes("site:") && !lower.includes("filetype:")) {
        return `${query} site:arxiv.org OR site:ieee.org OR site:researchgate.net OR filetype:pdf`;
    }

    return query;
}

async function searchWeb(query, maxResults = 15) {
    try {
        const optimizedQuery = prepareQuery(query);

        const response = await axios.post(
            SEARX_URL,
            new URLSearchParams({ q: optimizedQuery }).toString(),
            {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: SEARCH_TIMEOUT_MS
            }
        );

        const $ = cheerio.load(response.data);
        const results = [];

        $("article.result").each((i, el) => {
            if (results.length >= maxResults) return false;

            let title = $(el).find("h3 a").text().trim();
            const url = $(el).find("h3 a").attr("href");
            const snippet = cleanSnippet($(el).find(".content").text().trim());

            title = title.replace(/[…\.\s]+$/, "").trim();

            if (title && snippet && url) {
                results.push({ title, url, snippet });
            }
        });

        return results;
    } catch (err) {
        console.error("[Search] SearXNG search error:", err.message);
        return [];
    }
}

module.exports = {
    searchWeb,
    prepareQuery
};
