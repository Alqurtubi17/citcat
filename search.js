const axios = require("axios");
const cheerio = require("cheerio");
const { MemoryManager } = require("./memory");

const SEARX_URL = process.env.SEARX_URL || "http://127.0.0.1:8080/search";
const SEARCH_TIMEOUT_MS = 3000;
let searxngCircuitOpenUntil = 0;

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

    // Built-in Default Dictionary
    const defaultDict = {
        ut: "Universitas Terbuka",
        ui: "Universitas Indonesia",
        itb: "Institut Teknologi Bandung",
        ugm: "Universitas Gadjah Mada",
        unair: "Universitas Airlangga",
        undip: "Universitas Diponegoro",
        unpad: "Universitas Padjadjaran",
        uns: "Universitas Sebelas Maret",
        its: "Institut Teknologi Sepuluh Nopember",
        ipb: "Institut Pertanian Bogor",
        pildun: "piala dunia"
    };

    // Combine with Learned Custom Abbreviations from memory.json
    const customDict = MemoryManager.getCustomAbbreviations();
    const fullDict = { ...defaultDict, ...customDict };

    for (const [shortForm, fullName] of Object.entries(fullDict)) {
        const regex = new RegExp(`\\b${shortForm}\\b`, "gi");
        q = q.replace(regex, fullName);
    }

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
    // Fast Circuit Breaker: If SearXNG is down or returning 403, bypass instantly (0ms delay)
    if (Date.now() < searxngCircuitOpenUntil) {
        return [];
    }

    try {
        const optimizedQuery = prepareQuery(query);
        const results = [];

        // 1. Try SearXNG JSON endpoint first
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
            // If 403 or connection refused, trip circuit breaker for 3 minutes to prevent lagging the chat
            const status = err.response?.status;
            if (status === 403 || err.code === "ECONNREFUSED") {
                searxngCircuitOpenUntil = Date.now() + 180000;
                console.warn(`[Search] SearXNG tidak tersedia (${status || err.code}). Circuit breaker aktif 3 menit, pencarian web dilewati agar respon cepat.`);
                return [];
            }
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
