const assert = require("node:assert/strict");
const utils = require("../utils.js");

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("parse keywords", () => {
  assert.deepEqual(utils.parseKeywords("旧评论, 黑历史，测试 "), ["旧评论", "黑历史", "测试"]);
  assert.deepEqual(utils.parseKeywords(""), []);
});

run("parse date range", () => {
  const range = utils.parseDateRange("2020-01-01", "2020-01-02");
  assert.ok(range.start < range.end);
  assert.throws(() => utils.parseDateRange("2020-01-03", "2020-01-02"), /开始日期/);
});

run("parse video input", () => {
  const parsed = utils.parseBiliVideoInput("https://www.bilibili.com/video/BV1xx411c7mD/\nav170001");
  assert.equal(parsed.bvids.has("BV1xx411c7mD"), true);
  assert.equal(parsed.aids.has("170001"), true);
  assert.equal(parsed.hasLimits, true);
});

run("parse video input ignores tracking numbers in BV links", () => {
  const parsed = utils.parseBiliVideoInput("https://www.bilibili.com/video/BV1324y1y7yq/?spm_id_from=333.999.0.0");
  assert.equal(parsed.bvids.has("BV1324y1y7yq"), true);
  assert.equal(parsed.aids.size, 0);
});

run("normalize video input strips reply anchors", () => {
  const normalized = utils.normalizeBiliVideoInput("https://www.bilibili.com/video/BV1324y1y7yq/?spm_id_from=333.999.0.0#reply295627202769");
  assert.equal(normalized.text, "BV1324y1y7yq");
});

run("normalize AICU reply", () => {
  const item = utils.normalizeAicuReply({
    rpid: 99,
    root: 55,
    dyn: { oid: 123, title: "测试视频" },
    message: "这是一条旧评论",
    time: 1700000000
  }, "42", 0);

  assert.equal(item.ownerMid, "42");
  assert.equal(item.oid, "123");
  assert.equal(item.rpid, "99");
  assert.equal(item.root, "55");
  assert.equal(item.level, "二级回复");
  assert.equal(item.videoUrl, "https://www.bilibili.com/video/av123/#reply99");
});

run("normalize AICU reply ignores object root without id", () => {
  const item = utils.normalizeAicuReply({
    rpid: 99,
    root: { type: 1, oid: 123 },
    dyn: { oid: 123 },
    message: "对象 root 不应变成字符串"
  }, "42", 0);

  assert.equal(item.root, "99");
  assert.equal(item.level, "一级评论");
});

run("filter by uid keyword and date", () => {
  const item = {
    ownerMid: "42",
    message: "需要清理的旧评论",
    ctime: 1700000000
  };
  const matched = utils.matchesFilters(item, {
    uid: "42",
    keywords: ["旧评论"],
    start: 1600000000,
    end: 1800000000
  });
  assert.equal(matched.matches, true);

  const missed = utils.matchesFilters(item, {
    uid: "43",
    keywords: ["旧评论"]
  });
  assert.equal(missed.matches, false);

  const unknownAuthor = utils.matchesFilters({ message: "别人 @ 我" }, {
    uid: "42",
    keywords: []
  });
  assert.equal(unknownAuthor.matches, false);
  assert.deepEqual(unknownAuthor.reasons, ["无法确认作者 UID"]);
});

run("parse manual import links and pairs", () => {
  const parsed = utils.parseManualImportText("https://www.bilibili.com/video/av123/#reply456\n789,101112");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].source, "手动导入");
  assert.equal(parsed.items[0].oid, "123");
  assert.equal(parsed.items[0].rpid, "456");
  assert.equal(parsed.items[0].root, "");
  assert.equal(parsed.items[0].level, "待核验");
  assert.equal(parsed.items[1].oid, "789");
  assert.equal(parsed.items[1].rpid, "101112");
});

run("parse manual import explicit root", () => {
  const parsed = utils.parseManualImportText("123,456,789");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].oid, "123");
  assert.equal(parsed.items[0].rpid, "456");
  assert.equal(parsed.items[0].root, "789");
  assert.equal(parsed.items[0].level, "二级回复");
});

run("parse manual import does not use BVID digits as rpid", () => {
  const parsed = utils.parseManualImportText("https://www.bilibili.com/video/BV1324y1y7yq/");
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.errors.length, 1);
});

run("parse manual import BVID with explicit rpid", () => {
  const parsed = utils.parseManualImportText("BV1324y1y7yq 987654321 123456789");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].bvid, "BV1324y1y7yq");
  assert.equal(parsed.items[0].rpid, "987654321");
  assert.equal(parsed.items[0].root, "123456789");
  assert.equal(parsed.items[0].level, "二级回复");
});

run("parse manual import CSV", () => {
  const parsed = utils.parseManualImportText('oid,rpid,message\n123,456,"他说 ""你好"""');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].oid, "123");
  assert.equal(parsed.items[0].rpid, "456");
  assert.equal(parsed.items[0].message, '他说 "你好"');
});

run("parse manual import JSON export shape", () => {
  const parsed = utils.parseManualImportText(JSON.stringify({
    items: [{ oid: "123", rpid: "456", videoTitle: "测试", message: "导入评论" }]
  }));
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].videoTitle, "测试");
  assert.equal(parsed.items[0].message, "导入评论");
});

run("build CSV escapes values", () => {
  const csv = utils.buildCsv(["message"], [{ message: '他说 "你好"\n第二行' }]);
  assert.equal(csv, '"message"\n"他说 ""你好""\n第二行"');
});

run("delete state transitions", () => {
  assert.equal(utils.nextDeleteState("pending", "verify"), "verifying");
  assert.equal(utils.nextDeleteState("verifying", "pass"), "deleting");
  assert.equal(utils.nextDeleteState("deleting", "success"), "deleted");
  assert.equal(utils.nextDeleteState("failed", "retry"), "pending");
});
