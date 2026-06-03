const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const checkinForm = document.querySelector("#checkinForm");
const weightForm = document.querySelector("#weightForm");
const statusText = document.querySelector("#statusText");
const toast = document.querySelector("#toast");
const accessCodeWrap = document.querySelector("#accessCodeWrap");
const accessCodeInput = document.querySelector("#accessCode");

const today = new Date();
const todayDate = today.toISOString().slice(0, 10);
const currentMonth = today.toISOString().slice(0, 7);

checkinForm.date.value = todayDate;
checkinForm.time.value = today.toTimeString().slice(0, 5);
weightForm.month.value = currentMonth;
weightForm.measuredAt.value = toLocalDateTime(today);
document.querySelector("#weekStart").value = startOfWeek(today);
accessCodeInput.value = localStorage.getItem("fitnessAccessCode") || "";
accessCodeInput.addEventListener("input", () => {
  localStorage.setItem("fitnessAccessCode", accessCodeInput.value);
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((item) => item.classList.remove("active"));
    panels.forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "report") refreshReport();
  });
});

checkinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(checkinForm);
  formData.append("accessCode", accessCodeInput.value);
  await submit("/api/checkins", {
    method: "POST",
    body: formData
  }, "打卡已提交");
  checkinForm.reset();
  checkinForm.date.value = todayDate;
  checkinForm.time.value = new Date().toTimeString().slice(0, 5);
});

weightForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submit("/api/weights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...Object.fromEntries(new FormData(weightForm)),
      accessCode: accessCodeInput.value
    })
  }, "体重已保存");
});

document.querySelector("#refreshReport").addEventListener("click", refreshReport);
document.querySelector("#weekStart").addEventListener("change", refreshReport);

await refreshStatus();
await refreshReport();

async function refreshStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  statusText.textContent = data.storageMode === "lark" && data.larkConfigured
    ? "已连接飞书多维表格"
    : "本地预览模式，配置飞书后会自动同步";
  accessCodeWrap.hidden = !data.accessCodeRequired;
}

async function submit(url, options, message) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!data.ok) throwToast(data.error || "提交失败");
  else {
    showToast(message);
    await refreshReport();
  }
}

async function refreshReport() {
  const weekStart = document.querySelector("#weekStart").value;
  const params = new URLSearchParams({
    weekStart,
    accessCode: accessCodeInput.value
  });
  const res = await fetch(`/api/summary?${params.toString()}`);
  const data = await res.json();
  if (!data.totals) {
    showToast(data.error || "周报读取失败");
    return;
  }
  document.querySelector("#totalCheckins").textContent = data.totals.checkins;
  document.querySelector("#totalDuration").textContent = data.totals.duration;
  document.querySelector("#totalDistance").textContent = data.totals.distance;
  document.querySelector("#totalMembers").textContent = data.totals.members;

  renderRows("#memberRows", data.byMember, (row) => `
    <div>
      <strong>${escapeHtml(row.member)}</strong>
      <small>${row.activeDays} 天活跃 · ${row.duration} 分钟 · ${row.distance} 公里</small>
    </div>
    <strong>${row.count} 次</strong>
  `);

  renderRows("#lossRows", data.monthlyLoss, (row) => `
    <div>
      <strong>${escapeHtml(row.member)} · ${escapeHtml(row.month)}</strong>
      <small>月初 ${fmt(row.start)} kg · 月末 ${fmt(row.end)} kg</small>
    </div>
    <strong>${row.loss === null ? "待补齐" : `${row.loss} kg`}</strong>
  `);

  renderRows("#latestRows", data.latestCheckins, (row) => `
    <div>
      <strong>${escapeHtml(row.member)} · ${escapeHtml(row.activity)}</strong>
      <small>${escapeHtml(row.date)} ${escapeHtml(row.time)} · ${row.duration || 0} 分钟</small>
    </div>
    <strong>${row.distance || 0} km</strong>
  `);

  renderRows("#missingRows", data.missing.map((member) => ({ member })), (row) => `
    <div>
      <strong>${escapeHtml(row.member)}</strong>
      <small>本周暂未提交打卡</small>
    </div>
  `);
}

function renderRows(selector, rows, render) {
  const el = document.querySelector(selector);
  if (!rows.length) {
    el.innerHTML = `<div class="empty">暂无数据</div>`;
    return;
  }
  el.innerHTML = rows.map((row) => `<article class="row">${render(row)}</article>`).join("");
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function throwToast(message) {
  showToast(message);
  throw new Error(message);
}

function startOfWeek(date) {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return localDate(copy);
}

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toLocalDateTime(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function fmt(value) {
  return value === null || value === undefined ? "-" : value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}
