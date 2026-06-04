# 运动打卡网站 MVP

这是一个网站版运动打卡工具，支持：

- 每日运动打卡：成员、日期、时间、打卡形式、时长、距离、强度、备注、照片
- 月初 / 月末体重记录：用于计算当月减重
- 周报汇总：打卡次数、运动时长、距离、成员排行、缺卡提醒
- 飞书多维表格同步：通过本机 `lark-cli` 写入你的飞书 Base

## 本地运行

```bash
npm start
```

打开：

```text
http://localhost:4173
```

默认是本地预览模式，数据会保存在 `work/app-data`。

## 多人访问

本地 `localhost` 只能自己打开。要给多人使用，可以：

- 临时试用：用 Cloudflare Tunnel / ngrok 把本机服务转成公网 HTTPS 链接
- 长期使用：部署到一台服务器，并把 `.env` 里的 `HOST` 设置为 `0.0.0.0`

建议公开前设置：

```text
APP_ACCESS_CODE=你的活动口令
```

设置口令后，成员需要输入口令才能提交和查看周报。

当前项目也带了一个临时公网启动脚本：

```bash
bash scripts/start-public.sh
```

脚本会输出一个 `https://...loca.lt` 链接。电脑关机、休眠或脚本进程停止后，链接会失效；下次重新运行脚本会生成新链接。

## 正式部署

正式部署建议用 Render、Railway、Fly.io 或其他 Node.js Web Service。项目已经包含：

- `Dockerfile`
- `render.yaml`
- 云端飞书 OpenAPI 写入模式

云端环境变量建议这样设置：

```text
HOST=0.0.0.0
PORT=4173
STORAGE_MODE=lark
LARK_SYNC_MODE=openapi
APP_ACCESS_CODE=你的活动口令
LARK_APP_ID=飞书开放平台应用 App ID
LARK_APP_SECRET=飞书开放平台应用 App Secret
LARK_BASE_TOKEN=A7Kdb1bBfaNVzlsPADrcmCcLnGg
LARK_CHECKIN_TABLE_ID=tbleDM5qmEYCYoRl
LARK_WEIGHT_TABLE_ID=tblVInYw9lkiwLbN
LARK_CHECKIN_PHOTO_FIELD_ID=fldtIwdAzo
```

飞书开放平台应用需要具备多维表格记录读取、记录创建等权限，并且这个应用要有权限访问 `运动打卡` 这张多维表格。

注意：当前 Node 云端 OpenAPI 模式会稳定写入打卡和体重记录，并直接从飞书读取周报。Render 等免费容器的本地上传目录重启后可能丢失；如果需要长期保存照片，建议使用 Cloudflare Workers 版本，或继续给 Node 版本接对象存储。

## Cloudflare Workers 部署

如果部署平台不方便绑定银行卡，可以用 Cloudflare Workers。项目已经包含：

- `src/worker.js`
- `wrangler.jsonc`

需要把飞书应用凭据作为 Cloudflare secrets 设置：

```bash
npx wrangler secret put LARK_APP_ID
npx wrangler secret put LARK_APP_SECRET
npx wrangler deploy
```

Workers 版本会直接把打卡、照片和体重记录写入飞书，也会直接从飞书读取周报。

## 接入飞书多维表格

1. 先确认让我创建飞书多维表格结构。
2. 我会运行 `npm run setup:lark` 创建 Base、`每日打卡` 表和 `月度体重` 表。
3. 把创建结果里的 token 和 table id 填进 `.env`。
4. 将 `STORAGE_MODE` 改成 `lark`，再重启网站。

浏览器不会保存飞书密钥。网站只请求本地后端，由后端通过 `lark-cli` 写入飞书。
