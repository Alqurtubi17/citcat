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

function expandQuery(query) {
    if (!query) return "";
    let q = query;

    // Indonesian Institution & Topic Abbreviation Expansions
    q = q.replace(/\but\b/gi, "Universitas Terbuka");
    q = q.replace(/\bui\b/gi, "Universitas Indonesia");
    q = q.replace(/\bitb\b/gi, "Institut Teknologi Bandung");
    q = q.replace(/\bugm\b/gi, "Universitas Gadjah Mada");
    q = q.replace(/\bunair\b/gi, "Universitas Airlangga");
    q = q.replace(/\bundip\b/gi, "Universitas Diponegoro");
    q = q.replace(/\bunpad\b/gi, "Universitas Padjadjaran");
    q = q.replace(/\buns\b/gi, "Universitas Sebelas Maret");
    q = q.replace(/\bits\b/gi, "Institut Teknologi Sepuluh Nopember");
    q = q.replace(/\bipb\b/gi, "Institut Pertanian Bogor");
    q = q.replace(/\bpildun\b/gi, "piala dunia");

    return q;
}

function prepareQuery(query) {
    const expanded = expandQuery(query);
    const lower = expanded.toLowerCase();
    const academicTerms = ["jurnal", "paper", "penelitian", "research", "arxiv", "ieee", "acm", "springer", "doi", "pdf"];
    const isAcademic = academicTerms.some(term => lower.includes(term));

    if (isAcademic && !lower.includes("site:") && !lower.includes("filetype:")) {
        return `${expanded} site:arxiv.org OR site:ieee.org OR site:researchgate.net OR filetype:pdf`;
    }

    return expanded;
}

async function searchWeb(query, maxResults = 15) {
    try {
        const optimizedQuery = prepareQuery(query);
        const results = [];

        // 1. Try SearXNG JSON endpoint first (for 100% clean data)
        try {
            const jsonResponse = await axios.post(
                SEARX_URL,
                new URLSearchParams({
                    q: optimizedQuery,
                    format: "json",
                    language: "id"
                }).toString(),
                {
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    timeout: SEARCH_TIMEOUT_MS
                }
            );

            if (jsonResponse.data && Array.isArray(jsonResponse.data.results)) {
                for (const item of jsonResponse.data.results) {
                    if (results.length >= maxResults) break;
                    let title = (item.title || "").replace(/[…\.\s]+$/, "").trim();
                    const url = item.url || item.pretty_url;
                    const snippet = cleanSnippet(item.content || item.snippet || "");

                    if (title && snippet && url) {
                        results.push({ title, url, snippet });
                    }
                }
            }
        } catch (err) {
            // JSON endpoint might be disabled or blocked, proceed to HTML parsing
        }

        // 2. HTML Cheerio parsing fallback if JSON endpoint returned no results
        if (results.length === 0) {
            const htmlResponse = await axios.post(
                SEARX_URL,
                new URLSearchParams({
                    q: optimizedQuery,
                    language: "id"
                }).toString(),
                {
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    timeout: SEARCH_TIMEOUT_MS
                }
            );

            const $ = cheerio.load(htmlResponse.data);

            $("article.result, div.result, .result-default").each((i, el) => {
                if (results.length >= maxResults) return false;

                const linkEl = $(el).find("h3 a, h4 a, a.result-url").first();
                let title = linkEl.text().trim();
                const url = linkEl.attr("href") || $(el).find("a").attr("href");

                const snippetEl = $(el).find(".content, .snippet, p.content, div.content").first();
                const snippet = cleanSnippet(snippetEl.text().trim());

                title = title.replace(/[…\.\s]+$/, "").trim();

                if (title && snippet && url && !url.startsWith("#")) {
                    results.push({ title, url, snippet });
                }
            });
        }

        return results;
    } catch (err) {
        console.error("[Search] SearXNG search error:", err.message);
        return [];
    }
}

module.exports = {
    searchWeb,
    prepareQuery,
    expandQuery
};
