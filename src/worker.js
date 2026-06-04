export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/api/status" && request.method === "GET") {
        return json({
          ok: true,
          storageMode: "lark",
          larkSyncMode: "openapi",
          larkConfigured: Boolean(env.LARK_BASE_TOKEN && env.LARK_CHECKIN_TABLE_ID && env.LARK_WEIGHT_TABLE_ID),
          accessCodeRequired: Boolean(env.APP_ACCESS_CODE)
        });
      }

      if (url.pathname === "/api/checkins" && request.method === "POST") {
        const form = await request.formData();
        requireAccess(env, form.get("accessCode"));
        const record = normalizeCheckin(form);
        const fields = larkFields(env);
        const attachment = await uploadCheckinPhoto(env, form.get("photo"));
        const payload = {
          [fields.member]: record.member,
          [fields.checkinDate]: feishuDateTime(record.date, "00:00"),
          [fields.checkinTime]: feishuDateTime(record.date, record.time),
          [fields.activity]: record.activity,
          [fields.duration]: record.duration,
          [fields.distance]: record.distance,
          [fields.intensity]: record.intensity,
          [fields.note]: record.note
        };
        if (attachment?.fileToken) {
          payload[fields.photo] = [{ file_token: attachment.fileToken }];
          record.photo = { name: attachment.fileName };
        }
        const created = await larkCreateRecord(env, env.LARK_CHECKIN_TABLE_ID, payload);
        return json({ ok: true, record, lark: { created, attachment } });
      }

      if (url.pathname === "/api/weights" && request.method === "POST") {
        const body = await request.json();
        requireAccess(env, body.accessCode);
        const record = normalizeWeight(body);
        const fields = larkFields(env);
        const payload = {
          [fields.member]: record.member,
          [fields.month]: record.month,
          [fields.weightPeriod]: record.period,
          [fields.weightKg]: record.weightKg,
          [fields.weightTime]: feishuDateTimeFromInput(record.measuredAt),
          [fields.note]: record.note
        };
        const created = await larkCreateRecord(env, env.LARK_WEIGHT_TABLE_ID, payload);
        return json({ ok: true, record, lark: created });
      }

      if (url.pathname === "/api/summary" && request.method === "GET") {
        requireAccess(env, url.searchParams.get("accessCode"));
        const data = await loadLarkSummaryData(env);
        return json(buildSummary(data, url.searchParams.get("weekStart")));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ ok: false, error: error.message }, error.status || 500);
    }
  }
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function requireAccess(env, value) {
  if (!env.APP_ACCESS_CODE) return;
  if (String(value || "") === env.APP_ACCESS_CODE) return;
  const error = new Error("活动口令不正确。");
  error.status = 403;
  throw error;
}

function normalizeCheckin(form) {
  const now = new Date();
  const date = String(form.get("date") || now.toISOString().slice(0, 10));
  const time = String(form.get("time") || "00:00");
  return {
    id: crypto.randomUUID(),
    createdAt: now.toISOString(),
    member: required(form.get("member"), "成员"),
    date,
    time,
    activity: String(form.get("activity") || "其他"),
    duration: numberOrNull(form.get("duration")),
    distance: numberOrNull(form.get("distance")),
    intensity: String(form.get("intensity") || "适中"),
    note: String(form.get("note") || ""),
    photo: null
  };
}

function normalizeWeight(body) {
  const now = new Date();
  const month = body.month || now.toISOString().slice(0, 7);
  return {
    id: crypto.randomUUID(),
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

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function feishuDateTime(date, time) {
  const [year, month, day] = String(date).split("-").map(Number);
  const [hour, minute] = String(time || "00:00").split(":").map(Number);
  return Date.UTC(year, month - 1, day, (hour || 0) - 8, minute || 0, 0);
}

function feishuDateTimeFromInput(value) {
  const [date, time = "00:00"] = String(value || "").replace("T", " ").split(" ");
  return feishuDateTime(date, time.slice(0, 5));
}

function larkFields(env) {
  return {
    member: env.LARK_FIELD_MEMBER || "成员",
    checkinDate: env.LARK_FIELD_CHECKIN_DATE || "打卡日期",
    checkinTime: env.LARK_FIELD_CHECKIN_TIME || "打卡时间",
    activity: env.LARK_FIELD_ACTIVITY || "打卡形式",
    duration: env.LARK_FIELD_DURATION || "运动时长_分钟",
    distance: env.LARK_FIELD_DISTANCE || "运动距离_公里",
    intensity: env.LARK_FIELD_INTENSITY || "强度",
    note: env.LARK_FIELD_NOTE || "备注",
    photo: env.LARK_FIELD_PHOTO || "打卡照片",
    month: env.LARK_FIELD_MONTH || "月份",
    weightPeriod: env.LARK_FIELD_WEIGHT_PERIOD || "记录类型",
    weightKg: env.LARK_FIELD_WEIGHT_KG || "体重_公斤",
    weightTime: env.LARK_FIELD_WEIGHT_TIME || "测量时间"
  };
}

async function uploadCheckinPhoto(env, file) {
  if (!file || typeof file !== "object" || !file.size) return null;
  assertLarkReady(env);
  if (file.size > 20 * 1024 * 1024) {
    throw new Error("打卡照片不能超过 20MB。");
  }
  const form = new FormData();
  const fileName = file.name || `checkin-${crypto.randomUUID()}.jpg`;
  form.set("file_name", fileName);
  form.set("parent_type", "bitable_image");
  form.set("parent_node", env.LARK_BASE_TOKEN);
  form.set("size", String(file.size));
  form.set("file", file, fileName);

  const result = await larkFetch(env, "/open-apis/drive/v1/medias/upload_all", {
    method: "POST",
    body: form,
    rawBody: true
  });
  const fileToken = result.data?.file_token || result.file_token;
  if (!fileToken) throw new Error("照片上传到了飞书，但没有返回 file_token。");
  return { fileName, fileToken };
}

async function getTenantAccessToken(env) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.appId === env.LARK_APP_ID && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const result = await larkFetch(env, "/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: {
      app_id: env.LARK_APP_ID,
      app_secret: env.LARK_APP_SECRET
    },
    auth: false
  });
  const token = result.tenant_access_token;
  if (!token) throw new Error("飞书没有返回 tenant_access_token，请检查应用凭据。");
  tokenCache = {
    appId: env.LARK_APP_ID,
    token,
    expiresAt: now + Number(result.expire || 7200) * 1000
  };
  return token;
}

async function larkCreateRecord(env, tableId, fields) {
  return larkFetch(env, `/open-apis/bitable/v1/apps/${env.LARK_BASE_TOKEN}/tables/${tableId}/records`, {
    method: "POST",
    body: { fields }
  });
}

async function larkListRecords(env, tableId) {
  const records = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);
    const result = await larkFetch(env, `/open-apis/bitable/v1/apps/${env.LARK_BASE_TOKEN}/tables/${tableId}/records?${params.toString()}`);
    records.push(...(result.data?.items || []));
    pageToken = result.data?.has_more ? result.data?.page_token || "" : "";
  } while (pageToken);
  return records;
}

async function loadLarkSummaryData(env) {
  assertLarkReady(env);
  const [checkinRecords, weightRecords] = await Promise.all([
    larkListRecords(env, env.LARK_CHECKIN_TABLE_ID),
    larkListRecords(env, env.LARK_WEIGHT_TABLE_ID)
  ]);
  const fields = larkFields(env);
  return {
    checkins: checkinRecords.map((row) => {
      const values = row.fields || {};
      const checkinTime = toLocalDateTimeString(values[fields.checkinTime]);
      return {
        id: row.record_id,
        member: textValue(values[fields.member]),
        date: toLocalDateString(values[fields.checkinDate]),
        time: checkinTime.slice(11, 16) || "00:00",
        activity: textValue(values[fields.activity]) || "其他",
        duration: numberOrNull(values[fields.duration]),
        distance: numberOrNull(values[fields.distance]),
        intensity: textValue(values[fields.intensity]) || "适中",
        note: textValue(values[fields.note]),
        photo: null
      };
    }).filter((row) => row.member && row.date),
    weights: weightRecords.map((row) => {
      const values = row.fields || {};
      return {
        id: row.record_id,
        member: textValue(values[fields.member]),
        month: textValue(values[fields.month]),
        period: textValue(values[fields.weightPeriod]),
        weightKg: Number(values[fields.weightKg]),
        measuredAt: toLocalDateTimeString(values[fields.weightTime]),
        note: textValue(values[fields.note])
      };
    }).filter((row) => row.member && row.month)
  };
}

async function larkFetch(env, path, options = {}) {
  const headers = {};
  if (!options.rawBody) headers["Content-Type"] = "application/json; charset=utf-8";
  if (options.auth !== false) {
    headers.Authorization = `Bearer ${await getTenantAccessToken(env)}`;
  }
  const res = await fetch(`https://open.feishu.cn${path}`, {
    method: options.method || "GET",
    headers,
    body: options.rawBody ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  if (!res.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(data.msg || data.message || `飞书 OpenAPI 请求失败：${res.status}`);
  }
  return data;
}

let tokenCache = {
  appId: "",
  token: "",
  expiresAt: 0
};

function assertLarkReady(env) {
  if (!env.LARK_BASE_TOKEN || !env.LARK_CHECKIN_TABLE_ID || !env.LARK_WEIGHT_TABLE_ID) {
    throw new Error("飞书多维表格还没有配置完整。");
  }
  if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) {
    throw new Error("还没有配置飞书应用的 LARK_APP_ID 和 LARK_APP_SECRET。");
  }
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
    missing: members.filter((member) => !checkins.some((item) => item.member === member)),
    latestCheckins: checkins.slice(-8).reverse(),
    monthlyLoss: buildMonthlyLoss(data.weights)
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
  const parts = dateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function textValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => textValue(item)).filter(Boolean).join(", ");
  if (typeof value === "object") return value.text || value.name || value.value || value.id || "";
  return String(value);
}

function toLocalDateString(value) {
  return toLocalDateTimeString(value).slice(0, 10);
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
  const parts = dateParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function dateParts(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute
  };
}
