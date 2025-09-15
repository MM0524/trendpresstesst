// netlify/functions/trends-builder.js
const { builder } = require("@netlify/functions");
const fetch = require("node-fetch");
const { XMLParser } = require("fast-xml-parser");
const crypto = require('crypto');
const NewsAPI = require('newsapi');

// Khởi tạo NewsAPI client với API key từ biến môi trường
const newsapi = new NewsAPI(process.env.NEWS_API_KEY);

// =========================================================================
// HÀM HELPER
// =========================================================================

// ... (Các hàm helper khác như fetchWithTimeout, getSafeString, decodeHtmlEntities, v.v. giữ nguyên)
async function fetchWithTimeout(url, options = {}, ms = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const res = await fetch(url, {
            ...options, signal: controller.signal, headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
                "Accept": "application/xml, text/xml, application/rss+xml, application/atom+xml, application/json, text/plain, */*",
                ...(options.headers || {}),
            },
        });
        if (!res.ok) throw new Error(`HTTP error! Status: ${res.status} from ${url}`);
        return res;
    } catch (err) {
        if (err.name === "AbortError") throw new Error(`Request to ${url} timed out.`);
        throw err;
    } finally { clearTimeout(timer); }
}

function getSafeString(value) {
    if (value === null || value === undefined) return "";
    let strValue = "";
    if (typeof value === 'string') strValue = value;
    else if (typeof value === 'object' && value.hasOwnProperty('#text')) strValue = String(value['#text']);
    else if (typeof value === 'object' && value.hasOwnProperty('href')) strValue = String(value.href);
    else if (Array.isArray(value)) strValue = String(value[0]);
    else strValue = String(value);
    return decodeHtmlEntities(strValue).trim();
}

function decodeHtmlEntities(str = "") {
    return str.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function toDateStr(d) {
    const dt = d ? new Date(d) : new Date();
    return isNaN(dt.getTime()) ? new Date().toISOString().split("T")[0] : dt.toISOString().split("T")[0];
}

function toSortValue(d) {
    const dt = d ? new Date(d) : null;
    return dt && !isNaN(dt.getTime()) ? dt.getTime() : 0;
}

function calculateHotnessScore(trend, maxValues) {
    const weights = { views: 0.2, interactions: 0.4, searches: 0.3, votes: 0.1 };
    const normViews = (trend.views / maxValues.views) || 0;
    const normInteractions = (trend.interactions / maxValues.interactions) || 0;
    const normSearches = (trend.searches / maxValues.searches) || 0;
    const normVotes = (trend.votes / maxValues.votes) || 0;
    return (normViews * weights.views) + (normInteractions * weights.interactions) + (normSearches * weights.searches) + (normVotes * weights.votes);
}
function inferCategoryFromName(sourceName) {
    // ... (Hàm này giữ nguyên như phiên bản trước)
    if (!sourceName) return "News";
    const name = sourceName.toLowerCase();
    const categoryMap = {
        'Technology': ['tech', 'digital', 'wired', 'gadget', 'ai', 'crypto', 'computing', 'khoa-hoc', 'so-hoa', 'công nghệ'],
        'Business': ['business', 'finance', 'market', 'economic', 'wsj', 'bloomberg', 'ft.com', 'cafef', 'kinh doanh'],
        'Sports': ['sport', 'espn', 'football', 'nba', 'f1', 'the-thao', 'thể thao'],
        'Entertainment': ['entertainment', 'showbiz', 'movies', 'music', 'hollywood', 'variety', 'giai-tri', 'culture', 'phim'],
        'Science': ['science', 'space', 'nature', 'research', 'khảo cổ'],
        'Health': ['health', 'medical', 'wellness', 'pharma', 'suckhoedoisong', 'sức khỏe'],
        'Politics': ['politic', 'government', 'white house', 'thoi-su', 'chính trị'],
        'Cars': ['car', 'auto', 'driver', 'oto-xe-may', 'ô tô'],
        'Fashion': ['fashion', 'vogue', 'elle', 'bazaar', 'style', 'thời trang'],
        'Travel': ['travel', 'lonely planet', 'du-lich', 'du lịch'],
        'Food': ['food', 'bon appetit', 'recipe', 'am-thuc', 'ẩm thực'],
        'Gaming': ['game', 'ign', 'esports', 'gamek'],
        'Education': ['education', 'higher-ed', 'giao-duc', 'giáo dục'],
        'Family': ['family', 'parents', 'afamily', 'gia đình'],
        'Lifestyle': ['lifestyle', 'life', 'đời sống'],
        'Beauty': ['beauty', 'allure', 'cosmetics', 'làm đẹp'],
        'Cybersecurity': ['cybersecurity', 'security', 'an ninh mạng'],
    };
    for (const category in categoryMap) {
        for (const keyword of categoryMap[category]) {
            if (name.includes(keyword)) return category;
        }
    }
    return "News";
}

function normalizeNewsApiArticle(article, category, region = 'global') {
    const { title, description, url, publishedAt, source } = article;
    // Dòng kiểm tra này đã rất tốt, nó sẽ trả về null nếu title không hợp lệ
    if (!title || title === "[Removed]" || !url) return null;
    const stableId = crypto.createHash('md5').update(url).digest('hex');
    const baseVotes = Math.floor(Math.random() * 500) + 200;
    
    // Tận dụng category đã biết để gắn tag
    const keyword = category;

    return {
        id: stableId,
        title_en: title, description_en: description || "No description available.", title_vi: null, description_vi: null,
        category: category.charAt(0).toUpperCase() + category.slice(1), // Viết hoa chữ cái đầu
        tags: [...new Set([keyword, source.name.replace(/\s/g, ''), region])],
        votes: baseVotes, views: Math.floor(baseVotes * (Math.random() * 10 + 15)),
        interactions: Math.floor(baseVotes * (Math.random() * 3 + 4)), searches: Math.floor(baseVotes * (Math.random() * 1 + 1.5)),
        source: url, date: toDateStr(publishedAt), sortKey: toSortValue(publishedAt),
        submitter: source.name || "Unknown Source", region: region,
    };
}

// =========================================================================
// LUỒNG DỰ PHÒNG (FALLBACK): RSS
// =========================================================================

function createStandardTrend(item, sourceName, defaultCategory = "General", defaultRegion = "global", extraTags = []) {
    const title = getSafeString(item.title); // Không cần "|| No Title Available" nữa

    // THAY ĐỔI QUAN TRỌNG: Kiểm tra và loại bỏ ngay tại đây
    if (!title) {
        return null; // Nếu không có tiêu đề, không tạo trend này
    }

    const description = getSafeString(item.description) || "No description available";
    let link = getSafeString(item.link);
    if (Array.isArray(item.link)) {
        const firstLink = item.link.find(l => l.rel === 'alternate' || !l.rel);
        link = getSafeString(firstLink?.href || item.link[0]);
    } else if (typeof item.link === 'object' && item.link.href) { link = getSafeString(item.link.href); }
    link = link || "#";
    const pubDate = getSafeString(item.pubDate || item.published) || new Date().toISOString();
    const cleanedTitle = title.replace(/<[^>]*>?/gm, '').trim();
    const cleanedDescription = description.replace(/<[^>]*>?/gm, '').trim();
    const stableId = crypto.createHash('md5').update(`${link}-${cleanedTitle}`).digest('hex');
    const category = (defaultCategory !== "General") ? defaultCategory : inferCategoryFromName(sourceName);
    const baseVotes = Math.floor(Math.random() * 2000) + 1000;
    return {
        id: stableId,
        title_en: defaultRegion !== 'vn' ? cleanedTitle : null,
        description_en: defaultRegion !== 'vn' ? cleanedDescription : null,
        title_vi: defaultRegion === 'vn' ? cleanedTitle : null,
        description_vi: defaultRegion === 'vn' ? cleanedDescription : null,
        category: category, tags: [...new Set([...extraTags, sourceName.replace(/\s/g, ""), defaultRegion, category].filter(Boolean))],
        votes: baseVotes, views: Math.floor(baseVotes * (Math.random() * 10 + 15)),
        interactions: Math.floor(baseVotes * (Math.random() * 3 + 4)), searches: Math.floor(baseVotes * (Math.random() * 1 + 1.5)),
        source: link, date: toDateStr(pubDate), sortKey: toSortValue(pubDate),
        submitter: sourceName || "Unknown", region: defaultRegion,
    };
}

async function fetchAndParseXmlFeed(url, sourceName, defaultCategory, defaultRegion, extraTags = []) {
    try {
        const res = await fetchWithTimeout(url);
        const text = await res.text();
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", textNodeName: "#text", isArray: (name) => ["item", "entry", "link"].includes(name) });
        const parsed = parser.parse(text);
        const rawItems = parsed?.rss?.channel?.item || parsed?.feed?.entry || [];

        // THAY ĐỔI: Lọc bỏ các kết quả null ngay sau khi tạo
        return rawItems.map(item => createStandardTrend(item, sourceName, defaultCategory, defaultRegion, extraTags)).filter(Boolean);

    } catch (err) {
        console.error(`❌ RSS Error for ${sourceName} (${url}):`, err.message);
        return [];
    }
}

async function getTrendsFromNewsAPI() {
    if (!process.env.NEWS_API_KEY) throw new Error("NEWS_API_KEY is not configured.");
    console.log("🚀 Starting GLOBAL primary flow: Scanning all NewsAPI categories...");

    // Danh sách các danh mục được NewsAPI hỗ trợ
    const categories = ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'];
    
    // Tạo một mảng các promise, mỗi promise là một cuộc gọi API cho một danh mục
    const apiPromises = categories.map(category => {
        return newsapi.v2.topHeadlines({
            category: category,
            language: 'en', // Lấy các nguồn tin tiếng Anh hàng đầu toàn cầu
            pageSize: 30,   // Lấy 15 tin hot nhất cho mỗi danh mục
        }).then(response => {
            if (response.status === 'ok' && response.articles.length > 0) {
                console.log(`✅ Fetched ${response.articles.length} headlines for category: ${category}`);
                // Chuẩn hóa bài báo và gán đúng danh mục
                return response.articles.map(article => normalizeNewsApiArticle(article, category, 'global')).filter(Boolean);
            }
            console.warn(`⚠️ No articles returned for category: ${category}`);
            return [];
            }).catch(err => {
            console.error(`❌ Error fetching headlines for category ${category}:`, err.message);
            return []; // Trả về mảng rỗng nếu có lỗi
        });
    });

    try {
        // Chờ tất cả các cuộc gọi API hoàn thành song song
        const results = await Promise.all(apiPromises);

        // Gộp tất cả các mảng trend từ các kết quả lại thành một mảng duy nhất
        const allTrends = results.flat();

        if (allTrends.length === 0) {
            console.warn("⚠️ Primary flow (NewsAPI) did not return any articles from any category.");
        } else {
            console.log(`✅ Primary flow successful. Total global trends from NewsAPI: ${allTrends.length}`);
        }
        return allTrends;

    } catch (err) {
        console.error("❌ A critical error occurred during the primary flow execution:", err.message);
        return []; // Kích hoạt fallback nếu có lỗi nghiêm trọng
    }
}


async function getTrendsFromRssFallback() {
    console.log("⚡️ Initiating RSS Fallback flow (with extensive VN sources)...");
    const fetchers = [
        // === VIETNAM ===
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/tin-moi-nhat.rss", "VNExpress", "News", "vn"),
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/the-gioi.rss", "VNExpress World", "Politics", "vn"),
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/kinh-doanh.rss", "VNExpress Business", "Business", "vn"),
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/so-hoa.rss", "VNExpress Technology", "Technology", "vn"),
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/giai-tri.rss", "VNExpress Entertainment", "Entertainment", "vn"),
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/the-thao.rss", "VNExpress Sports", "Sports", "vn"),
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/du-lich.rss", "VNExpress Travel", "Travel", "vn"),
        () => fetchAndParseXmlFeed("https://tuoitre.vn/rss/giao-duc.rss", "Tuổi Trẻ Education", "Education", "vn"),
        () => fetchAndParseXmlFeed("https://afamily.vn/rss/home.rss", "Afamily", "Family", "vn"),
        () => fetchAndParseXmlFeed("https://suckhoedoisong.vn/rss/home.rss", "Sức Khỏe & Đời Sống", "Health", "vn"),
        () => fetchAndParseXmlFeed("https://zingnews.vn/rss/giai-tri.rss", "ZingNews Entertainment", "Entertainment", "vn", ["Vietnam","Entertainment"]),

        // === INTERNATIONAL (for variety) ===
        () => fetchAndParseXmlFeed("https://venturebeat.com/feed/", "VentureBeat AI", "AI", "us", ["VentureBeat","AI"]),
        () => fetchAndParseXmlFeed("https://www.technologyreview.com/feed/", "MIT Technology Review", "AI", "global", ["AI","Research"]), // Changed to global
        () => fetchAndParseXmlFeed("https://www.theguardian.com/technology/ai/rss", "Guardian AI", "AI", "uk", ["UK","AI"]),
        () => fetchAndParseXmlFeed("https://www.euronews.com/next/rss", "Euronews Next (AI)", "AI", "eu", ["EU","AI"]),
        () => fetchAndParseXmlFeed("https://technode.com/feed/", "TechNode AI", "AI", "cn", ["China","AI"]),
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/khoa-hoc.rss", "VNExpress AI", "AI", "vn", ["Vietnam","AI"]),
        () => fetchAndParseXmlFeed("https://www.archaeology.org/rss.xml", "Archaeology Magazine", "Archaeology", "us", ["Archaeology"]),
        () => fetchAndParseXmlFeed("https://www.heritagedaily.com/category/archaeology/feed", "HeritageDaily", "Archaeology", "global", ["Archaeology"]),
        () => fetchAndParseXmlFeed("https://www.chinadaily.com.cn/rss/cnews.xml", "China Daily", "News", "cn"),
        () => fetchAndParseXmlFeed("https://pandaily.com/feed/", "Pandaily", "Technology", "cn"),
        () => fetchAndParseXmlFeed("https://techcrunch.com/feed/", "TechCrunch", "Technology", "us"),
        () => fetchAndParseXmlFeed("https://www.vogue.com/feed/rss", "Vogue", "Fashion", "us"),
        () => fetchAndParseXmlFeed("http://feeds.bbci.co.uk/news/rss.xml", "BBC News", "News", "uk"),
        () => fetchAndParseXmlFeed("https://www.caranddriver.com/rss/all.xml/", "Car and Driver", "Cars", "us", ["Cars"]),
        () => fetchAndParseXmlFeed("https://www.topgear.com/feeds/all/rss.xml", "Top Gear", "Cars", "uk", ["Cars"]),
        () => fetchAndParseXmlFeed("https://europe.autonews.com/rss", "Autonews Europe", "Cars", "eu", ["Cars"]),
  // () => fetchAndParseXmlFeed("https://www.largus.fr/rss.xml", "L'Argus", "Cars", "fr", ["France","Cars"]), // Removed
        () => fetchAndParseXmlFeed("https://www.autohome.com.cn/rss", "Autohome", "Cars", "cn", ["China","Cars"]),
        () => fetchAndParseXmlFeed("https://vnexpress.net/rss/oto-xe-may.rss", "VNExpress Auto", "Cars", "vn", ["Vietnam","Cars"]),
    ];
    const results = await Promise.allSettled(fetchers.map(f => f()));
    const fallbackTrends = results.filter(r => r.status === 'fulfilled' && r.value).flatMap(r => r.value);
    console.log(`✅ RSS Fallback completed, found ${fallbackTrends.length} trends.`);
    return fallbackTrends;
}

// =========================================================================
// BUILDER HANDLER CHÍNH
// =========================================================================
exports.handler = builder(async (event, context) => {
    // ... (Handler chính giữ nguyên)
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
    try {
        const primaryPromise = getTrendsFromNewsAPI();
        const fallbackPromise = getTrendsFromRssFallback();

        const [primaryTrends, fallbackTrends] = await Promise.all([primaryPromise, fallbackPromise]);

        const trendMap = new Map();
        [...primaryTrends, ...fallbackTrends].forEach(t => { if (t && t.id) trendMap.set(t.id, t) });
        let finalTrends = Array.from(trendMap.values());

        if (finalTrends.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, trends: [], message: "No trends found from any source." }),
            };
        }

        const maxValues = {
            views: Math.max(1, ...finalTrends.map(t => t.views || 0)),
            interactions: Math.max(1, ...finalTrends.map(t => t.interactions || 0)),
            searches: Math.max(1, ...finalTrends.map(t => t.searches || 0)),
            votes: Math.max(1, ...finalTrends.map(t => t.votes || 0)),
        };
        const preprocessedTrends = finalTrends.map(trend => ({
            ...trend,
            hotnessScore: calculateHotnessScore(trend, maxValues),
            type: trend.type || (Math.random() > 0.5 ? 'topic' : 'query')
        }));

        const sortedTrends = preprocessedTrends.filter(Boolean).sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0));

        return {
            statusCode: 200,
            headers: { ...headers, "Cache-Control": "public, max-age=1800, must-revalidate" },
            body: JSON.stringify({ success: true, trends: sortedTrends }),
        };
    } catch (err) {
        console.error("trends-builder handler CRITICAL error:", err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: "Failed to build trends", message: err.message }),
        };
    }
});