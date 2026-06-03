import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LARK_AS = process.env.LARK_AS || "user";
const baseName = process.env.LARK_BASE_NAME || `运动打卡_${new Date().toISOString().slice(0, 10)}`;
const existingBaseToken = process.env.LARK_BASE_TOKEN || "";

const run = (args) => {
  const output = execFileSync("lark-cli", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output);
};

const getTables = () => {
  const result = run([
    "base",
    "+table-list",
    "--base-token",
    baseToken,
    "--limit",
    "50",
    "--as",
    LARK_AS
  ]);
  return result.data?.tables || result.tables || result.items || [];
};

const getFields = (tableId) => {
  const result = run([
    "base",
    "+field-list",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--limit",
    "100",
    "--as",
    LARK_AS
  ]);
  return result.data?.fields || result.fields || result.items || [];
};

const select = (options) => ({
  type: "select",
  multiple: false,
  options: options.map(([name, hue, lightness]) => ({ name, hue, lightness }))
});

const checkinFields = [
  { name: "成员", type: "text" },
  { name: "打卡日期", type: "datetime" },
  { name: "打卡时间", type: "datetime" },
  { name: "打卡形式", ...select([
    ["跑步", "Blue", "Light"],
    ["快走", "Green", "Light"],
    ["骑行", "Wathet", "Light"],
    ["游泳", "Blue", "Lighter"],
    ["力量训练", "Purple", "Light"],
    ["瑜伽拉伸", "Orange", "Light"],
    ["其他", "Gray", "Light"]
  ]) },
  { name: "运动时长_分钟", type: "number", style: { type: "plain", precision: 0 } },
  { name: "运动距离_公里", type: "number", style: { type: "plain", precision: 2 } },
  { name: "强度", ...select([
    ["轻松", "Green", "Lighter"],
    ["适中", "Yellow", "Light"],
    ["高强度", "Red", "Light"]
  ]) },
  { name: "备注", type: "text" },
  { name: "打卡照片", type: "attachment" }
];

const weightFields = [
  { name: "成员", type: "text" },
  { name: "月份", type: "text" },
  { name: "记录类型", ...select([
    ["月初", "Blue", "Light"],
    ["月末", "Green", "Light"]
  ]) },
  { name: "体重_公斤", type: "number", style: { type: "plain", precision: 1 } },
  { name: "测量时间", type: "datetime" },
  { name: "备注", type: "text" }
];

let baseResult = { reused: Boolean(existingBaseToken) };
let base = {};
let baseToken = existingBaseToken;

if (!baseToken) {
  baseResult = run(["base", "+base-create", "--name", baseName, "--time-zone", "Asia/Shanghai", "--as", LARK_AS]);
  base = baseResult.base || baseResult.data?.base || baseResult;
  baseToken = base.app_token || base.token || base.base_token || base.appToken;
}

if (!baseToken) {
  throw new Error("Base created, but token was not found in lark-cli output.");
}

const createTable = (name, fields) => {
  const existing = getTables().find((table) => table.name === name || table.table_name === name);
  if (existing) {
    const id = existing.id || existing.table_id;
    ensureFields(id, fields);
    return {
      reused: true,
      id,
      name,
      fields: getFields(id)
    };
  }

  const result = run([
    "base",
    "+table-create",
    "--base-token",
    baseToken,
    "--name",
    name,
    "--fields",
    JSON.stringify([fields[0]]),
    "--as",
    LARK_AS
  ]);
  const table = result.table || result.data?.table || result;
  const id = table.table_id || table.id || table.tableId;
  ensureFields(id, fields);
  return {
    result,
    id,
    name,
    fields: getFields(id)
  };
};

const ensureFields = (tableId, fields) => {
  const existingNames = new Set(getFields(tableId).map((field) => field.name || field.field_name));
  for (const field of fields) {
    if (existingNames.has(field.name)) continue;
    run([
      "base",
      "+field-create",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--json",
      JSON.stringify(field),
      "--as",
      LARK_AS
    ]);
    existingNames.add(field.name);
  }
};

const checkin = createTable("每日打卡", checkinFields);
const weight = createTable("月度体重", weightFields);

const env = [
  "PORT=4173",
  "STORAGE_MODE=lark",
  `LARK_AS=${LARK_AS}`,
  `LARK_BASE_TOKEN=${baseToken}`,
  `LARK_CHECKIN_TABLE_ID=${checkin.id || "每日打卡"}`,
  `LARK_WEIGHT_TABLE_ID=${weight.id || "月度体重"}`,
  `LARK_CHECKIN_PHOTO_FIELD_ID=${(checkin.fields || []).find((field) => field.name === "打卡照片")?.id || ""}`,
  "",
  "LARK_FIELD_MEMBER=成员",
  "LARK_FIELD_CHECKIN_DATE=打卡日期",
  "LARK_FIELD_CHECKIN_TIME=打卡时间",
  "LARK_FIELD_ACTIVITY=打卡形式",
  "LARK_FIELD_DURATION=运动时长_分钟",
  "LARK_FIELD_DISTANCE=运动距离_公里",
  "LARK_FIELD_INTENSITY=强度",
  "LARK_FIELD_NOTE=备注",
  "LARK_FIELD_PHOTO=打卡照片",
  "LARK_FIELD_MONTH=月份",
  "LARK_FIELD_WEIGHT_PERIOD=记录类型",
  "LARK_FIELD_WEIGHT_KG=体重_公斤",
  "LARK_FIELD_WEIGHT_TIME=测量时间",
  ""
].join("\n");

const envPath = resolve(".env");
writeFileSync(envPath, env);

console.log(JSON.stringify({
  ok: true,
  baseName,
  baseToken,
  url: base.url,
  permissionGrant: baseResult.permission_grant,
  tables: {
    checkin,
    weight
  },
  envPath
}, null, 2));
