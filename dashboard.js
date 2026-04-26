(() => {
  "use strict";

  const utils = window.BiliCleanerUtils;
  const AICU_REPLY_API = "https://api.aicu.cc/api/v3/search/getreply";
  const AICU_WORKER_URL = "https://www.aicu.cc/";
  const AICU_API_ORIGIN = "https://api.aicu.cc/";
  const BILI_NAV_API = "https://api.bilibili.com/x/web-interface/nav";
  const BILI_VIEW_API = "https://api.bilibili.com/x/web-interface/view";
  const BILI_REPLY_DETAIL_API = "https://api.bilibili.com/x/v2/reply/detail";
  const BILI_REPLY_MAIN_API = "https://api.bilibili.com/x/v2/reply/main";
  const BILI_REPLY_DELETE_API = "https://api.bilibili.com/x/v2/reply/del";
  const BILI_WORKER_URL = "https://www.bilibili.com/";
  const SETTINGS_KEY = "biliCleanerSettings";
  const PROCESSED_KEY_PREFIX = "biliCleanerProcessed:";
  const MAX_RENDER_ROWS = 500;
  const MAX_PROCESSED_RECORDS = 50000;
  const FATAL_CODES = new Set([-101, -111, -509]);
  const CLOSED_STATUSES = new Set(["deleted", "gone", "invalid"]);

  const state = {
    user: null,
    csrf: "",
    items: [],
    logs: [],
    selected: new Set(),
    processedRecords: {},
    scan: {
      running: false,
      stop: false,
      pages: 0,
      scanned: 0,
      hiddenProcessed: 0
    },
    deletion: {
      running: false,
      paused: false,
      stop: false
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
      "maxPages", "strictVerify", "showProcessed", "videoList", "startScan", "stopScan", "clearResults", "clearProcessed",
      "scanProgress", "metricCandidates", "metricSelected", "metricDeleted", "metricFailed", "metricHidden",
      "selectAll", "invertSelection", "startDelete", "pauseDelete", "stopDelete",
      "previewBody", "message", "renderHint", "exportCsv", "exportJson", "copyDebug", "logList"
    ]) {
      els[id] = document.getElementById(id);
    }
  }

  function bindEvents() {
    els.refreshLogin.addEventListener("click", refreshLogin);
    els.startScan.addEventListener("click", startScan);
    els.stopScan.addEventListener("click", () => {
      state.scan.stop = true;
      setMessage("正在停止扫描，当前请求结束后会停下。", "warn");
    });
    els.clearResults.addEventListener("click", clearResults);
    els.clearProcessed.addEventListener("click", clearProcessedRecords);
    els.selectAll.addEventListener("click", selectAllPending);
    els.invertSelection.addEventListener("click", invertSelection);
    els.startDelete.addEventListener("click", startDelete);
    els.pauseDelete.addEventListener("click", togglePauseDelete);
    els.stopDelete.addEventListener("click", stopDelete);
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

  async function startScan() {
    if (state.scan.running) return;
    collectSettingsFromForm();
    saveSettings();

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

    clearResults(false);
    state.scan.running = true;
    state.scan.stop = false;
    state.scan.pages = 0;
    state.scan.scanned = 0;
    state.scan.hiddenProcessed = 0;
    await loadProcessedRecords();
    renderAll();
    setMessage("正在从 AICU 拉取历史评论索引...", "info");

    try {
      const limits = await resolveVideoLimits(state.settings.videoList);
      const maxPages = state.settings.maxPages;
      const seenKeys = new Set();

      for (let page = 1; page <= maxPages; page += 1) {
        if (state.scan.stop) break;
        state.scan.pages = page;
        updateScanProgress(`正在扫描 AICU 第 ${page} 页...`);

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

          prepareQueueItem(item, match.reasons);
          const record = state.processedRecords[item.recordKey];
          if (record && CLOSED_STATUSES.has(record.status)) {
            applyProcessedRecord(item, record);
            if (!state.settings.showProcessed) {
              state.scan.hiddenProcessed += 1;
              continue;
            }
            state.items.push(item);
            continue;
          }

          state.items.push(item);
          state.selected.add(item.localId);
        }

        renderAll();

        if (isAicuEnd(payload, replies)) break;
        await sleep(1200);
      }

      const stopped = state.scan.stop ? "，已手动停止" : "";
      const hiddenText = state.scan.hiddenProcessed ? `，隐藏已处理 ${state.scan.hiddenProcessed} 条` : "";
      setMessage(`扫描完成${stopped}：读取 ${state.scan.scanned} 条索引，匹配 ${state.items.length} 条${hiddenText}。`, "success");
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

  function matchesVideoLimits(item, limits) {
    if (!limits || !limits.hasLimits) return true;
    if (item.oid && limits.aids.has(String(item.oid))) return true;
    if (item.bvid && limits.bvids.has(String(item.bvid))) return true;
    return false;
  }

  function prepareQueueItem(item, reasons) {
    item.recordKey = item.recordKey || makeRecordKey(item);
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
    await saveProcessedRecords();
  }

  function statusFromVerificationFailure(verification) {
    const code = verification && verification.code ? String(verification.code) : "";
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

  async function startDelete() {
    if (state.deletion.running) return;
    if (!state.user || !state.csrf) {
      await refreshLogin();
      if (!state.user || !state.csrf) return;
    }

    const queue = state.items.filter((item) => state.selected.has(item.localId) && item.status !== "deleted");
    if (queue.length === 0) {
      setMessage("没有可删除的勾选评论。", "warn");
      return;
    }

    state.deletion.running = true;
    state.deletion.paused = false;
    state.deletion.stop = false;
    setMessage(`开始删除 ${queue.length} 条评论。`, "warn");
    renderAll();

    try {
      for (const item of queue) {
        if (state.deletion.stop) break;
        while (state.deletion.paused && !state.deletion.stop) {
          await sleep(300);
        }
        if (state.deletion.stop) break;

        await processDeleteItem(item);
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

  async function processDeleteItem(item) {
    try {
      item.status = utils.nextDeleteState(item.status, "verify");
      renderAll();

      const verification = await verifyItem(item);
      if (!verification.ok) {
        item.status = statusFromVerificationFailure(verification);
        item.errorCode = verification.code || "verify_failed";
        item.errorMessage = verification.message;
        item.verifyCode = verification.code || "";
        item.verifyMessage = verification.message || "";
        item.debug = verification.debug || item.debug || "";
        if (CLOSED_STATUSES.has(item.status)) {
          await markProcessedRecord(item, item.status, item.errorMessage, item.debug);
          state.selected.delete(item.localId);
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
        state.selected.delete(item.localId);
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

    return {
      ok: false,
      code: "verify_not_found",
      message: "B站未返回该评论，可能已删除、评论区不可见或 AICU 索引过期",
      debug: seekResult.debug || item.debug || `reply/detail/reply/main 未找到 rpid=${item.rpid}, oid=${item.oid}, root=${item.root}`
    };
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
        return {
          ok: false,
          code: "seek_not_found",
          message: "seek_rpid 未找到该评论",
          debug: summarizePayload("reply/main", payload)
        };
      }

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
    const stack = [];
    if (data && data.root) stack.push(data.root);
    if (data && Array.isArray(data.replies)) stack.push(...data.replies);

    while (stack.length > 0) {
      const item = stack.shift();
      if (!item) continue;
      if (String(item.rpid || item.id || "") === target) return item;
      if (Array.isArray(item.replies)) stack.push(...item.replies);
    }

    return null;
  }

  function getReplyMid(reply) {
    return reply && reply.member && (reply.member.mid || reply.member.uid);
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
        const tabId = await ensureAicuWorkerTab();
        const value = await executeFetchInTab(tabId, request);
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
      } catch (workerError) {
        if (/直连失败：/.test(workerError.message || "")) {
          throw workerError;
        }
        throw new Error(`直连失败：${directMessage}；工作页失败：${workerError.message}`);
      }
    }
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
      return existing.id;
    }

    const tab = await chrome.tabs.create({ url: AICU_WORKER_URL, active: false });
    if (!tab.id) {
      throw new Error("无法创建 AICU 工作标签页");
    }
    await waitForTabComplete(tab.id);
    return tab.id;
  }

  async function ensureApiTab(url) {
    const tabs = await chrome.tabs.query({ url: "https://api.aicu.cc/*" });
    const existing = tabs.find((tab) => tab.id && !tab.discarded);
    if (existing && existing.id) {
      await chrome.tabs.update(existing.id, { url, active: false });
      await waitForTabComplete(existing.id, "AICU API 页签加载超时");
      return { id: existing.id };
    }

    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab.id) {
      throw new Error("无法创建 AICU API 页签");
    }
    await waitForTabComplete(tab.id, "AICU API 页签加载超时");
    return { id: tab.id };
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
    return JSON.stringify({
      label,
      code: payload && payload.code,
      message: payload && (payload.message || payload.msg),
      ttl: payload && payload.ttl,
      dataKeys: payload && payload.data && typeof payload.data === "object" ? Object.keys(payload.data).slice(0, 20) : []
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
    state.logs = [];
    state.selected.clear();
    state.scan.scanned = 0;
    state.scan.pages = 0;
    state.scan.hiddenProcessed = 0;
    if (showMessage) setMessage("结果已清空。", "info");
    renderAll();
  }

  function selectAllPending() {
    for (const item of state.items) {
      if (isDeletableStatus(item.status)) state.selected.add(item.localId);
    }
    renderAll();
  }

  function invertSelection() {
    for (const item of state.items) {
      if (!isDeletableStatus(item.status)) continue;
      if (state.selected.has(item.localId)) {
        state.selected.delete(item.localId);
      } else {
        state.selected.add(item.localId);
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
      "status", "errorCode", "errorMessage", "uid", "oid", "bvid", "videoTitle",
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
        hasVideoList: Boolean(state.settings.videoList)
      },
      items: buildExportRows(),
      logs: state.logs
    };
  }

  function buildExportRows() {
    return state.items.map((item) => ({
      status: item.status || "",
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
    els.startScan.disabled = state.scan.running || state.deletion.running;
    els.stopScan.disabled = !state.scan.running;
    els.clearProcessed.disabled = state.scan.running || state.deletion.running || !state.user;
    els.startDelete.disabled = state.deletion.running || selectedDeletableCount() === 0;
    els.pauseDelete.disabled = !state.deletion.running;
    els.pauseDelete.textContent = state.deletion.paused ? "继续" : "暂停";
    els.stopDelete.disabled = !state.deletion.running;
    els.exportCsv.disabled = state.items.length === 0;
    els.exportJson.disabled = state.items.length === 0;
    els.copyDebug.disabled = state.items.length === 0 && state.logs.length === 0;
  }

  function renderMetrics() {
    const deleted = state.items.filter((item) => item.status === "deleted").length;
    const failed = state.items.filter((item) => item.status === "failed" || item.status === "skipped" || item.status === "gone" || item.status === "invalid").length;
    els.metricCandidates.textContent = state.items.length;
    els.metricSelected.textContent = state.selected.size;
    els.metricDeleted.textContent = deleted;
    els.metricFailed.textContent = failed;
    els.metricHidden.textContent = state.scan.hiddenProcessed;
  }

  function renderTable() {
    els.previewBody.textContent = "";
    if (state.items.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.className = "empty";
      cell.textContent = "等待扫描结果";
      row.appendChild(cell);
      els.previewBody.appendChild(row);
      els.renderHint.textContent = "";
      return;
    }

    const visible = state.items.slice(0, MAX_RENDER_ROWS);
    for (const item of visible) {
      els.previewBody.appendChild(renderRow(item));
    }

    els.renderHint.textContent = state.items.length > MAX_RENDER_ROWS
      ? `当前仅渲染前 ${MAX_RENDER_ROWS} 条，导出仍包含全部 ${state.items.length} 条。`
      : "";
  }

  function renderRow(item) {
    const row = document.createElement("tr");
    row.dataset.status = item.status || "pending";

    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(item.localId);
    checkbox.disabled = !isDeletableStatus(item.status) || state.deletion.running;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selected.add(item.localId);
      } else {
        state.selected.delete(item.localId);
      }
      renderButtons();
      renderMetrics();
    });
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);

    appendTextCell(row, statusText(item.status), `badge ${item.status || "pending"}`);
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

  function selectedDeletableCount() {
    return state.items.filter((item) => state.selected.has(item.localId) && isDeletableStatus(item.status)).length;
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
