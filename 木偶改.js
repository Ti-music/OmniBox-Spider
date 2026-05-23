// @name 木偶
// @author
// @description 刮削：支持，弹幕：支持，嗅探：支持
// @dependencies: axios, cheerio
// @version 1.2.18
// 已删除：夸克直连规则 | 已屏蔽：115臻享分类 | 无外部下载依赖

// 引入 OmniBox SDK
const OmniBox = require("omnibox_sdk");
// 引入 cheerio(用于 HTML 解析)
let cheerio;
try {
  cheerio = require("cheerio");
} catch (error) {
  throw new Error("cheerio 模块未找到,请先安装:npm install cheerio");
}
let axios;
try {
  axios = require("axios");
} catch (error) {
  throw new Error("axios 模块未找到,请先安装:npm install axios");
}
const https = require("https");
const fs = require("fs");

// ==================== 配置区域 ====================
function splitConfigList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 网站地址
const WEB_SITE_CONFIG = process.env.WEB_SITE_MUOU || "https://www.muou.site;https://www.muou.asia;https://666.666291.xyz;";
const WEB_SITES = splitConfigList(WEB_SITE_CONFIG);
// 网盘类型：已删除 quark
const DRIVE_TYPE_CONFIG = splitConfigList(process.env.DRIVE_TYPE_CONFIG || "uc");
// 线路名称
const SOURCE_NAMES_CONFIG = splitConfigList(process.env.SOURCE_NAMES_CONFIG || "本地代理;服务端代理;直连");
// 是否开启外网服务器代理
const EXTERNAL_SERVER_PROXY_ENABLED = String(process.env.EXTERNAL_SERVER_PROXY_ENABLED || "false").toLowerCase() === "true";
// 排序
const DRIVE_ORDER = splitConfigList(process.env.DRIVE_ORDER || "baidu;tianyi;uc;115;xunlei;ali;123pan").map(s => s.toLowerCase());
// 缓存
const MUOU_CACHE_EX_SECONDS = Number(process.env.MUOU_CACHE_EX_SECONDS || 43200);
const MUOU_VERBOSE_DETAIL = String(process.env.MUOU_VERBOSE_DETAIL || "0") === "1";
// ==================== 配置区域结束 ====================

// 从线路名推断网盘类型：已删除夸克
function inferDriveTypeFromSourceName(name = "") {
  const raw = String(name || '').toLowerCase();
  if (raw.includes('百度')) return 'baidu';
  if (raw.includes('天翼')) return 'tianyi';
  if (raw === 'uc' || raw.includes('uc')) return 'uc';
  if (raw.includes('115')) return '115';
  if (raw.includes('迅雷')) return 'xunlei';
  if (raw.includes('阿里')) return 'ali';
  if (raw.includes('123')) return '123pan';
  return raw;
}

// 线路排序
function sortPlaySourcesByDriveOrder(playSources = []) {
  if (!Array.isArray(playSources) || playSources.length <= 1 || DRIVE_ORDER.length === 0) {
    return playSources;
  }
  const orderMap = new Map(DRIVE_ORDER.map((name, index) => [name, index]));
  return [...playSources].sort((a, b) => {
    const aType = inferDriveTypeFromSourceName(a?.name || '');
    const bType = inferDriveTypeFromSourceName(b?.name || '');
    const aOrder = orderMap.has(aType) ? orderMap.get(aType) : Number.MAX_SAFE_INTEGER;
    const bOrder = orderMap.has(bType) ? orderMap.get(bType) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return 0;
  });
}

function resolveCallerSource(params = {}, context = {}) {
  return String(context?.from || params?.source || "").toLowerCase();
}

function getBaseURLHost(context = {}) {
  const baseURL = String(context?.baseURL || "").trim();
  if (!baseURL) return "";
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch (error) {
    return baseURL.toLowerCase();
  }
}

function isPrivateHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host.endsWith(".intra")) return true;
  if (host.includes(":")) return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  return false;
}

function canUseServerProxy(context = {}) {
  if (EXTERNAL_SERVER_PROXY_ENABLED) return true;
  return isPrivateHost(getBaseURLHost(context));
}

function filterSourceNamesForCaller(sourceNames = [], callerSource = "", context = {}) {
  let filtered = Array.isArray(sourceNames) ? [...sourceNames] : [];
  const allowServerProxy = canUseServerProxy(context);

  if (callerSource === "web") {
    filtered = filtered.filter((name) => name !== "本地代理");
  } else if (callerSource === "emby") {
    if (allowServerProxy) {
      filtered = filtered.filter((name) => name === "服务端代理");
    } else {
      filtered = filtered.filter((name) => name !== "服务端代理");
    }
  } else if (callerSource === "uz") {
    filtered = filtered.filter((name) => name !== "本地代理");
  }

  if (!allowServerProxy) {
    filtered = filtered.filter((name) => name !== "服务端代理");
  }

  return filtered.length > 0 ? filtered : ["直连"];
}

function resolveRouteType(flag = "", callerSource = "", context = {}) {
  const allowServerProxy = canUseServerProxy(context);
  const validRouteTypes = new Set(["本地代理", "服务端代理", "直连"]);
  let routeType = "直连";

  if (callerSource === "web" || callerSource === "emby") {
    routeType = allowServerProxy ? "服务端代理" : "直连";
  }

  if (flag) {
    if (flag.includes("-")) {
      const flagParts = flag.split("-");
      routeType = flagParts[flagParts.length - 1];
    } else {
      routeType = flag;
    }
  }

  if (!validRouteTypes.has(routeType)) routeType = "直连";
  if (!allowServerProxy && routeType === "服务端代理") routeType = "直连";
  if (callerSource === "uz" && routeType === "本地代理") routeType = "直连";

  return routeType;
}

if (WEB_SITES.length === 0) {
  throw new Error("WEB_SITE 配置不能为空");
}

const INSECURE_HTTPS_AGENT = new https.Agent({
  rejectUnauthorized: false,
});

async function httpRequest(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const response = await axios({
    url, method, headers: options.headers || {}, data: options.body,
    timeout: options.timeout, httpsAgent: INSECURE_HTTPS_AGENT, validateStatus: () => true,
  });
  let body = response.data;
  if (typeof body !== "string") {
    body = body === undefined || body === null ? "" : JSON.stringify(body);
  }
  return { statusCode: response.status, body, headers: response.headers || {} };
}

function isBlockedHtml(body = "") {
  if (!body || typeof body !== "string") return false;
  const lower = body.toLowerCase();
  return lower.includes("just a moment") || lower.includes("cf-browser-verification") || lower.includes("captcha") || lower.includes("访问验证");
}

function buildCacheKey(prefix, value) {
  return `${prefix}:${value}`;
}

function logDetailDebug(message) {
  if (MUOU_VERBOSE_DETAIL) {
    OmniBox.log("info", message);
  }
}

async function getCachedJSON(key) {
  try { return await OmniBox.getCache(key); } catch { return null; }
}

async function setCachedJSON(key, value, exSeconds) {
  try { await OmniBox.setCache(key, value, exSeconds); } catch {}
}

async function requestWithFailover(path, options = {}) {
  let lastError = null;
  const perDomainTimeout = Math.max(1000, Math.floor(30000 / WEB_SITES.length));
  for (let i = 0; i < WEB_SITES.length; i++) {
    const baseUrl = removeTrailingSlash(WEB_SITES[i]);
    const fullUrl = path.startsWith('http') ? path : baseUrl + path;
    try {
      const response = await httpRequest(fullUrl, {
        ...options, method: options.method || "GET",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", ...(options.headers || {}) },
        timeout: options.timeout ?? perDomainTimeout,
      });
      if (response.statusCode === 200 && response.body) {
        if (isBlockedHtml(response.body)) { lastError = new Error("命中风控"); continue; }
        return { response, baseUrl };
      }
    } catch (error) {
      lastError = error;
      if (i < WEB_SITES.length - 1) continue;
    }
  }
  throw lastError || new Error("所有域名请求失败");
}

function getBaseUrl() {
  return removeTrailingSlash(WEB_SITES[0]);
}

function removeTrailingSlash(url) {
  if (!url) return "";
  return url.replace(/\/+$/, "");
}

// 筛选器
const FILTER_KEY_NAME_MAP = { class: "类型", area: "地区", lang: "语言", year: "年份", letter: "字母", by: "排序", sort: "排序", id: "分类" };
let autoFiltersCache = { data: null, expiresAt: 0 };

function normalizeFilterValueItem(item) {
  if (!item) return null;
  const name = String(item.n || item.name || "").trim();
  const value = String(item.v ?? item.value ?? "").trim();
  if (!name && !value) return null;
  return { name, value };
}

function normalizeFilterGroup(group) {
  if (!group) return null;
  const key = String(group.key || "").trim();
  const name = String(group.n || group.name || "").trim();
  const valuesRaw = Array.isArray(group.v) ? group.v : (Array.isArray(group.value) ? group.value : []);
  const values = valuesRaw.map(normalizeFilterValueItem).filter(Boolean);
  if (!key || values.length === 0) return null;
  return { key, name: name || FILTER_KEY_NAME_MAP[key] || key, init: String(group.init ?? ""), value: values };
}

function extractFilterKeyFromHref(href = "") {
  for (const key of Object.keys(FILTER_KEY_NAME_MAP)) {
    if (href.includes(`${key}/`)) return key;
  }
  if (href.includes("id/")) return "id";
  return null;
}

function extractFilterValueFromHref(href = "", key = "") {
  if (!href || !key) return "";
  const marker = `${key}/`;
  const idx = href.indexOf(marker);
  if (idx < 0) return "";
  const rest = href.substring(idx + marker.length);
  return decodeURIComponent((rest.split('/')[0] || "").split('.')[0] || "");
}

function parseFiltersFromHtml(html = "") {
  if (!html) return [];
  const $ = cheerio.load(html);
  const groups = [];
  const libraryBoxes = $(".library-box.scroll-box").slice(1);
  libraryBoxes.each((_, element) => {
    const links = $(element).find(".library-list a");
    if (!links.length) return;
    const firstHref = links.first().attr("href") || "";
    const key = extractFilterKeyFromHref(firstHref);
    if (!key) return;
    const values = [{ name: "全部", value: "" }];
    const dedupe = new Set(["__ALL__"]);
    links.each((__, a) => {
      const href = $(a).attr("href") || "";
      const value = extractFilterValueFromHref(href, key);
      const name = ($(a).text() || "").trim();
      const dk = `${name}::${value}`;
      if (!name && !value) return;
      if (dedupe.has(dk)) return;
      dedupe.add(dk);
      values.push({ name, value });
    });
    if (values.length > 1) groups.push({ key, name: FILTER_KEY_NAME_MAP[key] || key, init: "", value: values });
  });
  return groups;
}

async function getAutoFiltersByCategory(categoryId) {
  if (!categoryId) return [];
  try {
    const { response } = await requestWithFailover(`/index.php/vod/show/id/${categoryId}.html`);
    if (response.statusCode !== 200 || !response.body) return [];
    return parseFiltersFromHtml(response.body);
  } catch { return []; }
}

function normalizeStaticFilters(rawFilters) {
  const result = {};
  if (!rawFilters || typeof rawFilters !== "object") return result;
  for (const typeId of Object.keys(rawFilters)) {
    const groups = Array.isArray(rawFilters[typeId]) ? rawFilters[typeId] : [];
    const ng = groups.map(normalizeFilterGroup).filter(Boolean);
    if (ng.length) result[typeId] = ng;
  }
  return result;
}

async function getPreferredFilters(classes = []) {
  const now = Date.now();
  if (autoFiltersCache.data && now < autoFiltersCache.expiresAt) return autoFiltersCache.data;
  const staticFilters = normalizeStaticFilters(await getDynamicFilters());
  let merged = staticFilters;
  if (Object.keys(staticFilters).length === 0) {
    const auto = {};
    for (const c of classes) {
      const id = String(c?.type_id || "").trim();
      if (!id) continue;
      const g = await getAutoFiltersByCategory(id);
      if (g.length) auto[id] = g;
    }
    if (Object.keys(auto).length) merged = auto;
  }
  autoFiltersCache = { data: merged, expiresAt: now + 10 * 60 * 1000 };
  return merged;
}

// 视频文件判断
function isVideoFile(file) {
  if (!file || !file.file_name) return false;
  const n = file.file_name.toLowerCase();
  const exts = [".mp4", ".mkv", ".avi", ".flv", ".mov", ".wmv", ".m3u8", ".ts", ".webm", ".m4v"];
  for (const e of exts) if (n.endsWith(e)) return true;
  if (file.format_type) {
    const t = String(file.format_type).toLowerCase();
    if (t.includes("video") || t.includes("mpeg") || t.includes("h264")) return true;
  }
  return false;
}

async function getAllVideoFiles(shareURL, files, errors = []) {
  if (!files || !Array.isArray(files)) return [];
  const tasks = files.map(async (file) => {
    if (file.file && isVideoFile(file)) return [file];
    else if (file.dir) {
      try {
        const sub = await OmniBox.getDriveFileList(shareURL, file.fid);
        if (sub?.files) return await getAllVideoFiles(shareURL, sub.files, errors);
        return [];
      } catch (e) {
        errors.push({ path: file.name || file.fid, fid: file.fid, msg: e.message });
        return [];
      }
    }
    return [];
  });
  const res = await Promise.all(tasks);
  return res.flat();
}

function formatFileSize(size) {
  if (!size || size <= 0) return "";
  const u = 1024;
  const units = ["B", "K", "M", "G", "T"];
  if (size < u) return `${size}B`;
  let exp = 0;
  let s = size;
  while (s >= u && exp < units.length - 1) { s /= u; exp++; }
  return s.toFixed(1) + units[exp];
}

// 首页
async function home(params) {
  try {
    let classes = [];
    let list = [];
    const { response, baseUrl } = await requestWithFailover('/');
    if (response.statusCode === 200 && response.body) {
      const $ = cheerio.load(response.body);
      $(".module-tab-items .module-tab-item").each((_, el) => {
        const id = $(el).attr("data-id");
        const name = $(el).attr("data-name");
        if (id && id !== "0" && name && name.trim() !== "115臻享") {
          classes.push({ type_id: id, type_name: name.trim() });
        }
      });
      $(".module-item").each((_, el) => {
        const $it = $(el);
        const href = $it.find(".module-item-pic a").attr("href") || $it.find(".module-item-title").attr("href");
        const name = $it.find(".module-item-pic img").attr("alt") || $it.find(".module-item-title").text().trim();
        let pic = $it.find(".module-item-pic img").attr("data-src") || $it.find(".module-item-pic img").attr("src");
        if (pic && !pic.startsWith("http")) pic = baseUrl + pic;
        const remark = $it.find(".module-item-text").text().trim();
        if (href && name) list.push({ vod_id: href, vod_name: name, vod_pic: pic || "", vod_remarks: remark || "" });
      });
    }
    const filters = await getPreferredFilters(classes);
    return { class: classes, list, filters };
  } catch { return { class: [], list: [], filters: {} }; }
}

// 分类
async function category(params) {
  try {
    const cid = params.categoryId || params.type_id || "";
    const page = parseInt(params.page || 1);
    if (!cid) return { list: [], page: 1, pagecount: 0, total: 0 };
    let url = `/index.php/vod/show`;
    const f = params.filters || {};
    if (f.area) url += `/area/${f.area}`;
    if (f.sort || f.by) url += `/by/${f.sort || f.by}`;
    if (f.class) url += `/class/${f.class}`;
    if (f.lang) url += `/lang/${f.lang}`;
    if (f.letter) url += `/letter/${f.letter}`;
    if (f.year) url += `/year/${f.year}`;
    if (f.tid || f.id) url += `/id/${f.tid || f.id}.html`;
    else url += `/id/${cid}/page/${page}.html`;

    const { response, baseUrl } = await requestWithFailover(url);
    if (response.statusCode !== 200 || !response.body) return { list: [], page, pagecount: 0, total: 0 };
    const $ = cheerio.load(response.body);
    const videos = [];
    $("#main .module-item").each((_, el) => {
      const $it = $(el);
      const href = $it.find(".module-item-pic a").attr("href");
      const name = $it.find(".module-item-pic img").attr("alt");
      let pic = $it.find(".module-item-pic img").attr("data-src");
      if (pic && !pic.startsWith("http")) pic = baseUrl + pic;
      const remark = $it.find(".module-item-text").text();
      if (href && name) videos.push({ vod_id: href, vod_name: name, vod_pic: pic || "", vod_remarks: remark || "" });
    });
    return { list: videos, page, pagecount: 0, total: videos.length };
  } catch { return { list: [], page: params.page || 1, pagecount: 0, total: 0 }; }
}

// 工具函数
function buildScrapedFileName(scrape, map, orig) {
  if (!map || map.episodeNumber === 0 || (map.confidence && map.confidence < 0.5)) return orig;
  if (scrape && scrape.episodes) {
    for (const ep of scrape.episodes) {
      if (ep.episodeNumber === map.episodeNumber && ep.seasonNumber === map.seasonNumber) {
        return ep.name ? `${ep.episodeNumber}.${ep.name}` : orig;
      }
    }
  }
  return orig;
}

function normalizeEpisodeName(n = "") {
  return String(n).replace(/\.[^.]+$/, "").replace(/[._]+/g, " ").trim();
}

function encodePlayMeta(obj) {
  try { return Buffer.from(JSON.stringify(obj || {})).toString("base64"); } catch { return ""; }
}

function decodePlayMeta(s) {
  try { return JSON.parse(Buffer.from(s, "base64").toString()) || {}; } catch { return {}; }
}

// 缓存
async function getDetailPageCached(id) {
  const k = buildCacheKey("muou:detailHtml", id);
  let d = await getCachedJSON(k);
  if (!d) { d = await requestWithFailover(id); await setCachedJSON(k, d, MUOU_CACHE_EX_SECONDS); }
  return d;
}

async function getDriveInfoCached(url) {
  const k = buildCacheKey("muou:driveInfo", url);
  let d = await getCachedJSON(k);
  if (!d) { d = await OmniBox.getDriveInfoByShareURL(url); await setCachedJSON(k, d, MUOU_CACHE_EX_SECONDS); }
  return d;
}

async function getRootFileListCached(url) {
  const k = buildCacheKey("muou:rootFiles", url);
  let d = await getCachedJSON(k);
  if (!d) { d = await OmniBox.getDriveFileList(url, "0"); await setCachedJSON(k, d, MUOU_CACHE_EX_SECONDS); }
  return d;
}

async function getAllVideoFilesCached(url, files) {
  const k = buildCacheKey("muou:videoFiles", url);
  let d = await getCachedJSON(k);
  if (!d || !d.length) { d = await getAllVideoFiles(url, files); await setCachedJSON(k, d, MUOU_CACHE_EX_SECONDS); }
  return d;
}

// 详情
async function detail(params, context) {
  try {
    const vid = params.videoId || "";
    if (!vid) throw new Error("视频ID为空");
    const source = params.source || "";
    const page = await getDetailPageCached(vid);
    const { response, baseUrl } = page;
    if (response.statusCode !== 200) throw new Error("请求失败");
    const $ = cheerio.load(response.body);

    // 基础信息
    const vodName = $(".page-title")[0]?.children?.[0]?.data || "";
    let vodPic = $($(".mobile-play")).find(".lazyload")[0]?.attribs?.["data-src"] || "";
    if (vodPic && !vodPic.startsWith("http")) vodPic = baseUrl + vodPic;
    let director = "", actor = "", content = "";
    $(".video-info-itemtitle").each((_, el) => {
      const k = $(el).text();
      const v = $(el).next().find("a").map((i, e) => $(e).text().trim()).get().join(", ");
      if (k.includes("导演")) director = v;
      else if (k.includes("主演")) actor = v;
      else if (k.includes("剧情")) content = $(el).next().find("p").text().trim();
    });

    // 提取网盘链接
    const panUrls = [];
    $(".module-row-info p").each((_, el) => {
      const u = $(el).text().trim();
      if (u.startsWith("http")) panUrls.push(u);
    });

    // 并行处理网盘
    const tasks = panUrls.map(async (url) => {
      try {
        const drive = await getDriveInfoCached(url);
        let name = drive.displayName || "未知";
        const files = await getRootFileListCached(url);
        const videos = await getAllVideoFilesCached(url, files.files || []);
        if (!videos.length) return null;
        return { url, name, drive, videos };
      } catch { return null; }
    });

    const results = (await Promise.all(tasks)).filter(Boolean);
    let playSources = [];

    for (const res of results) {
      const { url, name, drive, videos } = res;
      let lines = [name];
      if (DRIVE_TYPE_CONFIG.includes(drive.driveType)) {
        lines = filterSourceNamesForCaller([...SOURCE_NAMES_CONFIG], source, context);
      }

      for (const line of lines) {
        const eps = [];
        for (const f of videos) {
          if (!f.file_name || !f.fid) continue;
          const fid = `${url}|${f.fid}|${vid}`;
          const meta = encodePlayMeta({ sid: vid, fid: `${url}|${f.fid}`, v: vodName, t: vodName, e: normalizeEpisodeName(f.file_name) });
          const size = formatFileSize(f.size || f.file_size);
          const title = size ? `[${size}] ${f.file_name}` : f.file_name;
          eps.push({ name: title, playId: `${url}|${f.fid}|${meta}`, episodeName: normalizeEpisodeName(f.file_name) });
        }
        if (eps.length) {
          playSources.push({
            name: DRIVE_TYPE_CONFIG.includes(drive.driveType) ? `${name}-${line}` : name,
            episodes: eps
          });
        }
      }
    }

    playSources = sortPlaySourcesByDriveOrder(playSources);
    return {
      list: [{
        vod_id: vid, vod_name: vodName, vod_pic: vodPic,
        vod_director: director, vod_actor: actor, vod_content: content || `共${panUrls.length}个网盘`,
        vod_play_sources: playSources
      }]
    };
  } catch (e) {
    return { list: [] };
  }
}

// 搜索
async function search(params) {
  try {
    const wd = params.keyword || "";
    const page = parseInt(params.page || 1);
    if (!wd) return { list: [], page: 1, pagecount: 0, total: 0 };
    const { response, baseUrl } = await requestWithFailover(`/index.php/vod/search/page/${page}/wd/${wd}.html`);
    if (response.statusCode !== 200 || !response.body) return { list: [], page, pagecount: 0, total: 0 };
    const $ = cheerio.load(response.body);
    const list = [];
    $(".module-search-item").each((_, el) => {
      const href = $(el).find(".video-serial").attr("href");
      const name = $(el).find(".video-serial").attr("title");
      let pic = $(el).find(".module-item-pic img").attr("data-src");
      if (pic && !pic.startsWith("http")) pic = baseUrl + pic;
      const remark = $(el).find(".video-serial").text();
      if (href && name) list.push({ vod_id: href, vod_name: name, vod_pic: pic || "", vod_remarks: remark });
    });
    return { list, page, pagecount: 0, total: list.length };
  } catch { return { list: [], page: params.page || 1, pagecount: 0, total: 0 }; }
}

// 播放
async function play(params, context) {
  try {
    const flag = params.flag || "";
    const pid = params.playId || "";
    const source = resolveCallerSource(params, context);
    if (!pid) throw new Error("播放ID为空");
    const parts = pid.split("|");
    let meta = {};
    let core = [...parts];
    if (core.length >= 3) {
      try { meta = decodePlayMeta(core[core.length - 1]); core = core.slice(0, -1); } catch {}
    }
    const shareUrl = core[0] || "";
    const fileId = core[1] || "";
    if (!shareUrl || !fileId) throw new Error("参数错误");
    const route = resolveRouteType(flag, source, context);
    const playInfo = await OmniBox.getDriveVideoPlayInfo(shareUrl, fileId, route);
    if (!playInfo || !playInfo.url || !playInfo.url.length) throw new Error("无播放地址");
    const urls = playInfo.url.map(u => ({ name: u.name || "播放", url: u.url }));
    let header = playInfo.header || {};
    if (shareUrl.toLowerCase().includes("uc.cn") && route === "直连") header = {};
    return { urls, flag: shareUrl, header, parse: 0, danmaku: playInfo.danmaku || [] };
  } catch {
    return { urls: [], flag: params.flag || "", header: {}, danmaku: [] };
  }
}

// 静态筛选器
async function getDynamicFilters() {
  return {
    "25": [{
      "key": "area", "name": "地区", "init": "",
      "value": [
        { "name": "全部", "value": "" }, { "name": "中国大陆", "value": "中国大陆" },
        { "name": "大陆", "value": "大陆" }, { "name": "美国", "value": "美国" },
        { "name": "香港", "value": "香港" }, { "name": "韩国", "value": "韩国" },
        { "name": "英国", "value": "英国" }, { "name": "台湾", "value": "台湾" },
        { "name": "日本", "value": "日本" }, { "name": "法国", "value": "法国" },
        { "name": "泰国", "value": "泰国" }, { "name": "其它", "value": "其它" }
      ]
    }]
  };
}

module.exports = { home, category, detail, search, play };
