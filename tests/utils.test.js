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
