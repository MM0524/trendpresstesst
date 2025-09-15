// netlify/functions/fetch-trends.js
const NewsAPI = require('newsapi');
const crypto = require('crypto');
const googleTrends = require('google-trends-api');

// Khởi tạo NewsAPI client với API key từ biến môi trường
const newsapi = new NewsAPI(process.env.NEWS_API_KEY);

// --- CÁC HÀM HELPER ---

function toDateStr(d) {
    const dt = d ? new Date(d) : new Date();
    return isNaN(dt.getTime()) ? new Date().toISOString().split("T")[0] : dt.toISOString().split("T")[0];
}

function toSortValue(d) {
    const dt = d ? new Date(d) : null;
    return dt && !isNaN(dt.getTime()) ? dt.getTime() : 0;
}

function normalizeNewsApiArticle(article) {
    const { title, description, url, publishedAt, source } = article;
    if (!title || title === "[Removed]" || !url) return null;
    const stableId = crypto.createHash('md5').update(url).digest('hex');
    return {
        id: stableId,
        title_en: title || '',
        description_en: description || "No description available.",
        title_vi: null, description_vi: null, category: "Search",
        tags: [source.name.replace(/\s/g, '')], source: url,
        date: toDateStr(publishedAt), submitter: source.name || "Unknown Source",
        publishedAt: publishedAt
    };
}

function aggregateArticlesToTimeline(articles, daysAgo, hoursAgo = 0) {
    if (!articles || articles.length === 0) return [];
    const counts = new Map();
    const isHourly = hoursAgo > 0;
    articles.forEach(article => {
        const date = new Date(article.publishedAt);
        let key = isHourly
            ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).toISOString()
            : date.toISOString().split('T')[0];
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    const timelineData = [];
    const now = new Date();
    if (isHourly) {
        for (let i = hoursAgo; i >= 0; i--) {
            const date = new Date(now);
            date.setHours(date.getHours() - i);
            const key = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).toISOString();
            const value = (counts.get(key) || 0) * (Math.random() * 50 + 50);
            timelineData.push({ time: Math.floor(date.getTime() / 1000), value: [Math.round(value)] });
        }
    } else {
        for (let i = daysAgo; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            const key = date.toISOString().split('T')[0];
            const value = (counts.get(key) || 0) * (Math.random() * 50 + 50);
            timelineData.push({ time: Math.floor(date.getTime() / 1000), value: [Math.round(value)] });
        }
    }
    return timelineData;
}

// Hàm thực hiện hồi quy tuyến tính để dự đoán xu hướng
function predictFutureTrends(timelineData, daysToPredict = 7) {
    if (!timelineData || timelineData.length < 2) return [];
    const recentData = timelineData.slice(-14);
    const n = recentData.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    recentData.forEach((point, i) => {
        const x = i;
        const y = point.value[0];
        sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
    });
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX) || 0;
    const intercept = (sumY - slope * sumX) / n;
    const lastPoint = timelineData[timelineData.length - 1];
    const lastDate = new Date(lastPoint.time * 1000);
    const predictions = [];
    for (let i = 1; i <= daysToPredict; i++) {
        const predictedValue = slope * (n - 1 + i) + intercept;
        const futureDate = new Date(lastDate);
        futureDate.setDate(futureDate.getDate() + i);
        predictions.push({
            time: Math.floor(futureDate.getTime() / 1000),
            value: [Math.max(0, Math.round(predictedValue * (1 + (Math.random() - 0.5) * 0.1)))],
            isPrediction: true
        });
    }
    return predictions;
}

// --- HANDLER CHÍNH ---
exports.handler = async (event) => {
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
    
    try {
        const { searchTerm, timeframe: rawTimeframe = '7d', mode } = event.queryStringParameters;
        if (!searchTerm || !searchTerm.trim()) {
            return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: "searchTerm is required." }) };
        }
        
        let startTime, hoursAgo = 0, daysAgo = 0;
        if (mode === 'predictive') {
            startTime = new Date();
            startTime.setDate(startTime.getDate() - 90);
            daysAgo = 90;
        } else {
            const TIMEFRAME_MAP = {
                '1h': { hours: 1 }, '6h': { hours: 6 }, '24h': { hours: 24 },
                '3d': { days: 3 }, '7d': { days: 7 }, '1m': { days: 30 },
                '3m': { days: 90 }, '12m': { days: 365 },
            };
            const timeConfig = TIMEFRAME_MAP[rawTimeframe] || { days: 7 };
            startTime = new Date();
            if (timeConfig.hours) {
                startTime.setHours(startTime.getHours() - timeConfig.hours);
                hoursAgo = timeConfig.hours;
            } else {
                startTime.setDate(startTime.getDate() - timeConfig.days);
                daysAgo = timeConfig.days;
            }
        }
        
        const newsApiStartTime = new Date();
        newsApiStartTime.setDate(newsApiStartTime.getDate() - 28);

        const interestPromise = googleTrends.interestOverTime({ keyword: searchTerm, startTime: startTime });
        const newsPromise = newsapi.v2.everything({ q: searchTerm, from: newsApiStartTime.toISOString(), sortBy: 'relevancy', pageSize: 100, language: 'en' });
        const relatedQueriesPromise = googleTrends.relatedQueries({ keyword: searchTerm, startTime: startTime });

        const [interestResult, newsResult, relatedQueriesResult] = await Promise.allSettled([interestPromise, newsPromise, relatedQueriesPromise]);

        let timelineData = null, topArticles = [], relatedQueries = [], sourceApi = "Google Trends";

        if (interestResult.status === 'fulfilled') {
            try {
                const parsed = JSON.parse(interestResult.value);
                if (parsed.default.timelineData && parsed.default.timelineData.length > 0) {
                    timelineData = parsed.default.timelineData.map(p => ({ ...p, value: [p.value[0] * 1000] }));
                }
            } catch (e) { console.error("Parsing interestOverTime failed:", e.message); }
        }

        if (newsResult.status === 'fulfilled' && newsResult.value.status === 'ok' && newsResult.value.articles.length > 0) {
            const allArticles = newsResult.value.articles.map(normalizeNewsApiArticle).filter(Boolean);
            topArticles = allArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 5);
            if (!timelineData) {
                sourceApi = "NewsAPI";
                timelineData = aggregateArticlesToTimeline(allArticles, daysAgo, hoursAgo);
            }
        }
        
        if (relatedQueriesResult.status === 'fulfilled') {
            try {
                const parsed = JSON.parse(relatedQueriesResult.value);
                const risingQueries = parsed.default.rankedKeyword.find(k => k.rankedKeyword && Array.isArray(k.rankedKeyword) && k.rankedKeyword.every(q => q.value > 0));
                if (risingQueries) relatedQueries = risingQueries.rankedKeyword.slice(0, 5);
            } catch (e) { console.error("Parsing related queries failed:", e.message); }
        }

        if (mode === 'predictive' && timelineData && timelineData.length > 0) {
            const predictions = predictFutureTrends(timelineData);
            timelineData.push(...predictions);
        }

        // **** BẮT ĐẦU KHỐI CODE ĐƯỢC THÊM LẠI ****
        let totalEngagement = 0;
        let peakEngagement = 0;
        if (timelineData && timelineData.length > 0) {
            const historicalTimeline = timelineData.filter(p => !p.isPrediction);
            if (historicalTimeline.length > 0) {
                const values = historicalTimeline.map(p => p.value[0]);
                totalEngagement = values.reduce((sum, val) => sum + val, 0);
                peakEngagement = Math.max(...values);
            }
        }
        // **** KẾT THÚC KHỐI CODE ĐƯỢC THÊM LẠI ****

        if (!timelineData && topArticles.length === 0 && relatedQueries.length === 0) {
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, trends: [] }) };
        }

        const aggregatedTrend = {
            id: `aggregated-${searchTerm.replace(/\s/g, '-')}-${rawTimeframe}-${mode || 'historical'}`,
            title_en: searchTerm,
            isAggregated: true,
            submitter: sourceApi,
            timelineData: timelineData || [],
            topArticles: topArticles,
            relatedQueries: relatedQueries,
            // Thêm lại 2 thuộc tính này
            totalEngagement: totalEngagement,
            peakEngagement: peakEngagement,
        };
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, trends: [aggregatedTrend] }),
        };

    } catch (err) {
        console.error("fetch-trends handler critical error:", err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, message: err.message }),
        };
    }
};