import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, promises as fs, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "work", "app-data");
const uploadDir = join(dataDir, "uploads");
const localDataPath = join(dataDir, "records.json");

for (const dir of [dataDir, uploadDir]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

loadEnv(join(__dirname, ".env"));

const config = {
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || "127.0.0.1",
  appAccessCode: process.env.APP_ACCESS_CODE || "",
  storageMode: process.env.STORAGE_MODE || "local",
  larkSyncMode: process.env.LARK_SYNC_MODE || "cli",
  larkAs: process.env.LARK_AS || "user",
  larkAppId: process.env.LARK_APP_ID || "",
  larkAppSecret: process.env.LARK_APP_SECRET || "",
  baseToken: process.env.LARK_BASE_TOKEN || "",
  checkinTableId: process.env.LARK_CHECKIN_TABLE_ID || "",
  weightTableId: process.env.LARK_WEIGHT_TABLE_ID || "",
  photoFieldId: process.env.LARK_CHECKIN_PHOTO_FIELD_ID || "",
  fields: {
    member: process.env.LARK_FIELD_MEMBER || "成员",
    checkinDate: process.env.LARK_FIELD_CHECKIN_DATE || "打卡日期",
    checkinTime: process.env.LARK_FIELD_CHECKIN_TIME || "打卡时间",
    activity: process.env.LARK_FIELD_ACTIVITY || "打卡形式",
    duration: process.env.LARK_FIELD_DURATION || "运动时长_分钟",
    distance: process.env.LARK_FIELD_DISTANCE || "运动距离_公里",
    intensity: process.env.LARK_FIELD_INTENSITY || "强度",
    note: process.env.LARK_FIELD_NOTE || "备注",
    photo: process.env.LARK_FIELD_PHOTO || "打卡照片",
    month: process.env.LARK_FIELD_MONTH || "月份",
    weightPeriod: process.env.LARK_FIELD_WEIGHT_PERIOD || "记录类型",
    weightKg: process.env.LARK_FIELD_WEIGHT_KG || "体重_公斤",
    weightTime: process.env.LARK_FIELD_WEIGHT_TIME || "测量时间"
  }
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, {
        ok: true,
        storageMode: config.storageMode,
        larkSyncMode: config.larkSyncMode,
        larkConfigured: Boolean(config.baseToken && config.checkinTableId && config.weightTableId),
        accessCodeRequired: Boolean(config.appAccessCode)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/checkins") {
      const body = await readMultipart(req);
      requireAccess(body.accessCode);
      const record = normalizeCheckin(body);
      await saveLocal("checkins", record);
      let lark = null;
      if (config.storageMode === "lark") lark = await writeCheckinToLark(record);
      return sendJson(res, { ok: true, record, lark });
    }

    if (req.method === "POST" && url.pathname === "/api/weights") {
      const body = await readJson(req);
      requireAccess(body.accessCode);
      const record = normalizeWeight(body);
      await saveLocal("weights", record);
      let lark = null;
      if (config.storageMode === "lark") lark = await writeWeightToLark(record);
      return sendJson(res, { ok: true, record, lark });
    }

    if (req.method === "GET" && url.pathname === "/api/summary") {
      requireAccess(url.searchParams.get("accessCode"));
      const weekStart = url.searchParams.get("weekStart");
      const data = await loadDataForSummary();
      return sendJson(res, buildSummary(data, weekStart));
    }

    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      const filePath = resolve(uploadDir, url.pathname.replace("/uploads/", ""));
      if (!filePath.startsWith(uploadDir)) return send(res, 403, "Forbidden");
      return streamFile(res, filePath);
    }

    if (req.method === "GET") {
      const fileName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = resolve(publicDir, fileName);
      if (!filePath.startsWith(publicDir)) return send(res, 403, "Forbidden");
      return streamFile(res, filePath);
    }

    send(res, 404, "Not found");
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, error.status || 500);
  }
});

server.listen(config.port, config.host, () => {
  const host = config.host === "0.0.0.0" ? "localhost" : config.host;
  console.log(`Fitness check-in site running at http://${host}:${config.port}`);
});

function loadEnv(path) {
  if (!existsSync(path)) return;
  const content = String(readFileSyncSafe(path));
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=");
  }
}

function readFileSyncSafe(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res, payload, status = 200) {
  send(res, status, JSON.stringify(payload, null, 2), "application/json; charset=utf-8");
}

function streamFile(res, filePath) {
  if (!existsSync(filePath)) return send(res, 404, "Not found");
  const type = mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(filePath).pipe(res);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function readMultipart(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const boundary = req.headers["content-type"]?.match(/boundary=(.+)$/)?.[1];
  if (!boundary) throw new Error("Missing multipart boundary.");

  const result = {};
  const parts = buffer.toString("binary").split(`--${boundary}`).slice(1, -1);
  for (const part of parts) {
    const [headerBlock, rawBody] = part.split("\r\n\r\n");
    if (!rawBody) continue;
    const name = headerBlock.match(/name="([^"]+)"/)?.[1];
    const filename = headerBlock.match(/filename="([^"]*)"/)?.[1];
    if (!name) continue;
    const valueBinary = rawBody.slice(0, -2);
    if (filename) {
      if (!filename || valueBinary.length === 0) continue;
      const safeName = filename.replace(/[^\w.-]/g, "_");
      const savedName = `${Date.now()}-${randomUUID()}-${safeName}`;
      const savedPath = join(uploadDir, savedName);
      await fs.writeFile(savedPath, Buffer.from(valueBinary, "binary"));
      result[name] = {
        originalName: filename,
        path: savedPath,
        url: `/uploads/${savedName}`
      };
    } else {
      result[name] = Buffer.from(valueBinary, "binary").toString("utf8");
    }
  }
  return result;
}

function normalizeCheckin(body) {
  const now = new Date();
  const date = body.date || now.toISOString().slice(0, 10);
  const time = body.time || now.toTimeString().slice(0, 5);
  return {
    id: randomUUID(),
    createdAt: now.toISOString(),
    member: required(body.member, "成员"),
    date,
    time,
    activity: body.activity || "其他",
    duration: numberOrNull(body.duration),
    distance: numberOrNull(body.distance),
    intensity: body.intensity || "适中",
    note: body.note || "",
    photo: body.photo || null
  };
}

function normalizeWeight(body) {
  const now = new Date();
  const month = body.month || now.toISOString().slice(0, 7);
  return {
    id: randomUUID(),
    createdAt: now.toISOString(),
    member: required(body.member, "成员"),
    month,
    period: body.period === "end" ? "月末" : "月初",
    weightKg: Number(body.weightKg),
    measuredAt: body.measuredAt || `${month}-01T08:00`,
    note: body.note || ""
  };
}

function required(value, label) {
  const cleaned = String(value || "").trim();
  if (!cleaned) throw new Error(`${label}不能为空。`);
  return cleaned;
}

function requireAccess(value) {
  if (!config.appAccessCode) return;
  if (String(value || "") === config.appAccessCode) return;
  const error = new Error("活动口令不正确。");
  error.status = 403;
  throw error;
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function loadLocal() {
  if (!existsSync(localDataPath)) return { checkins: [], weights: [] };
  return JSON.parse(await fs.readFile(localDataPath, "utf8"));
}

async function saveLocal(type, record) {
  const data = await loadLocal();
  data[type] = data[type] || [];
  data[type].push(record);
  await fs.writeFile(localDataPath, JSON.stringify(data, null, 2));
}

async function loadDataForSummary() {
  if (config.storageMode === "lark" && config.larkSyncMode === "openapi") {
    return loadLarkSummaryData();
  }
  return loadLocal();
}

function buildSummary(data, requestedWeekStart) {
  const today = new Date();
  const weekStart = requestedWeekStart || localDate(startOfWeek(today));
  const weekEnd = localDate(addDays(parseLocalDate(weekStart), 6));
  const checkins = data.checkins.filter((item) => item.date >= weekStart && item.date <= weekEnd);
  const members = Array.from(new Set([...data.checkins.map((item) => item.member), ...data.weights.map((item) => item.member)])).sort();
  const byMember = members.map((member) => {
    const rows = checkins.filter((item) => item.member === member);
    return {
      member,
      count: rows.length,
      duration: sum(rows, "duration"),
      distance: sum(rows, "distance"),
      activeDays: new Set(rows.map((item) => item.date)).size
    };
  }).sort((a, b) => b.count - a.count || b.duration - a.duration);

  const missing = members.filter((member) => !checkins.some((item) => item.member === member));
  const monthlyLoss = buildMonthlyLoss(data.weights);

  return {
    weekStart,
    weekEnd,
    totals: {
      checkins: checkins.length,
      duration: sum(checkins, "duration"),
      distance: sum(checkins, "distance"),
      members: members.length
    },
    byMember,
    missing,
    latestCheckins: checkins.slice(-8).reverse(),
    monthlyLoss
  };
}

function buildMonthlyLoss(weights) {
  const groups = new Map();
  for (const row of weights) {
    const key = `${row.month}::${row.member}`;
    if (!groups.has(key)) groups.set(key, { month: row.month, member: row.member, start: null, end: null });
    const target = groups.get(key);
    if (row.period === "月初") target.start = row.weightKg;
    if (row.period === "月末") target.end = row.weightKg;
  }
  return Array.from(groups.values()).map((row) => ({
    ...row,
    loss: row.start !== null && row.end !== null ? Number((row.start - row.end).toFixed(1)) : null
  })).sort((a, b) => b.month.localeCompare(a.month) || a.member.localeCompare(b.member));
}

function sum(rows, key) {
  return Number(rows.reduce((total, row) => total + (Number(row[key]) || 0), 0).toFixed(2));
}

function startOfWeek(date) {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function parseLocalDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function larkExec(args) {
  return new Promise((resolvePromise, reject) => {
    execFile("lark-cli", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || stdout || error.message));
      try {
        resolvePromise(stdout ? JSON.parse(stdout) : {});
      } catch {
        resolvePromise({ raw: stdout });
      }
    });
  });
}

async function writeCheckinToLark(record) {
  assertLarkReady(config.checkinTableId);
  const fields = config.fields;
  const payload = {
    [fields.member]: record.member,
    [fields.checkinDate]: `${record.date} 00:00:00`,
    [fields.checkinTime]: `${record.date} ${record.time}:00`,
    [fields.activity]: record.activity,
    [fields.duration]: record.duration,
    [fields.distance]: record.distance,
    [fields.intensity]: record.intensity,
    [fields.note]: record.note
  };
  if (config.larkSyncMode === "openapi") {
    const created = await larkCreateRecord(config.checkinTableId, payload);
    return {
      created,
      attachment: null,
      photoNote: record.photo ? "OpenAPI cloud mode saved the form record; Feishu attachment upload is not enabled yet." : null
    };
  }

  const created = await larkExec([
    "base",
    "+record-upsert",
    "--base-token",
    config.baseToken,
    "--table-id",
    config.checkinTableId,
    "--json",
    JSON.stringify(payload),
    "--as",
    config.larkAs
  ]);
  const recordId = created.record?.record_id || created.data?.record?.record_id || created.record_id;
  let attachment = null;
  if (record.photo?.path && recordId) {
    const fieldId = config.photoFieldId || await findFieldId(config.checkinTableId, fields.photo);
    attachment = await larkExec([
      "base",
      "+record-upload-attachment",
      "--base-token",
      config.baseToken,
      "--table-id",
      config.checkinTableId,
      "--record-id",
      recordId,
      "--field-id",
      fieldId,
      "--file",
      record.photo.path,
      "--as",
      config.larkAs
    ]);
  }
  return { created, attachment };
}

async function writeWeightToLark(record) {
  assertLarkReady(config.weightTableId);
  const fields = config.fields;
  const payload = {
    [fields.member]: record.member,
    [fields.month]: record.month,
    [fields.weightPeriod]: record.period,
    [fields.weightKg]: record.weightKg,
    [fields.weightTime]: record.measuredAt.replace("T", " ") + ":00",
    [fields.note]: record.note
  };
  if (config.larkSyncMode === "openapi") {
    return larkCreateRecord(config.weightTableId, payload);
  }

  return larkExec([
    "base",
    "+record-upsert",
    "--base-token",
    config.baseToken,
    "--table-id",
    config.weightTableId,
    "--json",
    JSON.stringify(payload),
    "--as",
    config.larkAs
  ]);
}

function assertLarkReady(tableId) {
  if (!config.baseToken || !tableId) {
    throw new Error("飞书多维表格还没有配置完整。请先填写 LARK_BASE_TOKEN 和表 ID。");
  }
  if (config.larkSyncMode === "openapi" && (!config.larkAppId || !config.larkAppSecret)) {
    throw new Error("OpenAPI 模式还没有配置飞书应用的 LARK_APP_ID 和 LARK_APP_SECRET。");
  }
}

async function findFieldId(tableId, fieldName) {
  const result = await larkExec([
    "base",
    "+field-list",
    "--base-token",
    config.baseToken,
    "--table-id",
    tableId,
    "--limit",
    "100",
    "--as",
    config.larkAs
  ]);
  const fields = result.items || result.fields || result.data?.items || result.data?.fields || [];
  const field = fields.find((item) => item.field_name === fieldName || item.name === fieldName);
  if (!field) throw new Error(`找不到附件字段：${fieldName}`);
  return field.field_id || field.id;
}

let larkTokenCache = {
  token: "",
  expiresAt: 0
};

async function getTenantAccessToken() {
  if (larkTokenCache.token && Date.now() < larkTokenCache.expiresAt - 60_000) {
    return larkTokenCache.token;
  }

  const result = await larkFetch("/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: {
      app_id: config.larkAppId,
      app_secret: config.larkAppSecret
    },
    auth: false
  });
  const token = result.tenant_access_token;
  if (!token) throw new Error("飞书没有返回 tenant_access_token，请检查应用凭据。");
  larkTokenCache = {
    token,
    expiresAt: Date.now() + Number(result.expire || 7200) * 1000
  };
  return token;
}

async function larkCreateRecord(tableId, fields) {
  return larkFetch(`/open-apis/bitable/v1/apps/${config.baseToken}/tables/${tableId}/records`, {
    method: "POST",
    body: { fields }
  });
}

async function larkListRecords(tableId) {
  const records = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);
    const result = await larkFetch(`/open-apis/bitable/v1/apps/${config.baseToken}/tables/${tableId}/records?${params.toString()}`, {
      method: "GET"
    });
    records.push(...(result.data?.items || []));
    pageToken = result.data?.page_token || "";
    if (!result.data?.has_more) pageToken = "";
  } while (pageToken);
  return records;
}

async function loadLarkSummaryData() {
  assertLarkReady(config.checkinTableId);
  assertLarkReady(config.weightTableId);
  const [checkinRecords, weightRecords] = await Promise.all([
    larkListRecords(config.checkinTableId),
    larkListRecords(config.weightTableId)
  ]);
  return {
    checkins: checkinRecords.map((row) => {
      const fields = row.fields || {};
      const checkinTime = toLocalDateTimeString(fields[config.fields.checkinTime]);
      return {
        id: row.record_id,
        member: textValue(fields[config.fields.member]),
        date: toLocalDateString(fields[config.fields.checkinDate]),
        time: checkinTime.slice(11, 16) || "00:00",
        activity: textValue(fields[config.fields.activity]) || "其他",
        duration: numberOrNull(fields[config.fields.duration]),
        distance: numberOrNull(fields[config.fields.distance]),
        intensity: textValue(fields[config.fields.intensity]) || "适中",
        note: textValue(fields[config.fields.note]),
        photo: null
      };
    }).filter((row) => row.member && row.date),
    weights: weightRecords.map((row) => {
      const fields = row.fields || {};
      return {
        id: row.record_id,
        member: textValue(fields[config.fields.member]),
        month: textValue(fields[config.fields.month]),
        period: textValue(fields[config.fields.weightPeriod]),
        weightKg: Number(fields[config.fields.weightKg]),
        measuredAt: toLocalDateTimeString(fields[config.fields.weightTime]),
        note: textValue(fields[config.fields.note])
      };
    }).filter((row) => row.member && row.month)
  };
}

async function larkFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8"
  };
  if (options.auth !== false) {
    headers.Authorization = `Bearer ${await getTenantAccessToken()}`;
  }
  const res = await fetch(`https://open.feishu.cn${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  if (!res.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(data.msg || data.message || `飞书 OpenAPI 请求失败：${res.status}`);
  }
  return data;
}

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((item) => textValue(item)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    return value.text || value.name || value.value || value.id || "";
  }
  return String(value);
}

function toLocalDateString(value) {
  const text = toLocalDateTimeString(value);
  return text.slice(0, 10);
}

function toLocalDateTimeString(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return localDateTime(new Date(value));
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return localDateTime(new Date(Number(value)));
    return value.replace("T", " ").slice(0, 16);
  }
  return textValue(value);
}

function localDateTime(date) {
  if (Number.isNaN(date.getTime())) return "";
  return `${localDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
