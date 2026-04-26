(function attachUtils(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BiliCleanerUtils = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createUtils() {
  const VIDEO_BV_RE = /\bBV[0-9A-Za-z]{8,14}\b/g;
  const VIDEO_AV_RE = /(?:^|[^\w])(?:av)?(\d{1,12})(?:$|[^\w])/i;

  function parseKeywords(value) {
    return String(value || "")
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function parseDateRange(startDate, endDate) {
    const start = parseDateBoundary(startDate, false);
    const end = parseDateBoundary(endDate, true);

    if (start && end && start > end) {
      throw new Error("开始日期不能晚于结束日期");
    }

    return { start, end };
  }

  function parseDateBoundary(value, isEnd) {
    if (!value) return null;
    const text = String(value).trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      throw new Error("日期格式必须为 YYYY-MM-DD");
    }

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = isEnd
      ? new Date(year, month, day, 23, 59, 59, 999)
      : new Date(year, month, day, 0, 0, 0, 0);

    if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
      throw new Error("日期无效");
    }

    return Math.floor(date.getTime() / 1000);
  }

  function parseBiliVideoInput(value) {
    const aids = new Set();
    const bvids = new Set();
    const lines = String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const bvs = line.match(VIDEO_BV_RE) || [];
      for (const bv of bvs) {
        bvids.add(bv);
      }

      const avMatch = line.match(/(?:\/video\/av|(?:^|[^\w])av)(\d{1,12})/i) || line.match(VIDEO_AV_RE);
      if (avMatch && avMatch[1]) {
        aids.add(String(Number(avMatch[1])));
      }
    }

    return {
      aids,
      bvids,
      hasLimits: aids.size > 0 || bvids.size > 0,
      lines
    };
  }

  function parseTimeToSeconds(value) {
    if (value == null || value === "") return 0;
    if (typeof value === "number") {
      return value > 100000000000 ? Math.floor(value / 1000) : Math.floor(value);
    }

    const text = String(value).trim();
    if (/^\d+$/.test(text)) {
      const num = Number(text);
      return num > 100000000000 ? Math.floor(num / 1000) : Math.floor(num);
    }

    const parsed = Date.parse(text.replace(/-/g, "/"));
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  }

  function normalizeAicuReply(reply, uid, index) {
    const dyn = reply.dyn || reply.dynamic || reply.archive || {};
    const content = reply.content || {};
    const member = reply.member || reply.user || reply.author || {};
    const rpid = firstScalar(reply.rpid, reply.id, reply.reply_id, reply.replyId);
    const root = firstScalar(
      reply.root_id,
      reply.rootId,
      reply.root,
      readObjectScalar(reply.root, ["rpid", "id", "root", "root_id", "rootId"]),
      reply.parent,
      reply.parent_id,
      reply.parentId,
      reply.dialog
    );
    const oid = firstScalar(reply.oid, reply.aid, reply.av, reply.archive_id, dyn.oid, dyn.aid, dyn.rid);
    const bvid = firstScalar(reply.bvid, dyn.bvid, dyn.BVID);
    const ownerMid = firstScalar(reply.mid, reply.uid, member.mid, member.uid, uid);
    const message = String(firstValue(reply.message, reply.msg, reply.text, content.message, content.text, "") || "");
    const ctime = parseTimeToSeconds(firstValue(reply.ctime, reply.time, reply.pubtime, reply.create_time, reply.created_at));
    const normalizedRoot = root ? String(root) : "";
    const normalizedRpid = rpid ? String(rpid) : "";
    const normalizedOid = oid ? String(oid) : "";
    const level = normalizedRoot && normalizedRoot !== "0" && normalizedRoot !== normalizedRpid ? "二级回复" : "一级评论";
    const videoTitle = String(firstValue(reply.title, dyn.title, dyn.name, "") || "");
    const videoUrl = buildVideoUrl(normalizedOid, bvid, normalizedRpid);

    return {
      localId: `${normalizedOid || "unknown"}:${normalizedRpid || index}:${index}`,
      source: "AICU",
      ownerMid: ownerMid ? String(ownerMid) : "",
      oid: normalizedOid,
      bvid: bvid ? String(bvid) : "",
      rpid: normalizedRpid,
      root: normalizedRoot && normalizedRoot !== "0" ? normalizedRoot : normalizedRpid,
      level,
      message,
      ctime,
      timeText: formatTime(ctime),
      videoTitle,
      videoUrl,
      raw: reply
    };
  }

  function firstValue() {
    for (const value of arguments) {
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return "";
  }

  function firstScalar() {
    for (const value of arguments) {
      if (isUsableScalar(value)) {
        return value;
      }
    }
    return "";
  }

  function isUsableScalar(value) {
    return (typeof value === "string" || typeof value === "number" || typeof value === "bigint") && String(value) !== "";
  }

  function readObjectScalar(value, keys) {
    if (!value || typeof value !== "object") return "";
    for (const key of keys) {
      if (isUsableScalar(value[key])) {
        return value[key];
      }
    }
    return "";
  }

  function buildVideoUrl(oid, bvid, rpid) {
    const base = bvid
      ? `https://www.bilibili.com/video/${bvid}/`
      : oid
        ? `https://www.bilibili.com/video/av${oid}/`
        : "https://www.bilibili.com/";
    return rpid ? `${base}#reply${rpid}` : base;
  }

  function matchesFilters(item, filters) {
    const reasons = [];
    const keywords = filters.keywords || [];
    const message = String(item.message || "");

    if (filters.uid && item.ownerMid && String(item.ownerMid) !== String(filters.uid)) {
      return { matches: false, reasons: ["不是当前 UID"] };
    }

    if (keywords.length > 0) {
      const matchedKeywords = keywords.filter((keyword) => message.includes(keyword));
      if (matchedKeywords.length === 0) {
        return { matches: false, reasons: ["未命中关键词"] };
      }
      reasons.push(`关键词: ${matchedKeywords.join(", ")}`);
    }

    const ctime = Number(item.ctime || 0);
    if (filters.start && (!ctime || ctime < filters.start)) {
      return { matches: false, reasons: ["早于开始日期"] };
    }
    if (filters.end && (!ctime || ctime > filters.end)) {
      return { matches: false, reasons: ["晚于结束日期"] };
    }
    if (filters.start || filters.end) {
      reasons.push("时间范围");
    }

    if (reasons.length === 0) {
      reasons.push("当前 UID");
    }

    return { matches: true, reasons };
  }

  function formatTime(seconds) {
    const value = Number(seconds || 0);
    if (!value) return "";
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (num) => String(num).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function escapeCsvCell(value) {
    const text = value == null ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  }

  function buildCsv(headers, rows) {
    const head = headers.map(escapeCsvCell).join(",");
    const body = rows.map((row) => headers.map((key) => escapeCsvCell(row[key])).join(","));
    return [head].concat(body).join("\n");
  }

  function nextDeleteState(current, event) {
    const table = {
      pending: { verify: "verifying", skip: "skipped" },
      verifying: { pass: "deleting", fail: "skipped", stop: "pending" },
      deleting: { success: "deleted", fail: "failed", stop: "failed" },
      failed: { retry: "pending" },
      skipped: { retry: "pending" },
      deleted: {}
    };
    return (table[current] && table[current][event]) || current;
  }

  return {
    parseKeywords,
    parseDateRange,
    parseBiliVideoInput,
    parseTimeToSeconds,
    normalizeAicuReply,
    matchesFilters,
    formatTime,
    escapeCsvCell,
    buildCsv,
    nextDeleteState
  };
});
