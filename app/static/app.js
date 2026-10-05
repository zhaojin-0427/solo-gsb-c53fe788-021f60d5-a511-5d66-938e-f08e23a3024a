// 字幕节奏与镜头边界校正台 —— 原生 JS 前端
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  project: null,
  deliveryVerify: null,  // 当前展示的核验结果（绑定 project_id + timeline_hash）
  verifySeq: 0,          // 单调递增的链路序号：使迟到的旧响应/刷新失效
  verifyFile: null,      // 最近一次上传稿快照：变轴后据此重核（不依赖文件输入框）
  verifyRunning: false,  // 串行核验链路是否进行中（任一时刻至多一个在途 POST）
  verifyRefetch: false,  // 链路进行中又发现变轴：当前 POST 收尾后补一轮重核
  verifyAutoRounds: 0,   // 本次上传后已自动重核的轮数（有上限，见下）
  verifyNotice: "",      // 无结果时核验区提示（裁决中 / 已作废 / 已停止）
};

// 自动重核轮数上限：另一标签页连续变轴时，「核验 → 取最新详情裁决 → 重核」
// 链路在固定请求数内必然终止；触顶即停止并提示重新上传——不显示旧结论，
// 也不会无界发请求。手动再次上传会重新计数。
const MAX_AUTO_REVERIFY = 2;

const VERIFY_LABEL = {
  pass: "通过",
  time_mismatch: "时间不符",
  missing: "缺失",
  new: "新增",
  pending: "待确认",
};

// ---------- 工具 ----------
function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function fmtMs(ms) {
  if (ms == null) return "—";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":") +
         "," + String(x).padStart(3, "0");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body instanceof FormData ? {} : {"Content-Type": "application/json"},
    ...opts,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------- 项目列表 ----------
async function loadProjects(selectId) {
  const rows = await api("/api/projects");
  const sel = $("#projectSelect");
  sel.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = ""; opt0.textContent = "— 选择历史项目 —";
  sel.appendChild(opt0);
  for (const r of rows) {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = `#${r.id} ${r.name}（${r.cue_count} 条，采纳 ${r.adopted_count}）`;
    sel.appendChild(o);
  }
}

// ---------- 渲染 ----------
const DECISION_LABEL = { intentional: "有意留白", needs_subtitle: "待补字幕" };

function renderGapReview(p) {
  const panel = $("#gapReviewPanel");
  const gr = p.gap_review;
  if (!gr || !gr.shot_count) {           // 无镜头：不生成审阅项
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  $("#gapStats").innerHTML = [
    ["留白区间", gr.total, ""],
    ["待审", gr.pending_count, gr.pending_count ? "warn" : "good"],
    ["已审", gr.total - gr.pending_count, "good"],
  ].map(([k, v, cls]) => `<span class="stat ${cls}">${k} <b>${v}</b></span>`).join("");

  const list = $("#gapList");
  list.innerHTML = "";
  const byShot = new Map();              // 相接/重叠镜头分别列出
  for (const it of gr.items) {
    const arr = byShot.get(it.shot_ord) || [];
    arr.push(it);
    byShot.set(it.shot_ord, arr);
  }
  for (const [ord, items] of byShot) {
    const box = document.createElement("div");
    box.className = "shot-gaps";
    const head = document.createElement("div");
    head.className = "shot-head";
    head.textContent = `镜头 #${ord}　${fmtMs(items[0].shot_start_ms)} → ` +
      `${fmtMs(items[0].shot_end_ms)}（${items[0].shot_start_ms} → ${items[0].shot_end_ms} ms）`;
    box.appendChild(head);
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "gap-item";
      const pill = it.decision
        ? `<span class="pill ${it.decision === "intentional" ? "intentional" : "needs-sub"}">${DECISION_LABEL[it.decision]}</span>`
        : `<span class="pill proposed">待审</span>`;
      const attrs = `data-shot="${it.shot_ord}" data-start="${it.gap_start_ms}" data-end="${it.gap_end_ms}"`;
      row.innerHTML = `
        <span class="gap-time">${fmtMs(it.gap_start_ms)} → ${fmtMs(it.gap_end_ms)}<span class="muted">${it.gap_start_ms} → ${it.gap_end_ms} ms · 时长 ${it.duration_ms} ms</span></span>
        ${pill}
        <span class="row-actions">
          <button class="mini" data-gap-act="intentional" ${attrs}>有意留白</button>
          <button class="mini" data-gap-act="needs_subtitle" ${attrs}>待补字幕</button>
          ${it.decision ? `<button class="mini" data-gap-act="clear" ${attrs}>清除</button>` : ""}
        </span>`;
      box.appendChild(row);
    }
    list.appendChild(box);
  }
}

// ---------- 交付字幕核验 ----------
// 核验结论与「项目 + 生效时间轴 + 上传先后」绑定：
// - 服务端在项目详情与核验响应中返回同一 timeline_hash（生效轴指纹）；
//   参数重算 / 采纳 / 撤销改变了生效轴后，旧结论立即作废、不得继续显示；
//   最近一次上传稿快照仍在时自动用同一稿件按新生效轴重新核验，否则提示重传。
//   生效轴未变（如仅调 CPS 上限、相同参数重提）或本页修改失败时，结论保留。
// - 指纹不符先裁决后重核：响应指纹与本页详情不符时（典型场景：另一标签页
//   改了最小间隔而本页详情仍旧），先 GET 该项目最新详情——响应指纹与最新
//   生效轴一致则直接接纳结论；确实落后于最新轴时，再用最近一次上传稿重核。
//   这样即便本页详情长期未刷新，也不会把每个新响应都误判过期而循环重核。
// - 终止条件：自动重核最多 MAX_AUTO_REVERIFY 轮；多次连续变轴触顶、详情
//   刷新失败或上传稿不可用时立即停止并提示重传，不显示旧结论、不无界请求。
// - 每次上传取递增序号 verifySeq；响应/刷新到达时若已有更新的上传、或已
//   切换项目（project_id 不符），迟到结果直接丢弃——只呈现当前项目最近一次
//   有效上传的结果。
function resetDeliveryVerify() {
  state.deliveryVerify = null;
  state.verifyFile = null;
  state.verifyRunning = false;
  state.verifyRefetch = false;
  state.verifyAutoRounds = 0;
  state.verifyNotice = "";
  state.verifySeq++;                 // 使在途的旧链路全部失效
  const f = $("#deliveryVerifyForm");
  if (f) f.reset();
}

// 本地 render() 时的同步：state.project 来自本页刚完成的写操作或历史项目，
// 先与本页指纹比对（命中则零请求保留）。跨标签页的陈旧详情不由这里兜底，
// 由响应到达后的裁决取最新详情处理，避免无据空转。
function syncDeliveryVerify() {
  const p = state.project;
  const v = state.deliveryVerify;
  if (!v) return;
  if (!p || v.project_id !== p.id) {
    // 项目已切换 / 删除（正常路径已由 resetDeliveryVerify 清理，此为防御）
    state.deliveryVerify = null;
    state.verifyNotice = "";
    return;
  }
  if (v.timeline_hash === p.timeline_hash) return;   // 生效轴未变：保留
  // 生效轴已随本页操作变化：旧结论立即作废，安排一次按最新轴的重核
  requestVerifyRefetch("生效时间轴已变化，正在用最近一次上传稿重新核验…");
}

// 链路已被更新的上传 / 切换项目 / 删除项目 / 终止动作取代
function isVerifyStale(seq, pid) {
  return seq !== state.verifySeq ||
    !state.project || state.project.id !== pid;
}

// 发现生效轴已变，要求链路再核验一轮。稿件不可读或超出自动重核轮数上限时
// 立即终止；链路在途时只置 verifyRefetch，由当前 POST 收尾后串行补发——
// 同一时刻至多一个在途 POST，绝不并发重复请求。
function requestVerifyRefetch(notice) {
  state.deliveryVerify = null;
  if (!state.verifyFile) {
    stopVerify("生效时间轴已变化，旧核验结论已作废，请重新上传回传稿。");
    return;
  }
  if (state.verifyAutoRounds >= MAX_AUTO_REVERIFY) {
    stopVerify("生效时间轴已多次变化且自动重核仍未收敛，已停止；" +
               "请重新上传回传稿后再核验。");
    return;
  }
  state.verifyNotice = notice;
  if (state.verifyRunning) {
    // 串行链路在途：POST 之后的「取最新详情 → 接纳 / 重核」由链路循环
    // 自行裁决；这里挂起标记仅覆盖「等待 POST 期间」的本地变轴，循环每轮
    // 开始裁决前复位该标记（见 runVerifyChain），避免与循环各发一次。
    state.verifyRefetch = true;
    return;
  }
  state.verifyAutoRounds++;
  runVerifyChain(state.project.id, state.verifyFile, true, state.verifySeq);
}

// 终止核验链路：不显示旧结论；推进序号使所有在途 POST / 详情刷新失效。
function stopVerify(notice) {
  state.verifySeq++;
  state.verifyRunning = false;
  state.verifyRefetch = false;
  state.deliveryVerify = null;
  state.verifyNotice = notice;
  renderDeliveryVerify();
}

// 串行核验链路：POST 一轮 → 指纹不符则取最新详情裁决 → 确属过期再按轮数
// 上限串行重核。任一时刻至多一个在途 POST，故另一标签页连续变轴时请求
// 总数有界（≤ MAX_AUTO_REVERIFY+1 个 POST 与等量详情 GET），不会循环。
async function runVerifyChain(pid, file, auto, seq) {
  state.verifyRunning = true;
  let settled = false;   // 已接纳 / 已终止：finally 不得再因挂起标记补发
  try {
    while (true) {
      if (isVerifyStale(seq, pid)) { settled = true; return; }
      const fd = new FormData();
      fd.append("delivery", file);
      let result;
      try {
        result = await api(`/api/projects/${pid}/verify-delivery`,
                           { method: "POST", body: fd });
      } catch (e) {
        if (isVerifyStale(seq, pid)) return;
        if (auto) {
          // 自动重核失败（解析失败 / 文件不可用 / 服务错误）：作废旧结论，
          // 有界终止并要求人工重传——不保留旧结论、不再自行重试
          settled = true;
          stopVerify(`自动重新核验失败：${e.message}，请重新上传回传稿。`);
        } else {
          state.verifyRunning = false;   // 手动失败：已有有效结论保持原样
          toast(e.message, true);
          settled = true;
        }
        return;
      }
      if (isVerifyStale(seq, pid) || result.project_id !== pid) {
        settled = true;
        return;
      }

      // 进入本轮裁决：是否需要再核验由下方「最新详情比对」决定。等待 POST
      // 期间 render 可能挂起的重核标记在此复位，避免与裁决各发一次。
      state.verifyRefetch = false;

      // 与本页详情一致（本页改轴或本页详情本就最新）：直接接纳，零额外请求
      if (result.timeline_hash === state.project.timeline_hash) {
        settled = true;
        acceptDeliveryResult(result);
        return;
      }
      // 指纹不符：典型为另一标签页改了最小间隔而本页详情仍旧。裁决期间
      // 也不显示可能过期的行——先 GET 该项目最新详情，再决定接纳 / 重核。
      state.deliveryVerify = null;
      state.verifyNotice = "生效时间轴指纹与本页不一致，正在获取项目最新详情裁决…";
      renderDeliveryVerify();
      let latest;
      try {
        latest = await api(`/api/projects/${pid}`);
      } catch (e) {
        if (isVerifyStale(seq, pid)) { settled = true; return; }
        // 刷新失败：停止并提示重传，不用旧结论兜底，也不继续重核
        settled = true;
        stopVerify(`无法获取项目最新详情（${e.message}），已停止自动核验；` +
                   `请检查后重新上传回传稿。`);
        toast(e.message, true);
        return;
      }
      if (isVerifyStale(seq, pid)) { settled = true; return; }
      state.project = latest;
      if (result.timeline_hash === latest.timeline_hash) {
        // 结论按【最新详情】可以接纳（变轴发生在本页详情刷新之前，响应
        // 本就基于最新轴算出）：不重核，直接呈现并把本页详情同步到最新
        settled = true;
        acceptDeliveryResult(result);
        render();
        return;
      }
      // 结论确实落后于最新生效轴：用最近一次仍可读取的上传稿串行重核，
      // 受轮数上限约束；触顶或稿件不可用则停止并提示重传，不显示旧结论。
      if (!state.verifyFile) {
        settled = true;
        stopVerify("生效时间轴已变化，旧核验结论已作废，请重新上传回传稿。");
        return;
      }
      if (state.verifyAutoRounds >= MAX_AUTO_REVERIFY) {
        settled = true;
        stopVerify("生效时间轴已多次变化且自动重核仍未收敛，已停止；" +
                   "请重新上传回传稿后再核验。");
        return;
      }
      state.verifyAutoRounds++;
      auto = true;   // 后续轮次均为自动重核，失败一律走「停止并提示重传」
      state.verifyNotice = "生效时间轴已在别处变化，正在按最新时间轴重新核验…";
      // 回到 while 顶部串行发出下一轮 POST（本帧内继续，不另起链路，因此
      // finally 不会在还有下一轮时补发）。
    }
  } finally {
    // 循环正常接纳 / 失败 / 被取代时才到这里。若等待 POST 或 GET 期间本页
    // render 又发现一次变轴并挂起 verifyRefetch（裁决循环未覆盖到的本地
    // 变轴），在同一链路序号内串行补发至多一轮，受稿件可用性与轮数上限
    // 约束；触顶 / 稿件不可用则终止提示重传。任一时刻不会有第二个在途 POST。
    if (state.verifySeq === seq) state.verifyRunning = false;
    if (settled || state.verifySeq !== seq || !state.verifyRefetch ||
        !state.project || state.project.id !== pid) return;
    state.verifyRefetch = false;
    settled = true;
    if (!state.verifyFile) {
      stopVerify("生效时间轴已变化，旧核验结论已作废，请重新上传回传稿。");
    } else if (state.verifyAutoRounds >= MAX_AUTO_REVERIFY) {
      stopVerify("生效时间轴已多次变化且自动重核仍未收敛，已停止；" +
                 "请重新上传回传稿后再核验。");
    } else {
      settled = false;   // 转交新链路：本帧的终止判定对其不适用
      state.verifyAutoRounds++;
      runVerifyChain(pid, state.verifyFile, true, seq);
    }
  }
}

function acceptDeliveryResult(result) {
  state.verifyRefetch = false;
  state.verifyRunning = false;
  state.verifyNotice = "";
  state.deliveryVerify = result;
  renderDeliveryVerify();
  const s = result.summary;
  toast(`核验完成：通过 ${s.pass} · 时间不符 ${s.time_mismatch} · ` +
        `缺失 ${s.missing} · 新增 ${s.new} · 待确认 ${s.pending}`);
}

// 提交一次核验（手动/自动入口）：在串行链路内完成裁决与可能的重核
async function runDeliveryVerify(file, auto) {
  const p = state.project;
  if (!p || !file) return;
  await runVerifyChain(p.id, file, auto, state.verifySeq);
}

function renderDeliveryVerify() {
  const v = state.deliveryVerify;
  const tb = $("#verifyTable tbody");
  const stats = $("#verifyStats");
  tb.innerHTML = "";
  if (!v) {
    stats.innerHTML = "";
    $("#deliveryName").textContent = state.verifyNotice || "";
    return;
  }
  $("#deliveryName").textContent =
    `已核验：${v.delivery_name || "交付稿"}（生效轴 ${v.reference_count} 条 / 交付 ${v.delivered_count} 条 / 同文案配对 ${v.matched_text_count} 对）`;
  const s = v.summary;
  stats.innerHTML = [
    ["通过", s.pass, "good"],
    ["时间不符", s.time_mismatch, s.time_mismatch ? "bad" : "good"],
    ["缺失", s.missing, s.missing ? "bad" : "good"],
    ["新增", s.new, s.new ? "warn" : ""],
    ["待确认", s.pending, s.pending ? "warn" : "good"],
  ].map(([k, n, cls]) => `<span class="stat ${cls}">${k} <b>${n}</b></span>`).join("");

  const cell = (ord, start, end, cls = "") => ord == null
    ? `<td class="muted">—</td>`
    : `<td class="${cls}">#${ord}<span class="muted">${start} → ${end} ms</span></td>`;

  for (const r of v.rows) {
    const tr = document.createElement("tr");
    tr.className = `verify-row verdict-${r.verdict}`;
    const pill = `<span class="pill vf-${r.verdict}">${VERIFY_LABEL[r.verdict]}</span>`;
    let body;
    if (r.kind === "match") {
      const dCls = r.verdict === "time_mismatch" || r.verdict === "pending"
        ? "vf-time" : "";
      const dTxt = (n) => (n > 0 ? "+" : "") + n;
      const deltaCls = r.delta_start_ms === 0 && r.delta_end_ms === 0
        ? "delta-zero" : "vf-time";
      const textFlag = r.text_same ? ""
        : `<div class="hash warn-text">⚠ 等优对应中文案不同，请人工核对</div>`;
      body = `
        <td>${pill}</td>
        ${cell(r.ref_ord, r.ref_start_ms, r.ref_end_ms)}
        ${cell(r.del_ord, r.del_start_ms, r.del_end_ms, dCls)}
        <td class="${deltaCls}">${dTxt(r.delta_start_ms)} / ${dTxt(r.delta_end_ms)}</td>
        <td class="text-cell">${esc(r.text)}${textFlag}</td>`;
    } else if (r.kind === "ref_only") {
      const cand = r.candidate
        ? `<div class="hash">等优候选：交付 #${cand.del_ord}
             ${cand.del_start_ms} → ${cand.del_end_ms} ms「${esc(cand.delivered_text)}」</div>`
        : "";
      body = `
        <td>${pill}</td>
        ${cell(r.ref_ord, r.ref_start_ms, r.ref_end_ms)}
        <td class="muted">—</td>
        <td class="muted">—</td>
        <td class="text-cell">${esc(r.text)}${cand}</td>`;
    } else {
      const cand = r.candidate
        ? `<div class="hash">等优候选：生效轴 #${cand.ref_ord}
             ${cand.ref_start_ms} → ${cand.ref_end_ms} ms「${esc(cand.text)}」</div>`
        : "";
      body = `
        <td>${pill}</td>
        <td class="muted">—</td>
        ${cell(r.del_ord, r.del_start_ms, r.del_end_ms)}
        <td class="muted">—</td>
        <td class="text-cell">${esc(r.delivered_text)}${cand}</td>`;
    }
    tr.innerHTML = body;
    tb.appendChild(tr);
  }
}

function render() {
  syncDeliveryVerify();   // 先按最新生效轴同步核验状态（作废/自动重核）
  const p = state.project;
  if (!p) {
    $("#workspace").classList.add("hidden");
    $("#importPanel").classList.remove("hidden");
    renderDeliveryVerify();
    return;
  }
  $("#importPanel").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#projectTitle").textContent = `#${p.id} ${p.name}`;
  const sf = $("#settingsForm");
  sf.cps_limit.value = p.cps_limit;
  sf.min_gap_ms.value = p.min_gap_ms;
  sf.tolerance_ms.value = p.tolerance_ms;

  const st = p.analysis.stats;
  $("#stats").innerHTML = [
    ["条目数", st.cue_count, ""],
    ["镜头数", st.shot_count, ""],
    ["间隔/重叠问题", st.gap_violations, st.gap_violations ? "bad" : "good"],
    ["CPS 超限", st.cps_violations, st.cps_violations ? "bad" : "good"],
    ["跨镜头条目", st.cross_shot_count, st.cross_shot_count ? "bad" : "good"],
    ["可提案条目", st.proposal_count, "good"],
    ["需移动条目", st.proposal_moved_count, "warn"],
    ["冲突条目", st.conflict_cue_count, st.conflict_cue_count ? "bad" : "good"],
    ["总移动量", st.total_shift_ms + " ms", ""],
  ].map(([k, v, cls]) => `<span class="stat ${cls}">${k} <b>${v}</b></span>`).join("");

  const conf = $("#conflicts");
  conf.innerHTML = "";
  for (const ch of p.analysis.chains) {
    const div = document.createElement("div");
    div.className = "chain";
    div.innerHTML = `<span class="tag">冲突链 ${ch.cue_ids.join(" → ")}</span>${esc(ch.reason)}`;
    conf.appendChild(div);
  }
  for (const it of p.analysis.intrinsic) {
    const div = document.createElement("div");
    div.className = "chain intrinsic";
    div.innerHTML = `<span class="tag">内在冲突 · ${esc(it.cue_id)}</span>${esc(it.reason)}`;
    conf.appendChild(div);
  }

  const tb = $("#cueTable tbody");
  tb.innerHTML = "";
  for (const c of p.analysis.cues) {
    const tr = document.createElement("tr");
    const flags = [];
    if (c.overlap_with) flags.push(`<span class="flag gap" title="${esc(c.overlap_with)}">间隔</span>`);
    if (!c.cps_ok) flags.push(`<span class="flag" title="CPS ${c.cps} 超限">CPS ${c.cps}</span>`);
    if (c.cross_shot) flags.push(`<span class="flag cross">跨镜头</span>`);

    const propTxt = c.proposal_start_ms == null ? "—（无解）"
      : `${c.proposal_start_ms} → ${c.proposal_end_ms}`;
    let deltaCls = "delta-zero", dTxt = "—";
    if (c.proposal_start_ms != null) {
      const d = c.proposal_start_ms - c.start_ms;
      dTxt = (d > 0 ? "+" : "") + d + " ms";
      deltaCls = d === 0 ? "delta-zero" : "delta-pos";
    }
    let status;
    if (c.adopted) {
      status = `<span class="pill adopted">已采纳</span>`;
    } else if (c.proposal_start_ms != null) {
      status = `<span class="pill proposed">待采纳</span>`;
    } else {
      status = `<span class="pill conflict">冲突</span>`;
    }
    const canAdopt = c.proposal_start_ms != null;
    const actionBtns = `
      <div class="row-actions">
        ${canAdopt ? `<button class="mini primary" data-act="adopt" data-uid="${c.uid}">采纳</button>` : ""}
        ${c.adopted ? `<button class="mini" data-act="revert" data-uid="${c.uid}">撤销</button>` : ""}
      </div>`;
    const startShown = c.adopted_start_ms ?? c.start_ms;
    const endShown = c.adopted_end_ms ?? c.end_ms;
    tr.className = c.proposal_start_ms == null ? "row-bad" : "";
    tr.innerHTML = `
      <td>${c.ord}</td>
      <td>${esc(c.cue_id)}</td>
      <td class="text-cell">${esc(c.text)}<div class="hash">sha256:${c.raw_hash.slice(0, 16)}…</div></td>
      <td>${startShown} → ${endShown}</td>
      <td>${c.duration_ms}</td>
      <td>${c.graphemes}</td>
      <td class="${c.cps_ok ? "cps-ok" : "cps-bad"}">${c.cps === Infinity ? "∞" : c.cps}</td>
      <td>${flags.join("") || "—"}</td>
      <td>${propTxt}</td>
      <td class="${deltaCls}">${dTxt}</td>
      <td>${status}${actionBtns}</td>`;
    tb.appendChild(tr);
  }

  const base = `/api/projects/${p.id}/export`;
  $("#exportJson").href = base + "?fmt=json";
  $("#exportZip").href = base + "?fmt=zip";
  $("#exportSrt").href = base + "?fmt=srt";
  $("#projectSelect").value = String(p.id);
  renderGapReview(p);
  renderDeliveryVerify();
}

// 采纳可能因另一标签页并发改参数而被拒（旧提案失效）：重新拉取详情，
// 让表格与统计条回到服务端的最新一致状态。
async function refreshAfterConflict(pid) {
  try {
    state.project = await api(`/api/projects/${pid}`);
    render();
    loadProjects();
  } catch (_) {}
}

// ---------- 事件 ----------
$("#importForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const fd = new FormData();
  fd.append("name", f.name.value.trim() || "未命名项目");
  fd.append("cps_limit", f.cps_limit.value);
  fd.append("min_gap_ms", f.min_gap_ms.value);
  fd.append("tolerance_ms", f.tolerance_ms.value);
  fd.append("subtitle", f.subtitle.files[0]);
  if (f.shots_file.files[0]) fd.append("shots_file", f.shots_file.files[0]);
  try {
    state.project = await api("/api/projects", { method: "POST", body: fd });
    resetDeliveryVerify();
    toast("导入并分析完成");
    await loadProjects();
    render();
  } catch (e) { toast(e.message, true); }
});

$("#settingsForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!state.project) return;
  const f = ev.target;
  try {
    state.project = await api(`/api/projects/${state.project.id}/settings`, {
      method: "PUT",
      body: JSON.stringify({
        cps_limit: parseFloat(f.cps_limit.value),
        min_gap_ms: parseInt(f.min_gap_ms.value, 10),
        tolerance_ms: parseInt(f.tolerance_ms.value, 10),
      }),
    });
    toast("已按新参数重新求解");
    render();
    loadProjects();
  } catch (e) { toast(e.message, true); }
});

$("#cueTable").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn || !state.project) return;
  const uid = parseInt(btn.dataset.uid, 10);
  const c = state.project.analysis.cues.find(x => x.uid === uid);
  const pid = state.project.id;
  try {
    if (btn.dataset.act === "adopt") {
      state.project = await api(`/api/projects/${pid}/adopt`, {
        method: "POST",
        body: JSON.stringify({
          cue_uid: uid,
          new_start_ms: c.proposal_start_ms,
          new_end_ms: c.proposal_end_ms,
        }),
      });
      toast(`已采纳 cue ${c.cue_id}`);
    } else {
      state.project = await api(`/api/projects/${pid}/adopt/${uid}`,
                                { method: "DELETE" });
      toast(`已撤销 cue ${c.cue_id}`);
    }
    render();
    loadProjects();
  } catch (e) {
    toast(e.message + "（参数可能已在别处更新，已刷新）", true);
    refreshAfterConflict(pid);
  }
});

$("#adoptAllBtn").addEventListener("click", async () => {
  if (!state.project) return;
  const todo = state.project.analysis.cues.filter(
    c => c.proposal_start_ms != null && !c.adopted);
  if (!todo.length) return toast("没有可采纳的提案");
  try {
    let p = state.project;
    for (const c of todo) {
      p = await api(`/api/projects/${p.id}/adopt`, {
        method: "POST",
        body: JSON.stringify({
          cue_uid: c.uid,
          new_start_ms: c.proposal_start_ms,
          new_end_ms: c.proposal_end_ms,
        }),
      });
    }
    state.project = p;
    toast(`已批量采纳 ${todo.length} 条`);
    render();
    loadProjects();
  } catch (e) {
    toast(e.message + "（参数可能已在别处更新，已刷新）", true);
    refreshAfterConflict(state.project.id);
  }
});

// 镜头留白审阅：标记 / 清除。过期页面（参数或采纳已在别处变化）提交的
// 结论会被服务端 400 拒绝，此时刷新到最新状态，避免误标新留白。
$("#gapList").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-gap-act]");
  if (!btn || !state.project) return;
  const pid = state.project.id;
  const shotOrd = parseInt(btn.dataset.shot, 10);
  const gapStart = parseInt(btn.dataset.start, 10);
  const gapEnd = parseInt(btn.dataset.end, 10);
  const act = btn.dataset.gapAct;
  try {
    if (act === "clear") {
      const q = `shot_ord=${shotOrd}&gap_start_ms=${gapStart}&gap_end_ms=${gapEnd}`;
      state.project = await api(`/api/projects/${pid}/gaps/review?${q}`,
                                { method: "DELETE" });
      toast("已清除审阅标记，回到待审");
    } else {
      state.project = await api(`/api/projects/${pid}/gaps/review`, {
        method: "POST",
        body: JSON.stringify({
          shot_ord: shotOrd, gap_start_ms: gapStart,
          gap_end_ms: gapEnd, decision: act,
        }),
      });
      toast(`已标记为「${DECISION_LABEL[act]}」`);
    }
    render();
  } catch (e) {
    toast(e.message + "（留白已随参数/采纳变化，已刷新）", true);
    refreshAfterConflict(pid);
  }
});

// 交付字幕核验：上传回传稿，服务端保序最优对应后返回逐行结论。
// 只读核验，失败（空稿/解析失败）仅弹错，不影响当前项目数据与已展示结论。
// 上传稿留存快照（state.verifyFile）：变轴后自动重核不依赖文件输入框。
$("#deliveryVerifyForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!state.project) return;
  const file = ev.target.delivery.files[0];
  if (!file) return;
  state.verifySeq++;                 // 新上传：使在途旧链路全部失效
  state.verifyFile = file;
  state.verifyRunning = false;       // 新链路接管
  state.verifyRefetch = false;
  state.verifyAutoRounds = 0;        // 新的一次有效上传，自动重核计数归零
  state.verifyNotice = "";
  renderDeliveryVerify();
  await runVerifyChain(state.project.id, file, false, state.verifySeq);
});

$("#deleteProjectBtn").addEventListener("click", async () => {  if (!state.project) return;
  if (!confirm(`确定删除项目「${state.project.name}」？该操作不可恢复。`)) return;
  try {
    await api(`/api/projects/${state.project.id}`, { method: "DELETE" });
    state.project = null;
    resetDeliveryVerify();
    toast("项目已删除");
    await loadProjects();
    render();
  } catch (e) { toast(e.message, true); }
});

$("#projectSelect").addEventListener("change", async (ev) => {
  const id = ev.target.value;
  if (!id) return;
  resetDeliveryVerify();   // 先作废旧项目核验并使在途响应失效，再切换
  try {
    state.project = await api(`/api/projects/${id}`);
    render();
  } catch (e) { toast(e.message, true); }
});

$("#newProjectBtn").addEventListener("click", () => {
  state.project = null;
  resetDeliveryVerify();
  $("#projectSelect").value = "";
  render();
});

// 初始化
loadProjects().catch(() => {});
