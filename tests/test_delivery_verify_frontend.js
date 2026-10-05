// 交付字幕核验的前端绑定回归（node 直接运行，无框架）：
// 用最小 DOM/fetch 桩在 vm 中加载 app/static/app.js，验证——
// - 核验结果与「项目 + 生效轴 timeline_hash + 上传序号」绑定；
// - 参数重算/采纳/撤销改变生效轴（hash 变化）后：旧结论立即作废，
//   留存的上传稿自动按新生效轴重新核验，无稿时提示重新上传；
// - 生效轴未变（hash 相同，含本页修改失败回滚）时结论保留，不发请求；
// - 指纹不符（典型：另一标签页改最小间隔、本页详情仍旧）时先 GET
//   该项目最新详情裁决：响应指纹与最新详情一致则直接接纳、不重核；
//   确实落后才用最近一次上传稿重核，且自动重核轮数有上限——多次连续
//   变轴触顶、详情刷新失败或稿件不可用时停止并提示重传，不显示旧结论、
//   不循环发请求；
// - 再次上传或切换项目后，迟到的响应与迟到的详情刷新都被丢弃，只呈现
//   当前项目最近一次有效上传的结果；响应到达即过期（等待期间生效轴
//   被改）时按最新详情裁决。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// ---------- 最小 DOM 桩 ----------
function makeEl(tag = "div") {
  return {
    tagName: tag,
    innerHTML: "",
    textContent: "",
    value: "",
    href: "",
    files: [],
    children: [],
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    reset() { this.files = []; if (this.delivery) this.delivery.files = []; },
    closest() { return null; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
  };
}

const bySelector = new Map();
const documentStub = {
  querySelector(sel) {
    if (!bySelector.has(sel)) bySelector.set(sel, makeEl());
    return bySelector.get(sel);
  },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl(tag); },
};

// ---------- fetch 桩：响应时机完全由测试控制 ----------
const pending = [];   // 在途请求 {url, method, resolve}
const fetchLog = [];
function fetchStub(url, opts = {}) {
  const method = opts.method || "GET";
  fetchLog.push({ url, method });
  return new Promise((resolve) => pending.push({ url, method, resolve }));
}
function popPending(substr, method) {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].url.includes(substr) &&
        (!method || pending[i].method === method)) {
      return pending.splice(i, 1)[0];
    }
  }
  throw new Error(`没有在途请求匹配 ${method || ""} ${substr}`);
}
function respondJson(req, body, ok = true, status = 200) {
  req.resolve({ ok, status, json: async () => body });
}
const flush = () => new Promise((r) => setImmediate(r));

class FormDataStub {
  constructor() { this.parts = []; }
  append(k, v) { this.parts.push([k, v]); }
}

// ---------- 在 vm 中加载 app.js，并暴露词法绑定的 state 与函数 ----------
const src = fs.readFileSync(APP_JS, "utf8") +
  "\n;globalThis.__app = { state, render, renderDeliveryVerify," +
  " syncDeliveryVerify, resetDeliveryVerify, runDeliveryVerify," +
  " requestVerifyRefetch, runVerifyChain, stopVerify };";
const sandbox = {
  document: documentStub,
  fetch: fetchStub,
  FormData: FormDataStub,
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "app.js" });
const app = sandbox.__app;
const { state } = app;
const MAX = vm.runInContext("MAX_AUTO_REVERIFY", sandbox);

// ---------- 测试工具 ----------
function proj(id, hash) {
  return {
    id, name: `P${id}`, cps_limit: 21, min_gap_ms: 40, tolerance_ms: 200,
    created_at: "", timeline_hash: hash,
    shots: [], cues: [],
    analysis: {
      cues: [], chains: [], intrinsic: [],
      stats: { cue_count: 0, shot_count: 0, gap_violations: 0,
               cps_violations: 0, cross_shot_count: 0, proposal_count: 0,
               proposal_moved_count: 0, conflict_cue_count: 0,
               total_shift_ms: 0 },
    },
    gap_review: null,
  };
}
function verifyResult(pid, hash, pass) {
  return { project_id: pid, project_name: `P${pid}`, delivery_name: "d.srt",
           timeline_hash: hash, reference_count: 2, delivered_count: 2,
           matched_text_count: 2,
           summary: { pass, time_mismatch: 0, missing: 0, new: 0,
                      pending: 0 },
           rows: [] };
}
const verifyPostCount = () =>
  fetchLog.filter((r) => r.url.includes("/verify-delivery")).length;
const detailGetCount = (pid) =>
  fetchLog.filter((r) => r.method === "GET" &&
                        r.url === `/api/projects/${pid}`).length;

const deliveryForm = documentStub.querySelector("#deliveryVerifyForm");
deliveryForm.delivery = makeEl("input");
const settingsForm = documentStub.querySelector("#settingsForm");
settingsForm.cps_limit = makeEl("input");
settingsForm.min_gap_ms = makeEl("input");
settingsForm.tolerance_ms = makeEl("input");

// 走与真实「上传并核验」按钮一致的提交流程（留存稿件 + 新链路序号）
function submitVerify(pid, file) {
  deliveryForm.delivery.files = [file];
  for (const fn of deliveryForm.listeners.submit) fn({
    preventDefault() {}, target: deliveryForm,
  });
  return popPending(`/api/projects/${pid}/verify-delivery`, "POST");
}

function clearVerifyState() {
  state.deliveryVerify = null;
  state.verifyFile = null;
  state.verifyRunning = false;
  state.verifyRefetch = false;
  state.verifyAutoRounds = 0;
  state.verifyNotice = "";
  state.verifySeq++;
}

// ---------- 场景 ----------

async function test_manual_upload_binds_result() {
  clearVerifyState();
  state.project = proj(1, "h1");
  const req = submitVerify(1, "fileA");
  assert.strictEqual(verifyPostCount(), 1, "应发出一次核验请求");
  respondJson(req, verifyResult(1, "h1", 2));
  await flush();
  assert.ok(state.deliveryVerify, "结果应展示");
  assert.strictEqual(state.verifyRunning, false);
  assert.strictEqual(state.verifyFile, "fileA", "应留存上传稿快照");
  assert.strictEqual(state.deliveryVerify.timeline_hash, "h1");
  assert.strictEqual(state.deliveryVerify.project_id, 1);
  console.log("frontend manual upload binds project+timeline ok");
}

async function test_local_timeline_change_auto_reverify() {
  // 本页参数重算改变生效轴（h1 → h2）：旧结论立即作废，留存稿自动重核；
  // 本页详情已含新指纹 → 响应直接接纳，不额外拉详情
  state.project = proj(1, "h2");
  app.render();
  assert.strictEqual(state.deliveryVerify, null, "旧结论必须立即作废");
  assert.ok(state.verifyNotice.includes("重新核验"), "应提示正在重核");
  assert.strictEqual(verifyPostCount(), 2, "应自动发起重新核验");
  const gets = detailGetCount(1);
  respondJson(popPending("verify-delivery"), verifyResult(1, "h2", 1));
  await flush();
  assert.ok(state.deliveryVerify, "自动重核结果应展示");
  assert.strictEqual(state.deliveryVerify.timeline_hash, "h2");
  assert.strictEqual(state.deliveryVerify.summary.pass, 1);
  assert.strictEqual(detailGetCount(1), gets, "本页详情已最新时不拉详情");
  console.log("frontend local timeline change -> invalidate + auto re-verify ok");
}

async function test_timeline_unchanged_keeps_result() {
  // 生效轴未变（如仅调 CPS 上限 / 相同参数重提）：结论保留，不发请求
  state.project = proj(1, "h2");
  const before = verifyPostCount();
  const gets = detailGetCount(1);
  app.render();
  assert.strictEqual(verifyPostCount(), before, "不应发起新核验");
  assert.strictEqual(detailGetCount(1), gets, "不应拉取详情");
  assert.ok(state.deliveryVerify, "有效结论应保留");
  assert.strictEqual(state.deliveryVerify.timeline_hash, "h2");
  console.log("frontend unchanged timeline keeps result ok");
}

async function test_concurrent_uploads_last_wins() {
  // 连续两次上传：第一次的响应迟到，不得覆盖第二次的结果
  clearVerifyState();
  state.project = proj(1, "h2");
  const req1 = submitVerify(1, "fileB");
  const req2 = submitVerify(1, "fileB2");
  assert.strictEqual(state.verifyFile, "fileB2", "留存最近一次上传稿");
  respondJson(req2, verifyResult(1, "h2", 5));   // 第二次先返回
  await flush();
  assert.strictEqual(state.deliveryVerify.summary.pass, 5);
  respondJson(req1, verifyResult(1, "h2", 99));  // 第一次迟到
  await flush();
  assert.strictEqual(state.deliveryVerify.summary.pass, 5,
                     "迟到响应不得覆盖最近一次上传的结果");
  console.log("frontend concurrent uploads: last response wins ok");
}

async function test_switch_project_discards_inflight() {
  // 上传未完成时切换项目：迟到响应在进入裁决前即因序号失效被丢弃，
  // 既不展示也不会再拉详情/重核
  clearVerifyState();
  state.project = proj(1, "h2");
  const req = submitVerify(1, "fileC");
  app.resetDeliveryVerify();          // 切换项目的前置清理（在途失效）
  state.project = proj(2, "k1");
  respondJson(req, verifyResult(1, "h2", 7));
  await flush();
  assert.strictEqual(state.deliveryVerify, null,
                     "切换项目后迟到响应必须丢弃");
  assert.ok(!pending.some((r) => r.url.includes("/api/projects/1")),
            "迟到响应不得再触发该项目的详情刷新/重核");
  console.log("frontend switch project discards in-flight response ok");
}

async function test_no_file_requires_reupload() {
  // 先得到项目 2 的有效结果
  clearVerifyState();
  state.project = proj(2, "k1");
  const req = submitVerify(2, "fileD");
  respondJson(req, verifyResult(2, "k1", 3));
  await flush();
  assert.ok(state.deliveryVerify);
  // 留存稿丢失（如被 reset 清理）后生效轴变化 → 作废并提示重传，不发请求
  state.verifyFile = null;
  const before = verifyPostCount();
  state.project = proj(2, "k2");
  app.render();
  assert.strictEqual(state.deliveryVerify, null, "旧结论必须作废");
  assert.strictEqual(verifyPostCount(), before, "无可读稿件不得自动重核");
  assert.ok(state.verifyNotice.includes("重新上传"), "应提示重新上传");
  console.log("frontend no file -> invalidate + ask re-upload ok");
}

async function test_cross_tab_stale_detail_accepts_via_fresh_detail() {
  // 核心修复：另一标签页把最小间隔 40→100（轴 h1→h2），本页详情仍停在 h1。
  // 服务端按当前生效轴 h2 返回结论（hash=h2），与本页旧详情 h1 不符——
  // 旧逻辑据此无限重核；新逻辑先 GET 最新详情，指纹一致即直接接纳。
  clearVerifyState();
  state.project = proj(3, "h1");     // 本页详情仍旧
  const posts0 = verifyPostCount();
  const req = submitVerify(3, "fileX");
  respondJson(req, verifyResult(3, "h2", 2));  // 服务端已按新轴 h2 出结论
  await flush();
  assert.strictEqual(state.deliveryVerify, null, "裁决期间不得显示旧结论");
  assert.ok(state.verifyNotice.includes("最新详情"), "应提示取最新详情裁决");
  const getReq = popPending("/api/projects/3", "GET");
  assert.strictEqual(verifyPostCount(), posts0 + 1, "裁决阶段不得先重核");
  respondJson(getReq, proj(3, "h2"));          // 最新详情确为 h2
  await flush();
  assert.strictEqual(verifyPostCount(), posts0 + 1,
                     "新指纹与最新详情一致：不重核");
  assert.ok(state.deliveryVerify, "结论应按新详情接纳");
  assert.strictEqual(state.deliveryVerify.timeline_hash, "h2");
  assert.strictEqual(state.project.timeline_hash, "h2", "本页详情应刷新");
  console.log("frontend cross-tab stale detail: fetch latest + accept, no loop ok");
}

async function test_cross_tab_result_truly_stale_reverifies_once() {
  // 先在 k2 上得到有效结论。随后重新上传（新一轮 POST 在途），等待期间
  // 本页生效轴变为 k3 并 render：串行链路进行中，render 作废旧结论并挂起
  // 重核标记、不并发 POST。按 k2 算出的结果到达 → 取最新详情 k3 裁决确认
  // 过期 → 同一链路串行重核一轮后接纳（请求有界、无并发、无旧结论闪现）。
  clearVerifyState();
  state.project = proj(2, "k2");
  let req = submitVerify(2, "fileE");
  respondJson(req, verifyResult(2, "k2", 4));
  await flush();
  assert.ok(state.deliveryVerify &&
            state.deliveryVerify.timeline_hash === "k2");

  const posts0 = verifyPostCount();
  req = submitVerify(2, "fileE2");     // 再次上传，POST 在途
  state.project = proj(2, "k3");      // 等待期间本页变轴（已刷新到 k3）
  app.render();
  assert.strictEqual(verifyPostCount(), posts0 + 1,
                     "链路进行中 render 只能挂起重核，不得并发 POST");
  assert.strictEqual(state.verifyRefetch, true);
  assert.strictEqual(state.deliveryVerify, null, "旧结论应立即作废");
  respondJson(req, verifyResult(2, "k2", 4));
  await flush();
  respondJson(popPending("/api/projects/2", "GET"), proj(2, "k3"));
  await flush();
  assert.strictEqual(verifyPostCount(), posts0 + 2,
                     "裁决确认过期后串行重核一轮");
  respondJson(popPending("verify-delivery"), verifyResult(2, "k3", 4));
  await flush();
  assert.ok(state.deliveryVerify);
  assert.strictEqual(state.deliveryVerify.timeline_hash, "k3");
  assert.strictEqual(state.verifyRunning, false);
  console.log("frontend stale-on-arrival: fresh detail -> bounded re-verify ok");
}

async function test_repeated_axis_changes_stop_after_bounded_rounds() {
  // 另一标签页在每轮裁决时又改轴（服务端指纹 h2→h3→h4，始终晚于结果）：
  // 串行链路自动重核轮数有上限（初始 1 轮 + 至多 MAX 轮自动重核），触顶
  // 后停止并提示重传——不显示旧结论、请求总数有界。
  clearVerifyState();
  state.project = proj(4, "h1");
  const req1 = submitVerify(4, "fileG");
  const posts0 = verifyPostCount();   // 含本次初始 POST
  // 初始结果按 h2，但最新详情已 h3 → 重核轮 1
  respondJson(req1, verifyResult(4, "h2", 1));
  await flush();
  respondJson(popPending("/api/projects/4", "GET"), proj(4, "h3"));
  await flush();
  assert.strictEqual(verifyPostCount(), posts0 + 1,
                     "初始 POST 后裁决过期，发起第 1 轮自动重核");

  // rounds 1..MAX-1：每轮结果落后一个版本 → 串行再发下一轮。每轮响应到达
  // 前令本页详情仍旧（另一标签页持续改轴、本页来不及刷新），强制走
  // 「指纹不符 → GET 最新详情 → 确认过期 → 重核」的跨标签页裁决路径。
  for (let round = 1; round < MAX; round++) {
    const hResult = `h${round + 2}`;   // h3, ...
    const hLatest = `h${round + 3}`;  // h4, ...
    state.project = proj(4, `h${round + 1}`);   // 本页详情停在上一版
    respondJson(popPending("verify-delivery"), verifyResult(4, hResult, 1));
    await flush();
    respondJson(popPending("/api/projects/4", "GET"), proj(4, hLatest));
    await flush();
    assert.strictEqual(verifyPostCount(), posts0 + round + 1,
                       `未触顶应串行发起第 ${round + 1} 轮重核`);
  }
  // 第 MAX 轮重核结果（h(MAX+2)）到达，最新详情 h(MAX+3)，仍落后 → 触顶
  state.project = proj(4, `h${MAX + 1}`);
  respondJson(popPending("verify-delivery"),
              verifyResult(4, `h${MAX + 2}`, 1));
  await flush();
  respondJson(popPending("/api/projects/4", "GET"),
              proj(4, `h${MAX + 3}`));
  await flush();
  // 触顶：POST 总数 = 初始 1 + MAX 轮自动重核；之后不再发任何核验请求
  assert.strictEqual(verifyPostCount(), posts0 + MAX,
                     "触顶后不得继续发 POST（请求总数有界）");
  assert.ok(!pending.some((r) => r.url.includes("/api/projects/4")),
            "触顶后不得残留该项目的在途请求");
  assert.strictEqual(state.deliveryVerify, null, "触顶后不得显示旧结论");
  assert.strictEqual(state.verifyRunning, false);
  assert.ok(state.verifyNotice.includes("停止"), "应提示已停止");
  assert.ok(state.verifyNotice.includes("重新上传"), "应提示重新上传");

  // 手动重新上传恢复：新链路序号 + 轮数归零。本页详情已由最后一次裁决
  // 刷新为 h(MAX+3)，回传稿按该轴核验通过即直接接纳，无需再拉详情
  const reqManual = submitVerify(4, "fileG2");
  respondJson(reqManual, verifyResult(4, `h${MAX + 3}`, 9));
  await flush();
  assert.ok(state.deliveryVerify, "手动重传后应恢复并展示结论");
  assert.strictEqual(state.deliveryVerify.summary.pass, 9,
                     "手动重传后应恢复并展示结论");
  assert.strictEqual(state.verifyRunning, false);
  console.log("frontend repeated axis changes: bounded stop, manual reupload ok");
}

async function test_detail_refresh_failure_stops() {
  // 指纹不符后刷新最新详情失败：停止并提示重传，不重核、不显示旧结论
  clearVerifyState();
  state.project = proj(5, "h1");
  const req = submitVerify(5, "fileH");
  const posts0 = verifyPostCount();  // 含本次初始 POST；之后不得再增加
  respondJson(req, verifyResult(5, "h2", 1));
  await flush();
  const getReq = popPending("/api/projects/5", "GET");
  respondJson(getReq, { detail: "Internal Error" }, false, 500);
  await flush();
  assert.strictEqual(verifyPostCount(), posts0, "刷新失败后不得继续重核");
  assert.ok(!pending.some((r) => r.url.includes("/api/projects/5")),
            "停止后不得残留该项目在途请求");
  assert.strictEqual(state.deliveryVerify, null, "不得回退显示旧结论");
  assert.strictEqual(state.verifyRunning, false);
  assert.ok(state.verifyNotice.includes("停止"), "应提示已停止");
  assert.ok(state.verifyNotice.includes("重新上传"), "应提示重新上传");
  console.log("frontend detail refresh failure -> stop + ask reupload ok");
}

async function test_auto_reverify_failure_asks_reupload() {
  // 自动重核本身失败（如回传稿解析失败 400）：作废旧结论，有界停止并
  // 提示人工重传
  clearVerifyState();
  state.project = proj(2, "k3");
  const req = submitVerify(2, "fileF");
  respondJson(req, verifyResult(2, "k3", 2));
  await flush();
  assert.ok(state.deliveryVerify);
  state.project = proj(2, "k4");
  app.render();                        // 触发自动重核
  respondJson(popPending("verify-delivery"),
              { detail: "交付字幕解析失败：bad" }, false, 400);
  await flush();
  assert.strictEqual(state.deliveryVerify, null, "失败后不得保留旧结论");
  assert.strictEqual(state.verifyRunning, false);
  assert.ok(state.verifyNotice.includes("重新上传"), "应提示重新上传");
  console.log("frontend auto re-verify failure -> ask re-upload ok");
}

async function test_switch_during_adjudication_only_shows_current() {
  // 裁决（GET 最新详情）在途时切换项目并在新项目上传：迟到的详情返回
  // 不得把旧项目结论带回页面
  clearVerifyState();
  state.project = proj(6, "h1");
  const req = submitVerify(6, "fileI");
  respondJson(req, verifyResult(6, "h2", 1));
  await flush();
  const oldGet = popPending("/api/projects/6", "GET");
  app.resetDeliveryVerify();
  state.project = proj(7, "j1");
  const newReq = submitVerify(7, "fileJ");
  respondJson(oldGet, proj(6, "h2"));   // 旧项目裁决迟到
  await flush();
  assert.strictEqual(state.deliveryVerify, null, "旧项目裁决必须丢弃");
  respondJson(newReq, verifyResult(7, "j1", 6));
  await flush();
  assert.ok(state.deliveryVerify);
  assert.strictEqual(state.deliveryVerify.project_id, 7,
                     "只呈现当前项目最近一次有效上传的结果");
  console.log("frontend switch during adjudication keeps only current project ok");
}

async function main() {
  await test_manual_upload_binds_result();
  await test_local_timeline_change_auto_reverify();
  await test_timeline_unchanged_keeps_result();
  await test_concurrent_uploads_last_wins();
  await test_switch_project_discards_inflight();
  await test_no_file_requires_reupload();
  await test_cross_tab_stale_detail_accepts_via_fresh_detail();
  await test_cross_tab_result_truly_stale_reverifies_once();
  await test_repeated_axis_changes_stop_after_bounded_rounds();
  await test_detail_refresh_failure_stops();
  await test_auto_reverify_failure_asks_reupload();
  await test_switch_during_adjudication_only_shows_current();
  console.log("frontend delivery verify binding regression ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
