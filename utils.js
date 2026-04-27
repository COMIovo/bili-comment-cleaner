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

      const avMatch = line.match(/\/video\/av(\d{1,12})/i)
        || line.match(/(?:^|[^\w])av(\d{1,12})(?:$|[^\w])/i)
        || (bvs.length === 0 ? line.match(/^\d{1,12}$/) : null);
      if (avMatch && avMatch[1]) {
        aids.add(String(Number(avMatch[1])));
      } else if (avMatch && avMatch[0] && /^\d+$/.test(avMatch[0])) {
        aids.add(String(Number(avMatch[0])));
      }
    }

    return {
      aids,
      bvids,
      hasLimits: aids.size > 0 || bvids.size > 0,
      lines
    };
  }

  function normalizeBiliVideoInput(value) {
    const parsed = parseBiliVideoInput(value);
    const lines = [
      ...Array.from(parsed.bvids),
      ...Array.from(parsed.aids).map((aid) => `av${aid}`)
    ];
    return {
      ...parsed,
      text: lines.join("\n")
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

  function parseManualImportText(value) {
    const text = String(value || "").trim();
    const result = { items: [], errors: [] };
    if (!text) return result;

    let parsedStructured = false;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.replies) ? parsed.replies : [];
        rows.forEach((row, index) => addManualCandidate(result, normalizeManualObject(row, index), `JSON 第 ${index + 1} 项`));
        parsedStructured = rows.length > 0;
      } catch (error) {
        result.errors.push(`JSON 解析失败：${error.message}`);
      }
    }

    if (!parsedStructured && looksLikeDelimitedTable(text)) {
      const parsed = parseDelimitedTable(text);
      if (parsed.rows.length > 0) {
        parsed.rows.forEach((row, index) => addManualCandidate(result, normalizeManualObject(row, index), `表格第 ${index + 2} 行`));
        parsedStructured = true;
      }
      result.errors.push(...parsed.errors);
    }

    if (!parsedStructured) {
      text.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        addManualCandidate(result, parseManualLine(trimmed, index), `第 ${index + 1} 行`);
      });
    }

    const seen = new Set();
    result.items = result.items.filter((item) => {
      const key = `${item.oid || item.bvid}:${item.rpid}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return result;
  }

  function addManualCandidate(result, item, label) {
    if (!item || !item.rpid || (!item.oid && !item.bvid)) {
      result.errors.push(`${label} 缺少 aid/BV 或 rpid`);
      return;
    }
    result.items.push(item);
  }

  function normalizeManualObject(row, index) {
    if (!row || typeof row !== "object") return null;
    const rawUrl = firstScalar(row.videoUrl, row.url, row.link);
    const lineCandidate = rawUrl ? parseManualLine(String(rawUrl), index) : {};
    const oid = firstScalar(row.oid, row.aid, row.av, row.archive_id, lineCandidate.oid);
    const bvid = firstScalar(row.bvid, row.BVID, lineCandidate.bvid);
    const rpid = firstScalar(row.rpid, row.reply_id, row.replyId, row.id, lineCandidate.rpid);
    const root = firstScalar(row.root, row.root_id, row.rootId, lineCandidate.root);
    const ctime = parseTimeToSeconds(firstValue(row.ctime, row.time, row.timeText, row.create_time, row.created_at));
    const message = String(firstValue(row.message, row.msg, row.text, row.content, "") || "");
    const videoTitle = String(firstValue(row.videoTitle, row.title, "") || "");
    const normalizedOid = oid ? String(oid) : "";
    const normalizedBvid = bvid ? String(bvid) : "";
    const normalizedRpid = rpid ? String(rpid) : "";
    const normalizedRoot = root ? String(root) : "";
    const normalizedLevel = normalizedRoot && normalizedRoot !== "0"
      ? normalizedRoot !== normalizedRpid ? "二级回复" : "一级评论"
      : "待核验";
    return {
      localId: `manual:${normalizedOid || normalizedBvid || "unknown"}:${normalizedRpid}:${index}`,
      source: "手动导入",
      ownerMid: "",
      oid: normalizedOid,
      bvid: normalizedBvid,
      rpid: normalizedRpid,
      root: normalizedRoot && normalizedRoot !== "0" ? normalizedRoot : "",
      level: normalizedLevel,
      message,
      ctime,
      timeText: formatTime(ctime),
      videoTitle,
      videoUrl: buildVideoUrl(normalizedOid, normalizedBvid, normalizedRpid),
      raw: row
    };
  }

  function parseManualLine(line, index) {
    const bvid = firstScalar(...(line.match(VIDEO_BV_RE) || []));
    const avMatch = line.match(/(?:\/video\/av|(?:^|[^\w])av)(\d{1,18})/i) || line.match(/[?&](?:aid|oid)=(\d{1,18})/i);
    const rpidMatch = line.match(/(?:#reply|[?&]rpid=|(?:^|[^\w])rpid\s*[:=, ]\s*|(?:^|[^\w])reply\s*[:=, ]\s*)(\d{1,18})/i);
    const rootMatch = line.match(/(?:[?&]root=|(?:^|[^\w])root\s*[:=, ]\s*)(\d{1,18})/i);
    const labeledAid = avMatch && avMatch[1] ? String(Number(avMatch[1])) : "";
    const labeledRpid = rpidMatch && rpidMatch[1] ? String(Number(rpidMatch[1])) : "";
    let root = rootMatch && rootMatch[1] ? String(Number(rootMatch[1])) : "";
    const numericTokens = numericTokensOutsideBvidUrls(line);
    let oid = labeledAid;
    let rpid = labeledRpid;

    if (!oid && !bvid && numericTokens.length >= 2) {
      oid = String(Number(numericTokens[0]));
      rpid = rpid || String(Number(numericTokens[1]));
      if (!root && numericTokens.length >= 3) {
        root = String(Number(numericTokens[2]));
      }
    } else if (!rpid && bvid && numericTokens.length >= 1) {
      rpid = String(Number(numericTokens[0]));
      if (!root && numericTokens.length >= 2) {
        root = String(Number(numericTokens[1]));
      }
    } else if (!rpid && numericTokens.length > 0) {
      const firstDifferent = numericTokens.find((token) => String(Number(token)) !== oid);
      if (firstDifferent) rpid = String(Number(firstDifferent));
    }

    const normalizedRoot = root || "";
    const normalizedLevel = normalizedRoot && normalizedRoot !== "0"
      ? normalizedRoot !== rpid ? "二级回复" : "一级评论"
      : "待核验";
    return {
      localId: `manual:${oid || bvid || "unknown"}:${rpid}:${index}`,
      source: "手动导入",
      ownerMid: "",
      oid,
      bvid: bvid || "",
      rpid,
      root: normalizedRoot && normalizedRoot !== "0" ? normalizedRoot : "",
      level: normalizedLevel,
      message: "",
      ctime: 0,
      timeText: "",
      videoTitle: "",
      videoUrl: buildVideoUrl(oid, bvid, rpid),
      raw: { line }
    };
  }

  function looksLikeDelimitedTable(text) {
    const firstLine = text.split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) return false;
    const lower = firstLine.toLowerCase();
    return /[,	]/.test(firstLine) && /(rpid|reply|oid|aid|bvid|video)/i.test(lower);
  }

  function numericTokensOutsideBvidUrls(line) {
    const withoutUrls = String(line || "").replace(/https?:\/\/\S+/gi, " ");
    const withoutBvid = withoutUrls.replace(VIDEO_BV_RE, " ");
    return withoutBvid.match(/\d{1,18}/g) || [];
  }

  function parseDelimitedTable(text) {
    const errors = [];
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) return { rows: [], errors };
    const delimiter = lines[0].includes("\t") ? "\t" : ",";
    const headers = splitDelimitedLine(lines[0], delimiter).map((header) => header.trim());
    const rows = [];
    for (let index = 1; index < lines.length; index += 1) {
      const values = splitDelimitedLine(lines[index], delimiter);
      if (values.length === 0) continue;
      const row = {};
      headers.forEach((header, headerIndex) => {
        row[header] = values[headerIndex] == null ? "" : values[headerIndex];
      });
      rows.push(row);
    }
    if (headers.length === 0) {
      errors.push("表格缺少表头");
    }
    return { rows, errors };
  }

  function splitDelimitedLine(line, delimiter) {
    const cells = [];
    let current = "";
    let inQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (char === '"' && inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells.map((cell) => cell.trim());
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

    if (filters.uid && !item.ownerMid) {
      return { matches: false, reasons: ["无法确认作者 UID"] };
    }

    if (filters.uid && String(item.ownerMid) !== String(filters.uid)) {
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
    normalizeBiliVideoInput,
    parseTimeToSeconds,
    normalizeAicuReply,
    parseManualImportText,
    matchesFilters,
    formatTime,
    escapeCsvCell,
    buildCsv,
    nextDeleteState
  };
});
