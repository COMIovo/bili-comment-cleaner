(() => {
  "use strict";

  const utils = window.BiliCleanerUtils;
  const AICU_REPLY_API = "https://api.aicu.cc/api/v3/search/getreply";
  const AICU_WORKER_URL = "https://www.aicu.cc/";
  const AICU_API_ORIGIN = "https://api.aicu.cc/";
  const BILI_NAV_API = "https://api.bilibili.com/x/web-interface/nav";
  const BILI_VIEW_API = "https://api.bilibili.com/x/web-interface/view";
  const BILI_REPLY_PAGE_API = "https://api.bilibili.com/x/v2/reply";
  const BILI_REPLY_DETAIL_API = "https://api.bilibili.com/x/v2/reply/detail";
  const BILI_REPLY_INFO_API = "https://api.bilibili.com/x/v2/reply/info";
  const BILI_REPLY_MAIN_API = "https://api.bilibili.com/x/v2/reply/main";
  const BILI_REPLY_SECOND_API = "https://api.bilibili.com/x/v2/reply/reply";
  const BILI_REPLY_DELETE_API = "https://api.bilibili.com/x/v2/reply/del";
  const BILI_WORKER_URL = "https://www.bilibili.com/";
  const SETTINGS_KEY = "biliCleanerSettings";
  const PROCESSED_KEY_PREFIX = "biliCleanerProcessed:";
  const MAX_RENDER_ROWS = 500;
  const MAX_PROCESSED_RECORDS = 50000;
  const REPLY_PAGE_SIZE = 20;
  const SECOND_REPLY_PAGE_SIZE = 20;
  const MAX_SECOND_REPLY_PAGES = 30;
  const FATAL_CODES = new Set([-101, -111, -509]);
  const CLOSED_STATUSES = new Set(["deleted", "gone", "invalid"]);

  const state = {
    user: null,
    csrf: "",
    items: [],
    manualItems: [],
    logs: [],
    selected: new Set(),
    manualSelected: new Set(),
    processedRecords: {},
    scan: {
      running: false,
      stop: false,
      mode: "aicu",
      pages: 0,
      scanned: 0,
      hiddenProcessed: 0
    },
    deletion: {
      running: false,
      paused: false,
      stop: false,
      pool: "aicu"
    },
    settings: {
      keywords: "",
      startDate: "",
      endDate: "",
      deleteInterval: 3,
      maxPages: 100,
      videoList: "",
      strictVerify: true,
      showProcessed: false
    }
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindElements();
    bindEvents();
    await loadSettings();
    applySettingsToForm();
    renderAll();
    await refreshLogin();
  }

  function bindElements() {
    for (const id of [
      "loginStatus", "refreshLogin", "keywords", "startDate", "endDate", "deleteInterval",
      "maxPages", "strictVerify", "showProcessed", "videoList", "manualImportText", "importManual", "clearManualInput",
      "startScan", "startVideoScan", "stopScan", "clearResults", "clearProcessed", "importProgress",
      "scanProgress", "metricCandidates", "metricSelected", "metricDeleted", "metricFailed", "metricHidden",
      "manualMetricCandidates", "manualMetricSelected", "manualMetricDeleted", "manualMetricFailed",
      "selectAll", "invertSelection", "startDelete", "pauseDelete", "stopDelete",
      "manualSelectAll", "manualInvertSelection", "manualClearResults", "manualStartDelete", "manualPauseDelete", "manualStopDelete",
      "previewBody", "manualPreviewBody", "message", "renderHint", "manualRenderHint", "exportCsv", "exportJson", "copyDebug", "logList"
    ]) {
      els[id] = document.getElementById(id);
    }
  }

  function bindEvents() {
    els.refreshLogin.addEventListener("click", refreshLogin);
    els.startScan.addEventListener("click", () => startScan("aicu"));
    els.startVideoScan.addEventListener("click", () => startDirectVideoScan({ pool: "aicu" }));
    els.stopScan.addEventListener("click", () => {
      state.scan.stop = true;
      setMessage("正在停止扫描，当前请求结束后会停下。", "warn");
    });
    els.clearResults.addEventListener("click", clearResults);
    els.clearProcessed.addEventListener("click", clearProcessedRecords);
    els.importManual.addEventListener("click", importManualCandidates);
    els.clearManualInput.addEventListener("click", () => {
      els.manualImportText.value = "";
      els.importProgress.textContent = "输入已清空";
    });
    els.selectAll.addEventListener("click", selectAllPending);
    els.invertSelection.addEventListener("click", invertSelection);
    els.startDelete.addEventListener("click", () => startDelete("aicu"));
    els.pauseDelete.addEventListener("click", togglePauseDelete);
    els.stopDelete.addEventListener("click", stopDelete);
    els.manualSelectAll.addEventListener("click", () => selectAllPending("manual"));
    els.manualInvertSelection.addEventListener("click", () => invertSelection("manual"));
    els.manualClearResults.addEventListener("click", clearManualResults);
    els.manualStartDelete.addEventListener("click", () => startDelete("manual"));
    els.manualPauseDelete.addEventListener("click", togglePauseDelete);
    els.manualStopDelete.addEventListener("click", stopDelete);
    els.exportCsv.addEventListener("click", exportCsv);
    els.exportJson.addEventListener("click", exportJson);
    els.copyDebug.addEventListener("click", copyDebugLog);

    for (const input of [els.keywords, els.startDate, els.endDate, els.deleteInterval, els.maxPages, els.strictVerify, els.showProcessed, els.videoList]) {
      input.addEventListener("input", () => {
        collectSettingsFromForm();
        saveSettings();
      });
    }
  }

  async function loadSettings() {
    if (!chrome.storage) return;
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    if (result[SETTINGS_KEY]) {
      state.settings = { ...state.settings, ...result[SETTINGS_KEY] };
    }
  }

  function saveSettings() {
    if (!chrome.storage) return;
    chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
  }

  function applySettingsToForm() {
    els.keywords.value = state.settings.keywords || "";
    els.startDate.value = state.settings.startDate || "";
    els.endDate.value = state.settings.endDate || "";
    els.deleteInterval.value = state.settings.deleteInterval || 3;
    els.maxPages.value = state.settings.maxPages || 100;
    els.videoList.value = state.settings.videoList || "";
    els.strictVerify.checked = state.settings.strictVerify !== false;
    els.showProcessed.checked = state.settings.showProcessed === true;
  }

  function collectSettingsFromForm() {
    state.settings = {
      keywords: els.keywords.value.trim(),
      startDate: els.startDate.value,
      endDate: els.endDate.value,
      deleteInterval: clampNumber(els.deleteInterval.value, 1, 120, 3),
      maxPages: clampNumber(els.maxPages.value, 1, 500, 100),
      videoList: els.videoList.value.trim(),
      strictVerify: els.strictVerify.checked,
      showProcessed: els.showProcessed.checked
    };
    return state.settings;
  }

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(num)));
  }

  async function refreshLogin() {
    setMessage("正在读取 B站登录态...", "info");
    try {
      const uidCookie = await getCookie("DedeUserID");
      const csrfCookie = await getCookie("bili_jct");

      if (!uidCookie || !csrfCookie) {
        state.user = null;
        state.csrf = "";
        updateLoginChip("未登录或缺少 cookie", "bad");
        setMessage("请先在当前浏览器登录 B站，再刷新登录态。", "warn");
        renderAll();
        return;
      }

      state.user = {
        uid: String(uidCookie.value),
        uname: ""
      };
      state.csrf = String(csrfCookie.value);

      try {
        const nav = await fetchBiliJson(BILI_NAV_API);
        if (nav.code === 0 && nav.data && nav.data.isLogin) {
          state.user.uid = String(nav.data.mid || state.user.uid);
          state.user.uname = nav.data.uname || "";
        }
      } catch (error) {
        addLog("登录核验", "warn", `无法读取 nav 接口，继续使用 cookie UID：${error.message}`);
      }

      await loadProcessedRecords();
      updateLoginChip(`UID ${state.user.uid}${state.user.uname ? ` · ${state.user.uname}` : ""}`, "good");
      setMessage("登录态已就绪。", "success");
      renderAll();
    } catch (error) {
      updateLoginChip("读取失败", "bad");
      setMessage(error.message, "error");
    }
  }

  function getCookie(name) {
    return new Promise((resolve) => {
      chrome.cookies.get({ url: "https://www.bilibili.com/", name }, (cookie) => {
        if (cookie) {
          resolve(cookie);
          return;
        }
        chrome.cookies.get({ url: "https://api.bilibili.com/", name }, resolve);
      });
    });
  }

  async function loadProcessedRecords() {
    state.processedRecords = {};
    if (!chrome.storage || !state.user || !state.user.uid) return;
    const key = processedStorageKey();
    const result = await chrome.storage.local.get(key);
    state.processedRecords = result[key] && typeof result[key] === "object" ? result[key] : {};
  }

  async function saveProcessedRecords() {
    if (!chrome.storage || !state.user || !state.user.uid) return;
    pruneProcessedRecords();
    await chrome.storage.local.set({ [processedStorageKey()]: state.processedRecords });
  }

  function processedStorageKey() {
    return `${PROCESSED_KEY_PREFIX}${state.user.uid}`;
  }

  function pruneProcessedRecords() {
    const entries = Object.entries(state.processedRecords);
    if (entries.length <= MAX_PROCESSED_RECORDS) return;
    entries.sort((a, b) => String(b[1].at || "").localeCompare(String(a[1].at || "")));
    state.processedRecords = Object.fromEntries(entries.slice(0, MAX_PROCESSED_RECORDS));
  }

  async function startScan(mode = "aicu") {
    if (state.scan.running) return;
    collectSettingsFromForm();
    saveSettings();
    const scanMode = mode === "video" ? "video" : "aicu";

    if (!state.user || !state.csrf) {
      await refreshLogin();
      if (!state.user || !state.csrf) return;
    }

    let filters;
    try {
      const range = utils.parseDateRange(state.settings.startDate, state.settings.endDate);
      filters = {
        uid: state.user.uid,
        keywords: utils.parseKeywords(state.settings.keywords),
        start: range.start,
        end: range.end
      };
    } catch (error) {
      setMessage(error.message, "error");
      return;
    }

    if (scanMode === "video") {
      const parsedVideoInput = utils.parseBiliVideoInput(state.settings.videoList);
      if (!parsedVideoInput.hasLimits) {
        setMessage("请先在“指定视频扫描”里输入 BV、av 或视频 URL。", "warn");
        return;
      }
    }

    clearResults(false);
    state.scan.running = true;
    state.scan.stop = false;
    state.scan.mode = scanMode;
    state.scan.pages = 0;
    state.scan.scanned = 0;
    state.scan.hiddenProcessed = 0;
    await loadProcessedRecords();
    renderAll();
    setMessage(scanMode === "video" ? "正在按指定视频从 AICU 拉取候选..." : "正在从 AICU 拉取全部历史评论索引...", "info");

    try {
      const limits = await resolveVideoLimits(scanMode === "video" ? state.settings.videoList : "");
      const maxPages = state.settings.maxPages;
      const seenKeys = new Set();
      const scanLabel = scanMode === "video" ? "指定视频" : "AICU 全历史";

      for (let page = 1; page <= maxPages; page += 1) {
        if (state.scan.stop) break;
        state.scan.pages = page;
        updateScanProgress(`正在扫描 ${scanLabel} 第 ${page} 页...`);

        const payload = await fetchAicuReplies(state.user.uid, page);
        const replies = extractReplies(payload);
        state.scan.scanned += replies.length;

        for (let index = 0; index < replies.length; index += 1) {
          const item = utils.normalizeAicuReply(replies[index], state.user.uid, `${page}-${index}`);
          if (!item.rpid || !item.oid) continue;
          item.recordKey = makeRecordKey(item);
          if (seenKeys.has(item.recordKey)) continue;
          seenKeys.add(item.recordKey);
          if (!matchesVideoLimits(item, limits)) continue;

          const match = utils.matchesFilters(item, filters);
          if (!match.matches) continue;

          const addResult = addCandidateItem(item, match.reasons);
          if (addResult.hidden) state.scan.hiddenProcessed += 1;
        }

        renderAll();

        if (isAicuEnd(payload, replies)) break;
        await sleep(1200);
      }

      const stopped = state.scan.stop ? "，已手动停止" : "";
      const hiddenText = state.scan.hiddenProcessed ? `，隐藏已处理 ${state.scan.hiddenProcessed} 条` : "";
      setMessage(`${scanLabel}扫描完成${stopped}：读取 ${state.scan.scanned} 条索引，匹配 ${state.items.length} 条${hiddenText}。`, "success");
    } catch (error) {
      setMessage(`扫描失败：${error.message}`, "error");
      addLog("扫描失败", "error", error.message);
    } finally {
      state.scan.running = false;
      state.scan.stop = false;
      renderAll();
    }
  }

  async function resolveVideoLimits(text) {
    const parsed = utils.parseBiliVideoInput(text);
    if (!parsed.hasLimits) return parsed;

    const resolvedAids = new Set(parsed.aids);
    for (const bvid of parsed.bvids) {
      try {
        const url = new URL(BILI_VIEW_API);
        url.searchParams.set("bvid", bvid);
        const payload = await fetchBiliJson(url.toString());
        if (payload.code === 0 && payload.data && payload.data.aid) {
          resolvedAids.add(String(payload.data.aid));
        }
      } catch (error) {
        addLog("视频解析", "warn", `${bvid} 解析 aid 失败：${error.message}`);
      }
    }

    return {
      ...parsed,
      aids: resolvedAids
    };
  }

  async function startDirectVideoScan(options = {}) {
    if (state.scan.running) return;
    collectSettingsFromForm();
    saveSettings();
    const targetPool = options.pool === "manual" ? "manual" : "aicu";
    const rawInputText = typeof options.inputText === "string" ? options.inputText : state.settings.videoList;
    const normalizedVideoInput = utils.normalizeBiliVideoInput(rawInputText);
    const inputText = normalizedVideoInput.text;
    const targetLabel = targetPool === "manual" ? "手动导入预览区" : "扫描预览区";

    if (!state.user || !state.csrf) {
      await refreshLogin();
      if (!state.user || !state.csrf) return;
    }

    let filters;
    try {
      const range = utils.parseDateRange(state.settings.startDate, state.settings.endDate);
      filters = {
        uid: state.user.uid,
        keywords: utils.parseKeywords(state.settings.keywords),
        start: range.start,
        end: range.end
      };
    } catch (error) {
      setMessage(error.message, "error");
      return;
    }

    let videos;
    try {
      if (!inputText) {
        throw new Error("请粘贴 BV 号、av 号或视频链接。");
      }
      videos = await resolveVideoTargets(inputText);
    } catch (error) {
      setMessage(error.message, "error");
      return;
    }

    if (targetPool === "manual") {
      clearManualResults(false);
    } else {
      clearResults(false);
    }
    state.scan.running = true;
    state.scan.stop = false;
    state.scan.mode = targetPool === "manual" ? "manualBiliVideo" : "biliVideo";
    state.scan.pages = 0;
    state.scan.scanned = 0;
    state.scan.hiddenProcessed = 0;
    await loadProcessedRecords();
    renderAll();
    setMessage(`正在直接扫描 ${videos.length} 个视频的评论区，只保留当前 UID ${state.user.uid} 的评论，结果进入${targetLabel}...`, "info");

    const seenKeys = new Set();
    let matched = 0;
    try {
      for (const video of videos) {
        if (state.scan.stop) break;
        matched += await scanBiliVideo(video, filters, seenKeys, targetPool);
      }

      const stopped = state.scan.stop ? "，已手动停止" : "";
      const hiddenText = state.scan.hiddenProcessed ? `，隐藏已处理 ${state.scan.hiddenProcessed} 条` : "";
      setMessage(`指定视频扫描完成${stopped}：读取 ${state.scan.scanned} 条评论，匹配当前账号 ${matched} 条，结果已放入${targetLabel}${hiddenText}。`, "success");
      if (targetPool === "manual") {
        els.importProgress.textContent = `视频直扫完成：读取 ${state.scan.scanned} 条评论，匹配当前账号 ${matched} 条。`;
      }
    } catch (error) {
      setMessage(`指定视频扫描失败：${error.message}`, "error");
      addLog("指定视频扫描失败", "error", error.message);
    } finally {
      state.scan.running = false;
      state.scan.stop = false;
      renderAll();
    }
  }

  async function resolveVideoTargets(text) {
    const parsed = utils.parseBiliVideoInput(text);
    if (!parsed.hasLimits) {
      throw new Error("请粘贴 BV 号、av 号或视频链接。");
    }

    const targets = [];
    const seen = new Set();
    const addTarget = (video) => {
      if (!video || !video.aid) return;
      const aid = String(video.aid);
      if (seen.has(aid)) return;
      seen.add(aid);
      targets.push({
        aid,
        bvid: video.bvid ? String(video.bvid) : "",
        title: video.title || `av${aid}`,
        url: video.bvid ? `https://www.bilibili.com/video/${video.bvid}/` : `https://www.bilibili.com/video/av${aid}/`
      });
    };

    for (const bvid of parsed.bvids) {
      const url = new URL(BILI_VIEW_API);
      url.searchParams.set("bvid", bvid);
      const payload = await fetchBiliJson(url.toString());
      if (payload.code !== 0 || !payload.data || !payload.data.aid) {
        throw new Error(`${bvid} 视频解析失败：${payload.message || payload.msg || payload.code}`);
      }
      addTarget(payload.data);
    }

    for (const aid of parsed.aids) {
      const url = new URL(BILI_VIEW_API);
      url.searchParams.set("aid", aid);
      try {
        const payload = await fetchBiliJson(url.toString());
        if (payload.code === 0 && payload.data && payload.data.aid) {
          addTarget(payload.data);
        } else {
          addTarget({ aid, title: `av${aid}` });
        }
      } catch (error) {
        addLog("视频解析", "warn", `av${aid} 解析标题失败，继续按 aid 扫描：${error.message}`);
        addTarget({ aid, title: `av${aid}` });
      }
    }

    if (targets.length === 0) {
      throw new Error("没有解析到可扫描的视频。");
    }
    return targets;
  }

  async function scanBiliVideo(video, filters, seenKeys, poolName = "aicu") {
    let matched = 0;
    const maxPages = state.settings.maxPages;

    for (let page = 1; page <= maxPages; page += 1) {
      if (state.scan.stop) break;
      state.scan.pages = page;
      updateScanProgress(`正在直扫 ${video.title || `av${video.aid}`} 第 ${page} 页一级评论...`);

      const payload = await fetchBiliReplyPage(video.aid, page);
      if (payload.code !== 0) {
        addLog("视频评论扫描", "warn", `${video.title || video.aid}: ${payload.message || payload.msg || payload.code}`);
        break;
      }

      const roots = extractReplyArray(payload.data);
      state.scan.scanned += roots.length;
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index];
        matched += addBiliReplyCandidate(root, video, "", filters, seenKeys, `p${page}-${index}`, poolName);

        const inlineReplies = Array.isArray(root.replies) ? root.replies : [];
        state.scan.scanned += inlineReplies.length;
        for (let subIndex = 0; subIndex < inlineReplies.length; subIndex += 1) {
          matched += addBiliReplyCandidate(inlineReplies[subIndex], video, String(root.rpid || root.rpid_str || root.id || ""), filters, seenKeys, `p${page}-${index}-${subIndex}`, poolName);
        }

        if (hasSecondReplies(root)) {
          matched += await scanBiliSecondReplies(video, String(root.rpid || root.rpid_str || root.id || ""), filters, seenKeys, poolName);
        }
      }

      renderAll();
      if (isMainReplyEnd(payload.data, roots, page)) break;
      await sleep(650);
    }

    return matched;
  }

  async function scanBiliSecondReplies(video, root, filters, seenKeys, poolName = "aicu") {
    if (!isBiliId(root)) return 0;
    let matched = 0;
    for (let page = 1; page <= MAX_SECOND_REPLY_PAGES; page += 1) {
      if (state.scan.stop) break;
      updateScanProgress(`正在直扫 ${video.title || `av${video.aid}`} 的二级回复 root=${root} 第 ${page} 页...`);
      const payload = await fetchBiliSecondReplyPage(video.aid, root, page);
      if (payload.code !== 0) {
        addLog("二级回复扫描", "warn", `${video.title || video.aid} root=${root}: ${payload.message || payload.msg || payload.code}`);
        break;
      }

      const replies = extractReplyArray(payload.data);
      state.scan.scanned += replies.length;
      for (let index = 0; index < replies.length; index += 1) {
        matched += addBiliReplyCandidate(replies[index], video, root, filters, seenKeys, `root${root}-${page}-${index}`, poolName);
      }

      if (isSecondReplyEnd(payload.data, replies, page)) break;
      await sleep(450);
    }
    return matched;
  }

  function addBiliReplyCandidate(reply, video, fallbackRoot, filters, seenKeys, index, poolName = "aicu") {
    const item = normalizeBiliReply(reply, video, fallbackRoot, index);
    if (!item.rpid || !item.oid) return 0;
    item.recordKey = makeRecordKey(item);
    if (seenKeys.has(item.recordKey)) return 0;
    seenKeys.add(item.recordKey);

    const match = utils.matchesFilters(item, filters);
    if (!match.matches) return 0;

    const addResult = addCandidateItem(item, match.reasons, { pool: poolName });
    if (addResult.hidden) state.scan.hiddenProcessed += 1;
    return addResult.added ? 1 : 0;
  }

  function normalizeBiliReply(reply, video, fallbackRoot, index) {
    const rpid = String(reply && (reply.rpid || reply.rpid_str || reply.id || "") || "");
    const rootValue = String(reply && (reply.root || reply.root_id || reply.rootId || "") || "");
    const root = rootValue && rootValue !== "0" ? rootValue : fallbackRoot || rpid;
    const content = reply && reply.content ? reply.content : {};
    const ctime = Number(reply && reply.ctime) || 0;
    const bvid = video.bvid || "";
    const videoUrl = `${bvid ? `https://www.bilibili.com/video/${bvid}/` : `https://www.bilibili.com/video/av${video.aid}/`}#reply${rpid}`;
    return {
      localId: `bili:${video.aid}:${rpid || index}:${index}`,
      source: "B站直扫",
      ownerMid: String(getReplyMid(reply) || ""),
      oid: String(video.aid || ""),
      bvid,
      rpid,
      root: root && root !== "0" ? root : rpid,
      level: root && root !== "0" && root !== rpid ? "二级回复" : "一级评论",
      message: String(content.message || reply.message || ""),
      ctime,
      timeText: utils.formatTime(ctime),
      videoTitle: video.title || "",
      videoUrl,
      raw: reply
    };
  }

  function hasSecondReplies(reply) {
    if (!reply || typeof reply !== "object") return false;
    if (Array.isArray(reply.replies) && reply.replies.length > 0) return true;
    return Number(reply.rcount || reply.reply_count || reply.count || 0) > 0;
  }

  async function fetchBiliReplyPage(oid, page) {
    const url = new URL(BILI_REPLY_PAGE_API);
    url.searchParams.set("type", "1");
    url.searchParams.set("oid", oid);
    url.searchParams.set("pn", String(page));
    url.searchParams.set("ps", String(REPLY_PAGE_SIZE));
    url.searchParams.set("sort", "0");
    url.searchParams.set("nohot", "1");
    return fetchBiliJson(url.toString());
  }

  async function fetchBiliSecondReplyPage(oid, root, page) {
    const url = new URL(BILI_REPLY_SECOND_API);
    url.searchParams.set("type", "1");
    url.searchParams.set("oid", oid);
    url.searchParams.set("root", root);
    url.searchParams.set("pn", String(page));
    url.searchParams.set("ps", String(SECOND_REPLY_PAGE_SIZE));
    return fetchBiliJson(url.toString());
  }

  function matchesVideoLimits(item, limits) {
    if (!limits || !limits.hasLimits) return true;
    if (item.oid && limits.aids.has(String(item.oid))) return true;
    if (item.bvid && limits.bvids.has(String(item.bvid))) return true;
    return false;
  }

  async function importManualCandidates() {
    if (state.deletion.running || state.scan.running) return;
    const text = els.manualImportText.value.trim();
    if (!text) {
      setMessage("请先粘贴要导入的评论链接、CSV 或 JSON。", "warn");
      return;
    }

    if (!state.user || !state.csrf) {
      await refreshLogin();
      if (!state.user || !state.csrf) return;
    }

    await loadProcessedRecords();
    const videoOnlyInput = utils.parseBiliVideoInput(text);
    if (videoOnlyInput.hasLimits && shouldTreatManualInputAsVideoScan(text)) {
      const normalized = utils.normalizeBiliVideoInput(text);
      if (normalized.text) {
        els.manualImportText.value = normalized.text;
      }
      els.importProgress.textContent = "检测到你粘贴的是视频链接，正在自动直扫并放入手动导入预览区。";
      setMessage("检测到 BV/视频链接，将忽略链接里的评论锚点，自动扫描该视频里当前登录账号发过的评论。", "info");
      await startDirectVideoScan({ pool: "manual", inputText: text });
      return;
    }

    const parsed = utils.parseManualImportText(text);
    if (parsed.items.length === 0 && videoOnlyInput.hasLimits) {
      els.importProgress.textContent = "检测到你粘贴的是视频号，正在自动直扫并放入手动导入预览区。";
      setMessage("检测到 BV/视频链接，将自动扫描该视频里当前登录账号发过的评论，结果放在手动导入预览区。", "info");
      await startDirectVideoScan({ pool: "manual", inputText: text });
      return;
    }

    let added = 0;
    let hidden = 0;
    let duplicate = 0;
    let resolved = 0;
    let resolveFailed = 0;

    els.importProgress.textContent = `正在导入 ${parsed.items.length} 条候选...`;

    for (let index = 0; index < parsed.items.length; index += 1) {
      const item = parsed.items[index];
      item.source = "手动导入";
      if (!item.oid && item.bvid) {
        const ok = await resolveCandidateAid(item);
        if (ok) {
          resolved += 1;
        } else {
          resolveFailed += 1;
        }
      }
      if (!item.oid || !item.rpid) {
        parsed.errors.push(`第 ${index + 1} 条缺少 aid 或 rpid，已跳过`);
        continue;
      }

      const result = addCandidateItem(item, ["手动导入"], { pool: "manual" });
      if (result.added) added += 1;
      if (result.hidden) {
        hidden += 1;
      }
      if (result.duplicate) duplicate += 1;
    }

    for (const error of parsed.errors.slice(0, 20)) {
      addLog("导入提示", "warn", error);
    }

    const suffix = parsed.errors.length > 20 ? `，另有 ${parsed.errors.length - 20} 条提示未显示` : "";
    els.importProgress.textContent = `导入完成：新增 ${added} 条，重复 ${duplicate} 条，隐藏已处理 ${hidden} 条，BV 解析 ${resolved} 条，解析失败 ${resolveFailed} 条${suffix}`;
    setMessage(`手动导入完成，新增 ${added} 条候选。`, added > 0 ? "success" : "warn");
    renderAll();
  }

  function shouldTreatManualInputAsVideoScan(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return false;
    return lines.every((line) => {
      if (!/(?:bilibili\.com\/video\/|^BV[0-9A-Za-z]{8,14}\b|^av\d+\b)/i.test(line)) return false;
      if (!/bilibili\.com\/video\//i.test(line) && looksLikeStructuredCommentImport(line)) return false;
      return true;
    });
  }

  function looksLikeStructuredCommentImport(line) {
    return /(?:^|[^\w])(?:rpid|reply|root|aid|oid)\s*[:=,]/i.test(line)
      || /^\s*\d{2,18}\s*[,，\t ]+\d{2,18}/.test(line);
  }

  async function resolveCandidateAid(item) {
    try {
      const url = new URL(BILI_VIEW_API);
      url.searchParams.set("bvid", item.bvid);
      const payload = await fetchBiliJson(url.toString());
      if (payload.code === 0 && payload.data && payload.data.aid) {
        item.oid = String(payload.data.aid);
        item.videoTitle = item.videoTitle || payload.data.title || "";
        return true;
      }
    } catch (error) {
      addLog("导入解析", "warn", `${item.bvid} 解析 aid 失败：${error.message}`);
    }
    return false;
  }

  function addCandidateItem(item, reasons, options = {}) {
    const poolName = options.pool === "manual" ? "manual" : "aicu";
    const items = poolItems(poolName);
    const selected = poolSelected(poolName);
    item.recordKey = item.recordKey || makeRecordKey(item);
    item.pool = poolName;
    if (items.some((existing) => existing.recordKey === item.recordKey)) {
      return { added: false, hidden: false, duplicate: true };
    }

    prepareQueueItem(item, reasons);
    const record = state.processedRecords[item.recordKey];
    if (record && CLOSED_STATUSES.has(record.status)) {
      applyProcessedRecord(item, record);
      if (!state.settings.showProcessed) {
        return { added: false, hidden: true, duplicate: false };
      }
      items.push(item);
      return { added: true, hidden: false, duplicate: false };
    }

    items.push(item);
    if (options.autoSelect !== false) {
      selected.add(item.localId);
    }
    return { added: true, hidden: false, duplicate: false };
  }

  function poolItems(poolName) {
    return poolName === "manual" ? state.manualItems : state.items;
  }

  function poolSelected(poolName) {
    return poolName === "manual" ? state.manualSelected : state.selected;
  }

  function allItems() {
    return state.items.concat(state.manualItems);
  }

  function prepareQueueItem(item, reasons) {
    item.recordKey = item.recordKey || makeRecordKey(item);
    item.source = item.source || "未知";
    item.status = "pending";
    item.reason = reasons.join("；");
    item.errorCode = "";
    item.errorMessage = "";
    item.verifyCode = "";
    item.verifyMessage = "";
    item.apiCode = "";
    item.apiMessage = "";
    item.processedAt = "";
    item.processedStatus = "";
    item.debug = "";
    item.deletedAt = "";
  }

  function makeRecordKey(item) {
    return `${item.oid}:${item.rpid}`;
  }

  function applyProcessedRecord(item, record) {
    item.status = record.status;
    item.processedStatus = record.status;
    item.processedAt = record.at || "";
    item.deletedAt = record.status === "deleted" ? record.at || "" : "";
    item.apiCode = record.status === "deleted" ? "0" : "";
    item.apiMessage = record.status === "deleted" ? "之前已删除" : "";
    item.errorCode = "";
    item.errorMessage = record.message || "";
    item.debug = record.debug || "";
  }

  async function markProcessedRecord(item, status, message, debug) {
    if (!item || !item.oid || !item.rpid) return;
    item.recordKey = item.recordKey || makeRecordKey(item);
    const at = new Date().toISOString();
    state.processedRecords[item.recordKey] = {
      status,
      at,
      oid: item.oid,
      rpid: item.rpid,
      root: item.root || "",
      level: item.level || "",
      ctime: item.ctime || "",
      timeText: item.timeText || "",
      videoTitle: item.videoTitle || "",
      videoUrl: item.videoUrl || "",
      message: message || "",
      debug: debug || ""
    };
    item.processedStatus = status;
    item.processedAt = at;
    for (const candidate of allItems()) {
      if (candidate.recordKey !== item.recordKey) continue;
      applyProcessedRecord(candidate, state.processedRecords[item.recordKey]);
      poolSelected(candidate.pool).delete(candidate.localId);
    }
    await saveProcessedRecords();
  }

  function statusFromVerificationFailure(verification, item) {
    const code = verification && verification.code ? String(verification.code) : "";
    if (item && item.pool === "manual" && /not_found$/.test(code)) {
      return "skipped";
    }
    if (code === "verify_not_found" || code === "seek_not_found" || code === "seek_-404") {
      return "gone";
    }
    if (code === "owner_mismatch") {
      return "invalid";
    }
    return "skipped";
  }

  async function fetchAicuReplies(uid, page) {
    const url = new URL(AICU_REPLY_API);
    url.searchParams.set("uid", uid);
    url.searchParams.set("pn", String(page));
    url.searchParams.set("ps", "100");
    url.searchParams.set("mode", "0");
    url.searchParams.set("keyword", "");
    return retryAicuFetch(() => fetchAicuJson(url.toString()), page);
  }

  async function retryAicuFetch(fetcher, page) {
    const waits = [0, 3000, 8000];
    let lastError = null;
    for (let attempt = 0; attempt < waits.length; attempt += 1) {
      if (waits[attempt]) {
        updateScanProgress(`AICU 第 ${page} 页请求失败，${Math.round(waits[attempt] / 1000)} 秒后重试...`);
        await sleep(waits[attempt]);
      }
      try {
        return await fetcher();
      } catch (error) {
        lastError = error;
        if (!/468|429|timeout|超时|未返回|failed/i.test(error.message || "")) {
          break;
        }
      }
    }
    throw lastError;
  }

  function extractReplies(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.replies)) return payload.replies;
    if (payload.data) {
      if (Array.isArray(payload.data.replies)) return payload.data.replies;
      if (Array.isArray(payload.data.result)) return payload.data.result;
      if (Array.isArray(payload.data.list)) return payload.data.list;
      if (Array.isArray(payload.data)) return payload.data;
    }
    return [];
  }

  function isAicuEnd(payload, replies) {
    const cursor = payload && payload.data && payload.data.cursor;
    if (cursor && (cursor.is_end === true || cursor.is_end === 1)) return true;
    if (payload && payload.data && payload.data.is_end) return true;
    return replies.length === 0;
  }

  async function startDelete(poolName = "aicu") {
    if (state.deletion.running) return;
    if (!state.user || !state.csrf) {
      await refreshLogin();
      if (!state.user || !state.csrf) return;
    }

    const items = poolItems(poolName);
    const selected = poolSelected(poolName);
    const poolLabel = poolName === "manual" ? "手动导入" : "AICU";
    const queue = items.filter((item) => selected.has(item.localId) && isDeletableStatus(item.status));
    if (queue.length === 0) {
      setMessage(`${poolLabel} 没有可删除的勾选评论。`, "warn");
      return;
    }

    state.deletion.running = true;
    state.deletion.paused = false;
    state.deletion.stop = false;
    state.deletion.pool = poolName;
    setMessage(`开始删除 ${poolLabel} 候选中的 ${queue.length} 条评论。`, "warn");
    renderAll();

    try {
      for (const item of queue) {
        if (state.deletion.stop) break;
        while (state.deletion.paused && !state.deletion.stop) {
          await sleep(300);
        }
        if (state.deletion.stop) break;

        await processDeleteItem(item, poolName);
        renderAll();

        if (state.deletion.stop) break;
        await sleep(state.settings.deleteInterval * 1000);
      }
    } finally {
      const stopped = state.deletion.stop ? "已停止" : "已结束";
      state.deletion.running = false;
      state.deletion.paused = false;
      state.deletion.stop = false;
      setMessage(`删除任务${stopped}。`, "info");
      renderAll();
    }
  }

  async function processDeleteItem(item, poolName = "aicu") {
    const selected = poolSelected(poolName);
    try {
      item.status = utils.nextDeleteState(item.status, "verify");
      renderAll();

      const verification = await verifyItem(item);
      if (!verification.ok) {
        item.status = statusFromVerificationFailure(verification, item);
        item.errorCode = verification.code || "verify_failed";
        item.errorMessage = verification.message;
        item.verifyCode = verification.code || "";
        item.verifyMessage = verification.message || "";
        item.debug = verification.debug || item.debug || "";
        if (CLOSED_STATUSES.has(item.status)) {
          await markProcessedRecord(item, item.status, item.errorMessage, item.debug);
          selected.delete(item.localId);
        }
        addItemLog(item, "skipped", item.errorCode, item.errorMessage);
        return;
      }

      item.status = utils.nextDeleteState("verifying", "pass");
      renderAll();

      const result = await deleteItem(item);
      if (result.ok) {
        item.status = utils.nextDeleteState("deleting", "success");
        item.deletedAt = new Date().toISOString();
        item.errorCode = "";
        item.errorMessage = "";
        item.apiCode = "0";
        item.apiMessage = "删除成功";
        item.debug = result.debug || item.debug || "";
        await markProcessedRecord(item, "deleted", "删除成功", item.debug);
        selected.delete(item.localId);
        addItemLog(item, "deleted", "0", "删除成功");
        return;
      }

      item.status = utils.nextDeleteState("deleting", "fail");
      item.errorCode = String(result.code || "delete_failed");
      item.errorMessage = result.message || "删除失败";
      item.apiCode = String(result.code || "");
      item.apiMessage = result.message || "";
      item.debug = result.debug || item.debug || "";
      addItemLog(item, "failed", item.errorCode, item.errorMessage);

      if (result.fatal) {
        state.deletion.stop = true;
        setMessage(`遇到风控或登录错误，已停止：${item.errorMessage}`, "error");
      }
    } catch (error) {
      item.status = "failed";
      item.errorCode = "exception";
      item.errorMessage = error.message;
      item.debug = error.stack || error.message;
      addItemLog(item, "failed", "exception", error.message);
    }
  }

  async function verifyItem(item) {
    if (!state.settings.strictVerify) {
      return { ok: true, code: "verify_skipped", message: "已关闭严格核验" };
    }

    if (!item.oid || !item.rpid) {
      return { ok: false, code: "missing_id", message: "缺少 aid 或 rpid" };
    }

    const infoResult = await verifyItemViaInfo(item);
    if (infoResult.ok || infoResult.code === "owner_mismatch") {
      return infoResult;
    }

    const roots = Array.from(new Set([item.root, item.rpid].filter(isBiliId)));
    for (const root of roots) {
      try {
        const url = new URL(BILI_REPLY_DETAIL_API);
        url.searchParams.set("type", "1");
        url.searchParams.set("oid", item.oid);
        url.searchParams.set("root", root);
        const payload = await fetchBiliJson(url.toString());
        if (payload.code !== 0) {
          item.verifyCode = String(payload.code);
          item.verifyMessage = payload.message || payload.msg || "核验接口返回失败";
          item.debug = summarizePayload("reply/detail", payload);
          continue;
        }

        const found = findReplyByRpid(payload.data, item.rpid);
        if (!found) continue;

        applyVerifiedReply(item, found);
        const mid = getReplyMid(found);
        if (mid && String(mid) === String(state.user.uid)) {
          return { ok: true, code: "verified", message: "评论归属已核验" };
        }

        return {
          ok: false,
          code: "owner_mismatch",
          message: `B站返回的评论作者 UID 为 ${mid || "未知"}，不是当前账号`,
          debug: summarizePayload("reply/detail", { code: 0, foundMid: mid, expectedMid: state.user.uid })
        };
      } catch (error) {
        addLog("核验失败", "warn", `${item.rpid}: ${error.message}`);
        item.debug = error.stack || error.message;
      }
    }

    const seekResult = await verifyItemViaSeek(item);
    if (seekResult.ok || seekResult.code === "owner_mismatch") {
      return seekResult;
    }

    const fallbackRoots = Array.from(new Set([
      seekResult.root,
      item.root
    ].filter((root) => isBiliId(root) && String(root) !== String(item.rpid))));
    for (const root of fallbackRoots) {
      const secondResult = await verifySecondLevelByRoot(item, root);
      if (secondResult.ok || secondResult.code === "owner_mismatch") {
        return secondResult;
      }
    }

    return {
      ok: false,
      code: "verify_not_found",
      message: "B站未返回该评论，可能已删除、评论区不可见或 AICU 索引过期",
      debug: seekResult.debug || item.debug || `reply/detail/reply/main 未找到 rpid=${item.rpid}, oid=${item.oid}, root=${item.root}`
    };
  }

  async function verifyItemViaInfo(item) {
    try {
      const url = new URL(BILI_REPLY_INFO_API);
      url.searchParams.set("type", "1");
      url.searchParams.set("oid", item.oid);
      url.searchParams.set("rpid", item.rpid);

      const payload = await fetchBiliJson(url.toString());
      if (payload.code !== 0) {
        return {
          ok: false,
          code: `info_${payload.code}`,
          message: payload.message || payload.msg || "reply/info 核验失败",
          debug: summarizePayload("reply/info", payload)
        };
      }

      const found = findReplyByRpid(payload.data, item.rpid);
      if (!found) {
        return {
          ok: false,
          code: "info_not_found",
          message: "reply/info 未找到该评论",
          debug: summarizePayload("reply/info", payload)
        };
      }

      applyVerifiedReply(item, found);
      const mid = getReplyMid(found);
      if (mid && String(mid) === String(state.user.uid)) {
        return {
          ok: true,
          code: "verified_info",
          message: "评论归属已通过 reply/info 核验",
          debug: summarizePayload("reply/info", { code: 0, foundMid: mid, expectedMid: state.user.uid, root: item.root })
        };
      }

      return {
        ok: false,
        code: "owner_mismatch",
        message: `B站返回的评论作者 UID 为 ${mid || "未知"}，不是当前账号`,
        debug: summarizePayload("reply/info", { code: 0, foundMid: mid, expectedMid: state.user.uid, root: item.root })
      };
    } catch (error) {
      return {
        ok: false,
        code: "info_exception",
        message: error.message,
        debug: error.stack || error.message
      };
    }
  }

  async function verifyItemViaSeek(item) {
    try {
      const url = new URL(BILI_REPLY_MAIN_API);
      url.searchParams.set("type", "1");
      url.searchParams.set("oid", item.oid);
      url.searchParams.set("mode", "3");
      url.searchParams.set("ps", "20");
      url.searchParams.set("next", "0");
      url.searchParams.set("seek_rpid", item.rpid);

      const payload = await fetchBiliJson(url.toString());
      if (payload.code !== 0) {
        return {
          ok: false,
          code: `seek_${payload.code}`,
          message: payload.message || payload.msg || "seek_rpid 核验失败",
          debug: summarizePayload("reply/main", payload)
        };
      }

      const found = findReplyByRpid(payload.data, item.rpid);
      if (!found) {
        const root = inferRootFromSeekPayload(payload.data, item.rpid);
        return {
          ok: false,
          code: "seek_not_found",
          message: "seek_rpid 未找到该评论",
          root,
          debug: summarizePayload("reply/main", payload)
        };
      }

      applyVerifiedReply(item, found);
      const mid = getReplyMid(found);
      if (mid && String(mid) === String(state.user.uid)) {
        return {
          ok: true,
          code: "verified_seek",
          message: "评论归属已通过 seek_rpid 核验",
          debug: summarizePayload("reply/main", { code: 0, foundMid: mid, expectedMid: state.user.uid })
        };
      }

      return {
        ok: false,
        code: "owner_mismatch",
        message: `B站返回的评论作者 UID 为 ${mid || "未知"}，不是当前账号`,
        debug: summarizePayload("reply/main", { code: 0, foundMid: mid, expectedMid: state.user.uid })
      };
    } catch (error) {
      return {
        ok: false,
        code: "seek_exception",
        message: error.message,
        debug: error.stack || error.message
      };
    }
  }

  function isBiliId(value) {
    return typeof value === "string" && /^\d+$/.test(value);
  }

  function findReplyByRpid(data, rpid) {
    const target = String(rpid);
    const stack = [data];
    const seen = new Set();

    while (stack.length > 0) {
      const item = stack.shift();
      if (!item) continue;
      if (typeof item !== "object") continue;

      if (seen.has(item)) continue;
      seen.add(item);

      if (Array.isArray(item)) {
        stack.push(...item);
        continue;
      }

      if (isReplyObject(item) && String(item.rpid || item.rpid_str || item.id || "") === target) {
        return item;
      }

      for (const key of ["root", "replies", "top_replies", "hots", "upper", "reply", "children"]) {
        const value = item[key];
        if (value && typeof value === "object") stack.push(value);
      }
    }

    return null;
  }

  function isReplyObject(value) {
    return Boolean(value && typeof value === "object" && (
      value.rpid ||
      value.rpid_str ||
      ((value.member || value.content) && value.id)
    ));
  }

  function getReplyMid(reply) {
    return reply && (reply.mid || reply.uid || (reply.member && (reply.member.mid || reply.member.uid)));
  }

  function applyVerifiedReply(item, reply, fallbackRoot = "") {
    if (!reply) return;
    const rpid = String(reply.rpid || reply.rpid_str || reply.id || item.rpid || "");
    const replyRoot = String(reply.root || reply.root_id || reply.rootId || "");
    const root = replyRoot && replyRoot !== "0" ? replyRoot : fallbackRoot || rpid;
    if (root && isBiliId(root)) {
      item.root = root;
      item.level = root !== String(item.rpid) ? "二级回复" : "一级评论";
    }
    if (!item.message && reply.content && reply.content.message) {
      item.message = reply.content.message;
    }
    if (!item.ctime && reply.ctime) {
      item.ctime = Number(reply.ctime) || 0;
      item.timeText = utils.formatTime(item.ctime);
    }
  }

  function inferRootFromSeekPayload(data, targetRpid) {
    const target = String(targetRpid);
    const replies = [];
    if (data && data.root && typeof data.root === "object") replies.push(data.root);
    if (data && Array.isArray(data.replies)) replies.push(...data.replies);
    if (data && Array.isArray(data.top_replies)) replies.push(...data.top_replies);

    for (const reply of replies) {
      const rpid = String(reply && (reply.rpid || reply.rpid_str || reply.id || "") || "");
      const root = String(reply && (reply.root || reply.root_id || reply.rootId || "") || "");
      if (root && root !== "0" && isBiliId(root)) return root;
      if (rpid && rpid !== target && isBiliId(rpid)) return rpid;
    }
    return "";
  }

  function extractReplyArray(data) {
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data.replies)) return data.replies;
    if (data.root && Array.isArray(data.root.replies)) return data.root.replies;
    return [];
  }

  function isSecondReplyEnd(data, replies, page) {
    if (!Array.isArray(replies) || replies.length < SECOND_REPLY_PAGE_SIZE) return true;
    const count = Number(data && data.page && data.page.count);
    if (Number.isFinite(count) && count > 0 && page * SECOND_REPLY_PAGE_SIZE >= count) return true;
    const num = Number(data && data.page && data.page.num);
    const size = Number(data && data.page && data.page.size);
    if (Number.isFinite(count) && Number.isFinite(num) && Number.isFinite(size) && num * size >= count) return true;
    return false;
  }

  function isMainReplyEnd(data, replies, page) {
    if (!Array.isArray(replies) || replies.length < REPLY_PAGE_SIZE) return true;
    const count = Number(data && data.page && data.page.count);
    if (Number.isFinite(count) && count > 0 && page * REPLY_PAGE_SIZE >= count) return true;
    return false;
  }

  async function deleteItem(item) {
    const body = new URLSearchParams();
    body.set("type", "1");
    body.set("oid", item.oid);
    body.set("rpid", item.rpid);
    body.set("csrf", state.csrf);
    body.set("csrf_token", state.csrf);

    const payload = await fetchBiliJson(BILI_REPLY_DELETE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (payload.code === 0) {
      return {
        ok: true,
        debug: summarizePayload("reply/del", payload)
      };
    }

    return {
      ok: false,
      fatal: FATAL_CODES.has(Number(payload.code)),
      code: payload.code,
      message: payload.message || payload.msg || "删除失败",
      debug: summarizePayload("reply/del", payload)
    };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      credentials: options.credentials || "omit"
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  async function fetchAicuJson(url, options = {}) {
    const request = {
      url,
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body || null
    };

    try {
      return await fetchJson(url, {
        ...options,
        credentials: "omit"
      });
    } catch (directError) {
      const directMessage = directError.message || String(directError);
      try {
        let workerTab = null;
        try {
          workerTab = await ensureAicuWorkerTab();
          const value = await executeFetchInTab(workerTab.id, request);
          if (value && value.ok && value.json) {
            return value.json;
          }

          const workerMessage = value
            ? `工作页 HTTP ${value.status || "unknown"} ${value.error || ""}`.trim()
            : "工作页未返回结果";
          try {
            return await fetchJsonViaApiTab(url);
          } catch (fallbackError) {
            throw new Error(`直连失败：${directMessage}；${workerMessage}；API 页签失败：${fallbackError.message}`);
          }
        } finally {
          if (workerTab && workerTab.created && workerTab.id) {
            closeTabQuietly(workerTab.id);
          }
        }
      } catch (workerError) {
        if (/直连失败：/.test(workerError.message || "")) {
          throw workerError;
        }
        try {
          return await fetchJsonViaApiTab(url);
        } catch (fallbackError) {
          throw new Error(`直连失败：${directMessage}；工作页失败：${workerError.message}；API 页签失败：${fallbackError.message}`);
        }
      }
    }
  }

  async function verifySecondLevelByRoot(item, root) {
    let lastDebug = "";
    for (let page = 1; page <= MAX_SECOND_REPLY_PAGES; page += 1) {
      try {
        const url = new URL(BILI_REPLY_SECOND_API);
        url.searchParams.set("type", "1");
        url.searchParams.set("oid", item.oid);
        url.searchParams.set("root", root);
        url.searchParams.set("pn", String(page));
        url.searchParams.set("ps", String(SECOND_REPLY_PAGE_SIZE));

        const payload = await fetchBiliJson(url.toString());
        lastDebug = summarizePayload("reply/reply", payload);
        if (payload.code !== 0) {
          return {
            ok: false,
            code: `second_${payload.code}`,
            message: payload.message || payload.msg || "二级回复核验失败",
            debug: lastDebug
          };
        }

        const found = findReplyByRpid(payload.data, item.rpid);
        if (found) {
          applyVerifiedReply(item, found, root);
          const mid = getReplyMid(found);
          if (mid && String(mid) === String(state.user.uid)) {
            return {
              ok: true,
              code: "verified_second",
              message: "二级回复归属已核验",
              debug: summarizePayload("reply/reply", { code: 0, foundMid: mid, expectedMid: state.user.uid, root })
            };
          }
          return {
            ok: false,
            code: "owner_mismatch",
            message: `B站返回的评论作者 UID 为 ${mid || "未知"}，不是当前账号`,
            debug: summarizePayload("reply/reply", { code: 0, foundMid: mid, expectedMid: state.user.uid, root })
          };
        }

        const replies = extractReplyArray(payload.data);
        if (isSecondReplyEnd(payload.data, replies, page)) break;
      } catch (error) {
        return {
          ok: false,
          code: "second_exception",
          message: error.message,
          debug: error.stack || error.message
        };
      }
    }

    return {
      ok: false,
      code: "second_not_found",
      message: "已找到父评论，但未在二级回复分页中找到目标 rpid",
      debug: lastDebug || `reply/reply 未找到 rpid=${item.rpid}, oid=${item.oid}, root=${root}`
    };
  }

  async function fetchBiliJson(url, options = {}) {
    const request = {
      url,
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body || null
    };
    const tabId = await ensureBiliWorkerTab();
    const value = await executeFetchInTab(tabId, request);
    if (!value) {
      throw new Error("B站工作页未返回结果");
    }
    if (!value.ok && !value.json) {
      throw new Error(`B站请求失败：HTTP ${value.status || "unknown"} ${value.error || ""}`.trim());
    }
    if (!value.json) {
      throw new Error(`B站请求没有 JSON 响应：HTTP ${value.status || "unknown"}`);
    }
    return value.json;
  }

  async function executeFetchInTab(tabId, request) {
    const run = async (world) => {
      const details = {
        target: { tabId },
        args: [request],
        func: async (req) => {
          try {
            const response = await fetch(req.url, {
              method: req.method,
              credentials: "include",
              headers: req.headers,
              body: req.body
            });
            const text = await response.text();
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch (error) {
              return {
                ok: false,
                status: response.status,
                error: `JSON 解析失败：${error.message}`,
                text: text.slice(0, 1000)
              };
            }
            return {
              ok: response.ok,
              status: response.status,
              json,
              text: response.ok ? "" : text.slice(0, 1000)
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              error: error && error.message ? error.message : String(error)
            };
          }
        }
      };
      if (world) details.world = world;
      const [result] = await chrome.scripting.executeScript(details);
      return result && result.result;
    };

    let mainError = null;
    try {
      const value = await run("MAIN");
      if (value) return value;
    } catch (error) {
      mainError = error;
    }

    try {
      const value = await run();
      if (value) return value;
    } catch (error) {
      if (mainError) {
        throw new Error(`MAIN 注入失败：${mainError.message}；ISOLATED 注入失败：${error.message}`);
      }
      throw error;
    }

    if (mainError) {
      throw new Error(`MAIN 注入失败：${mainError.message}；ISOLATED 未返回结果`);
    }
    return null;
  }

  async function fetchJsonViaApiTab(url) {
    const tab = await ensureApiTab(url);
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const text = document.body ? document.body.innerText : document.documentElement.innerText;
          return {
            text: text || "",
            title: document.title || "",
            href: location.href
          };
        }
      });
      const value = result && result.result;
      if (!value || !value.text) {
        throw new Error("API 页签没有可读取文本");
      }
      try {
        return JSON.parse(value.text);
      } catch (error) {
        throw new Error(`API 页签 JSON 解析失败：${error.message}；title=${value.title || ""}`);
      }
    } finally {
      if (tab.created && tab.id) {
        closeTabQuietly(tab.id);
      }
    }
  }

  async function ensureBiliWorkerTab() {
    const tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/*" });
    const existing = tabs.find((tab) => tab.id && !tab.discarded);
    if (existing && existing.id) {
      await waitForTabComplete(existing.id);
      return existing.id;
    }

    const tab = await chrome.tabs.create({ url: BILI_WORKER_URL, active: false });
    if (!tab.id) {
      throw new Error("无法创建 B站工作标签页");
    }
    await waitForTabComplete(tab.id);
    return tab.id;
  }

  async function ensureAicuWorkerTab() {
    const tabs = await chrome.tabs.query({ url: "https://www.aicu.cc/*" });
    const existing = tabs.find((tab) => tab.id && !tab.discarded);
    if (existing && existing.id) {
      await waitForTabComplete(existing.id);
      return { id: existing.id, created: false };
    }

    const tab = await chrome.tabs.create({ url: AICU_WORKER_URL, active: false });
    if (!tab.id) {
      throw new Error("无法创建 AICU 工作标签页");
    }
    await waitForTabComplete(tab.id);
    return { id: tab.id, created: true };
  }

  async function ensureApiTab(url) {
    const tabs = await chrome.tabs.query({ url: "https://api.aicu.cc/*" });
    const existing = tabs.find((tab) => tab.id && !tab.discarded);
    if (existing && existing.id) {
      await chrome.tabs.update(existing.id, { url, active: false });
      await waitForTabComplete(existing.id, "AICU API 页签加载超时");
      return { id: existing.id, created: false };
    }

    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab.id) {
      throw new Error("无法创建 AICU API 页签");
    }
    await waitForTabComplete(tab.id, "AICU API 页签加载超时");
    return { id: tab.id, created: true };
  }

  function closeTabQuietly(tabId) {
    chrome.tabs.remove(tabId).catch(() => {});
  }

  function waitForTabComplete(tabId, timeoutMessage = "工作标签页加载超时") {
    return new Promise((resolve, reject) => {
      let finished = false;
      let timeout = null;

      const cleanup = () => {
        if (timeout) window.clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          finish();
        }
      };

      timeout = window.setTimeout(() => fail(new Error(timeoutMessage)), 20000);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete") finish();
      }).catch(fail);
    });
  }

  function summarizePayload(label, payload) {
    const data = payload && payload.data;
    const replies = data && Array.isArray(data.replies) ? data.replies : [];
    const root = data && data.root && typeof data.root === "object" ? data.root : null;
    return JSON.stringify({
      label,
      code: payload && payload.code,
      message: payload && (payload.message || payload.msg),
      ttl: payload && payload.ttl,
      dataKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 20) : [],
      rootRpid: root && (root.rpid || root.rpid_str || root.id),
      replyCount: replies.length,
      replyRpids: replies.slice(0, 8).map((reply) => reply && (reply.rpid || reply.rpid_str || reply.id)).filter(Boolean),
      page: data && data.page ? data.page : undefined
    });
  }

  function togglePauseDelete() {
    if (!state.deletion.running) return;
    state.deletion.paused = !state.deletion.paused;
    setMessage(state.deletion.paused ? "删除任务已暂停。" : "删除任务已继续。", "info");
    renderAll();
  }

  function stopDelete() {
    if (!state.deletion.running) return;
    state.deletion.stop = true;
    state.deletion.paused = false;
    setMessage("正在停止删除任务，当前请求结束后会停下。", "warn");
    renderAll();
  }

  function clearResults(showMessage = true) {
    state.items = [];
    state.selected.clear();
    state.scan.scanned = 0;
    state.scan.pages = 0;
    state.scan.hiddenProcessed = 0;
    if (showMessage) setMessage("扫描结果已清空。", "info");
    renderAll();
  }

  function clearManualResults(showMessage = true) {
    state.manualItems = [];
    state.manualSelected.clear();
    if (els.importProgress) {
      els.importProgress.textContent = "手动导入结果已清空";
    }
    if (showMessage) setMessage("手动导入结果已清空。", "info");
    renderAll();
  }

  function selectAllPending(poolName = "aicu") {
    const selected = poolSelected(poolName);
    for (const item of poolItems(poolName)) {
      if (isDeletableStatus(item.status)) selected.add(item.localId);
    }
    renderAll();
  }

  function invertSelection(poolName = "aicu") {
    const selected = poolSelected(poolName);
    for (const item of poolItems(poolName)) {
      if (!isDeletableStatus(item.status)) continue;
      if (selected.has(item.localId)) {
        selected.delete(item.localId);
      } else {
        selected.add(item.localId);
      }
    }
    renderAll();
  }

  function isDeletableStatus(status) {
    return !CLOSED_STATUSES.has(status) && status !== "verifying" && status !== "deleting";
  }

  async function clearProcessedRecords() {
    if (!state.user || !state.user.uid) {
      setMessage("请先刷新登录态，再清除已处理记录。", "warn");
      return;
    }
    const total = Object.keys(state.processedRecords).length;
    if (total > 0 && !window.confirm(`确定清除当前 UID 的 ${total} 条已处理记录吗？清除后下次扫描会重新显示它们。`)) {
      return;
    }
    state.processedRecords = {};
    state.scan.hiddenProcessed = 0;
    if (chrome.storage) {
      await chrome.storage.local.remove(processedStorageKey());
    }
    setMessage("已处理记录已清除。", "success");
    renderAll();
  }

  function addItemLog(item, status, code, message) {
    state.logs.unshift({
      at: new Date().toISOString(),
      status,
      code,
      message,
      rpid: item.rpid,
      root: item.root,
      oid: item.oid,
      level: item.level,
      pool: item.pool || "",
      debug: item.debug || ""
    });
    renderLogs();
  }

  function addLog(title, level, message) {
    state.logs.unshift({
      at: new Date().toISOString(),
      status: level,
      code: title,
      message
    });
    renderLogs();
  }

  function exportCsv() {
    const rows = buildExportRows();
    const headers = [
      "status", "pool", "source", "errorCode", "errorMessage", "uid", "oid", "bvid", "videoTitle",
      "videoUrl", "level", "rpid", "root", "ctime", "timeText", "message",
      "reason", "verifyCode", "verifyMessage", "apiCode", "apiMessage", "processedStatus", "processedAt", "debug", "deletedAt"
    ];
    const csv = utils.buildCsv(headers, rows);
    downloadBlob(csv, `bili-comment-cleaner-${dateStamp()}.csv`, "text/csv;charset=utf-8");
  }

  function exportJson() {
    downloadBlob(JSON.stringify(buildDiagnosticPayload(), null, 2), `bili-comment-cleaner-${dateStamp()}.json`, "application/json;charset=utf-8");
  }

  async function copyDebugLog() {
    const text = JSON.stringify(buildDiagnosticPayload(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setMessage("诊断日志已复制。", "success");
    } catch (error) {
      setMessage(`复制失败：${error.message}。可以改用“导出 JSON”。`, "error");
    }
  }

  function buildDiagnosticPayload() {
    return {
      exportedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      uid: state.user && state.user.uid,
      uname: state.user && state.user.uname,
      settings: {
        keywords: state.settings.keywords,
        startDate: state.settings.startDate,
        endDate: state.settings.endDate,
        deleteInterval: state.settings.deleteInterval,
        maxPages: state.settings.maxPages,
        strictVerify: state.settings.strictVerify,
        showProcessed: state.settings.showProcessed,
        lastScanMode: state.scan.mode,
        hasVideoList: Boolean(state.settings.videoList)
      },
      items: buildExportRows(),
      pools: {
        aicu: {
          items: state.items.length,
          selected: state.selected.size
        },
        manual: {
          items: state.manualItems.length,
          selected: state.manualSelected.size
        }
      },
      logs: state.logs
    };
  }

  function buildExportRows() {
    return allItems().map((item) => ({
      status: item.status || "",
      pool: item.pool || "",
      source: item.source || "",
      errorCode: item.errorCode || "",
      errorMessage: item.errorMessage || "",
      uid: item.ownerMid || "",
      oid: item.oid || "",
      bvid: item.bvid || "",
      videoTitle: item.videoTitle || "",
      videoUrl: item.videoUrl || "",
      level: item.level || "",
      rpid: item.rpid || "",
      root: item.root || "",
      ctime: item.ctime || "",
      timeText: item.timeText || "",
      message: item.message || "",
      reason: item.reason || "",
      verifyCode: item.verifyCode || "",
      verifyMessage: item.verifyMessage || "",
      apiCode: item.apiCode || "",
      apiMessage: item.apiMessage || "",
      processedStatus: item.processedStatus || "",
      processedAt: item.processedAt || "",
      debug: item.debug || "",
      deletedAt: item.deletedAt || ""
    }));
  }

  function downloadBlob(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function dateStamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  function renderAll() {
    renderButtons();
    renderMetrics();
    renderTable();
    renderLogs();
    updateScanProgress();
  }

  function renderButtons() {
    const deletingAicu = state.deletion.running && state.deletion.pool === "aicu";
    const deletingManual = state.deletion.running && state.deletion.pool === "manual";
    els.startScan.disabled = state.scan.running || state.deletion.running;
    els.startVideoScan.disabled = state.scan.running || state.deletion.running;
    els.stopScan.disabled = !state.scan.running;
    els.importManual.disabled = state.scan.running || state.deletion.running;
    els.clearManualInput.disabled = state.scan.running || state.deletion.running;
    els.manualClearResults.disabled = state.scan.running || state.deletion.running;
    els.clearProcessed.disabled = state.scan.running || state.deletion.running || !state.user;
    els.startDelete.disabled = state.deletion.running || selectedDeletableCount("aicu") === 0;
    els.pauseDelete.disabled = !deletingAicu;
    els.pauseDelete.textContent = state.deletion.paused ? "继续" : "暂停";
    els.stopDelete.disabled = !deletingAicu;
    els.manualStartDelete.disabled = state.deletion.running || selectedDeletableCount("manual") === 0;
    els.manualPauseDelete.disabled = !deletingManual;
    els.manualPauseDelete.textContent = state.deletion.paused ? "继续" : "暂停";
    els.manualStopDelete.disabled = !deletingManual;
    els.exportCsv.disabled = allItems().length === 0;
    els.exportJson.disabled = allItems().length === 0;
    els.copyDebug.disabled = allItems().length === 0 && state.logs.length === 0;
  }

  function renderMetrics() {
    const deleted = state.items.filter((item) => item.status === "deleted").length;
    const failed = state.items.filter((item) => item.status === "failed" || item.status === "skipped" || item.status === "gone" || item.status === "invalid").length;
    els.metricCandidates.textContent = state.items.length;
    els.metricSelected.textContent = state.selected.size;
    els.metricDeleted.textContent = deleted;
    els.metricFailed.textContent = failed;
    els.metricHidden.textContent = state.scan.hiddenProcessed;

    const manualDeleted = state.manualItems.filter((item) => item.status === "deleted").length;
    const manualFailed = state.manualItems.filter((item) => item.status === "failed" || item.status === "skipped" || item.status === "gone" || item.status === "invalid").length;
    els.manualMetricCandidates.textContent = state.manualItems.length;
    els.manualMetricSelected.textContent = state.manualSelected.size;
    els.manualMetricDeleted.textContent = manualDeleted;
    els.manualMetricFailed.textContent = manualFailed;
  }

  function renderTable() {
    renderCandidateTable("aicu");
    renderCandidateTable("manual");
  }

  function renderCandidateTable(poolName) {
    const items = poolItems(poolName);
    const body = poolName === "manual" ? els.manualPreviewBody : els.previewBody;
    const hint = poolName === "manual" ? els.manualRenderHint : els.renderHint;
    const emptyText = poolName === "manual" ? "等待手动导入结果" : "等待 AICU 扫描结果";

    body.textContent = "";
    if (items.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 9;
      cell.className = "empty";
      cell.textContent = emptyText;
      row.appendChild(cell);
      body.appendChild(row);
      hint.textContent = "";
      return;
    }

    const visible = items.slice(0, MAX_RENDER_ROWS);
    for (const item of visible) {
      body.appendChild(renderRow(item, poolName));
    }

    hint.textContent = items.length > MAX_RENDER_ROWS
      ? `当前仅渲染前 ${MAX_RENDER_ROWS} 条，导出仍包含全部 ${items.length} 条。`
      : "";
  }

  function renderRow(item, poolName = "aicu") {
    const row = document.createElement("tr");
    row.dataset.status = item.status || "pending";
    const selected = poolSelected(poolName);

    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(item.localId);
    checkbox.disabled = !isDeletableStatus(item.status) || state.deletion.running;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selected.add(item.localId);
      } else {
        selected.delete(item.localId);
      }
      renderButtons();
      renderMetrics();
    });
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);

    appendTextCell(row, statusText(item.status), `badge ${item.status || "pending"}`);
    appendTextCell(row, item.source || "-");
    appendTextCell(row, item.timeText || "-");

    const videoCell = document.createElement("td");
    const link = document.createElement("a");
    link.href = item.videoUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.videoTitle || (item.bvid || `av${item.oid}`);
    videoCell.appendChild(link);
    row.appendChild(videoCell);

    appendTextCell(row, item.level || "-");
    appendTextCell(row, `${item.rpid || "-"} / ${item.root || "-"}`, "mono");
    appendTextCell(row, item.message || "", "comment-cell");
    appendTextCell(row, item.errorMessage ? `${item.reason || ""}；${item.errorMessage}` : item.reason || "-");
    return row;
  }

  function appendTextCell(row, text, className) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = text;
    row.appendChild(cell);
  }

  function statusText(status) {
    return {
      pending: "待处理",
      verifying: "核验中",
      deleting: "删除中",
      deleted: "已删除",
      failed: "失败",
      skipped: "已跳过",
      gone: "已不存在",
      invalid: "非当前账号"
    }[status] || "待处理";
  }

  function renderLogs() {
    if (state.logs.length === 0) {
      els.logList.textContent = "暂无日志";
      return;
    }

    els.logList.textContent = "";
    for (const log of state.logs.slice(0, 80)) {
      const item = document.createElement("div");
      item.className = `log-item ${log.status || "info"}`;
      item.textContent = `[${new Date(log.at).toLocaleString()}] ${log.code || log.status}: ${log.message || ""}`;
      els.logList.appendChild(item);
    }
  }

  function selectedDeletableCount(poolName = "aicu") {
    const selected = poolSelected(poolName);
    return poolItems(poolName).filter((item) => selected.has(item.localId) && isDeletableStatus(item.status)).length;
  }

  function updateLoginChip(text, kind) {
    els.loginStatus.textContent = text;
    els.loginStatus.className = `status-chip ${kind}`;
  }

  function updateScanProgress(text) {
    if (text) {
      els.scanProgress.textContent = text;
      return;
    }
    if (state.scan.running) {
      els.scanProgress.textContent = `第 ${state.scan.pages || 1} 页，已读取 ${state.scan.scanned} 条`;
      return;
    }
    els.scanProgress.textContent = state.scan.scanned
      ? `上次读取 ${state.scan.scanned} 条索引`
      : "尚未扫描";
  }

  function setMessage(text, type) {
    els.message.textContent = text || "";
    els.message.className = `message ${type || "info"}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
