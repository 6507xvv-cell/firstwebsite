# 我的个人主页

四屏的个人主页：**关于我** / **我的学习记录** / **一键去除图片背景** / **AI 图像生成**。
纯原生 HTML + CSS + JS，没有构建步骤，也没有第三方前端依赖。

```
first website/
├── index.html     个人主页（四屏，所有内容都在文件顶部的配置区里改）
├── server.js      本地小服务：静态托管 + 去背景 / 文生图接口（零依赖，Node 18+）
├── avatar.svg     占位头像（仓库里不放真人照片，加载不到本地照片时用这张）
├── .gitignore     忽略 .env 与个人照片
└── README.md
```

> **关于头像**：`PROFILE.avatar` 指向 `证件照近期.jpg`（本人照片，已被 `.gitignore` 排除，不会进公开仓库）。
> 想看真人头像，把照片放到本目录、文件名对上即可；没有这张图时页面会自动退到 `avatar.svg`。

---

## 一、直接看页面

页面本身是纯静态的，**双击 `index.html` 就能看**前两屏。

但第三屏「去除图片背景」需要调用 Replicate，必须走服务端（Token 不能放在前端），
所以要用下面的方式启动，功能才完整。

---

## 二、启动本地服务（去背景、文生图都需要）

去背景用的是 **Replicate**，文生图用的是 **OpenRouter**，两个 Key 各配各的，
缺哪个就哪个功能不可用，另一个照常工作。

### 1. 拿到两把 Key

- Replicate（去背景）：<https://replicate.com/account/api-tokens>，形如 `r8_xxx`
- OpenRouter（文生图）：<https://openrouter.ai/keys>，形如 `sk-or-v1-xxx`

1. 注册并登录 <https://replicate.com>
2. 打开 <https://replicate.com/account/api-tokens> 创建一个 token（形如 `r8_xxx`）

### 2. 设置环境变量

**PowerShell（推荐）**

```powershell
cd "D:\HuaweiMoveData\Users\唐靖博\Desktop\first website"
$env:REPLICATE_API_TOKEN="r8_你的token"
$env:OPENROUTER_API_KEY="sk-or-v1-你的key"
node server.js
```

**CMD**

```bat
set REPLICATE_API_TOKEN=r8_你的token
node server.js
```

**macOS / Linux**

```bash
export REPLICATE_API_TOKEN=r8_你的token
node server.js
```

> 想永久生效：Windows 在「系统属性 → 环境变量」里加一条 `REPLICATE_API_TOKEN`；
> macOS/Linux 写进 `~/.zshrc` 或 `~/.bashrc`。
>
> 只是本地图省事的话，也可以在目录里建一个 `.env` 文件，一行一个：
> `REPLICATE_API_TOKEN=r8_你的token` / `OPENROUTER_API_KEY=sk-or-v1-你的key`。
> 服务启动时会自动读（`.env` 已被 `.gitignore` 忽略）。
> **真实部署时请务必用系统环境变量，不要把 `.env` 提交到任何仓库。**

### 3. 打开页面

浏览器访问 <http://localhost:5173>，滚到第三屏即可使用。
换端口：`PORT=8080 node server.js`。

启动成功会看到：

```
  个人主页已启动  →  http://localhost:5173
  Replicate Token: 已读取 ✓
  停止服务: Ctrl + C
```

如果显示 `未检测到 ✗`，页面第三屏会提示你先配置 Token。

---

## 三、去背景功能怎么用

- **上传**：把图片拖进虚线框、点击选择文件，或者直接 `Ctrl + V` 粘贴截图
- **处理**：点「去除背景」，按钮变灰并显示「处理中…」，右侧面板出现转圈
- **结果**：左边原图、右边结果并排对比；背景是棋盘格，用来看清透明区域
- **下载**：点「下载结果」保存透明 PNG
- **重来**：点「重新选择」清空

限制：单张 ≤ 10MB（前端校验），支持 PNG / JPG / WebP / GIF。

---

## 四、Token 为什么不在前端

浏览器的 JS 任何人都能看到，Token 写进去等于公开。所以分工是：

```
浏览器  ──图片(base64)──▶  server.js  ──Token──▶  Replicate
        ◀──结果图片URL──              ◀──URL───
```

- `server.js` 从 `process.env.REPLICATE_API_TOKEN` 读 Token，**代码里没有任何密钥**
- 前端只跟自己的 `/api/remove-bg` 说话
- 结果图下载走 `/api/fetch-image` 代理，带域名白名单（只允许 `replicate.delivery`），
  避免被当成任意 URL 代理；服务只监听 `127.0.0.1`，不对外暴露

**接口一览**

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/health` | GET | 自检：服务在不在、Token 配没配 |
| `/api/remove-bg` | POST | 收 `{image: "data:image/png;base64,..."}`，返回 `{output: "https://..."}` |
| `/api/generate-image` | POST | 收 `{prompt, aspect_ratio, quality, background}`，返回 **SSE 流**（start / partial / done / error） |
| `/api/fetch-image?url=` | GET | 代理下载结果图，带 `Content-Disposition` |

**模型**：[lucataco/remove-bg](https://replicate.com/lucataco/remove-bg)，
固定版本 `95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1`。
图片 ≤ 256KB 时直接传 data URI；更大的图先传到 Replicate 文件存储再拿 URL 跑模型
（这是 Replicate 官方推荐的用法）。

---

## 五、AI 图像生成怎么用

- 写一句画面描述（中文英文都行），选宽高比 / 画质 / 背景
- 点「生成图片」→ 按钮变灰转圈，画布上方出现流动进度条，下方显示**已用秒数**
- 这个模型会先推回中间帧，所以你能看着画面从模糊一点点变清晰，不用干等
- 完成后显示「用时 xx 秒 · 约 $x.xxx」，点「下载 PNG」保存

**关于耗时和费用**（2026-09-29 实测）：低调画质 / 1:1 约 **10~15 秒**，一次 **$0.0083**。
官方标称 P50 延迟约 **76 秒**、P90 约 122 秒（高画质大尺寸会明显更慢，一张 16:9 高画质约 $0.13）。
慢是正常的，不是卡住了 —— 界面上的秒数和中间帧就是让你知道它还在干活。

**接口实现**：优先走 OpenRouter 专用图像接口 `/api/v1/images` 并开启 SSE 流式，
逐个转发 `image_generation.partial_image` 中间帧；若该模型不支持此接口
（返回 400/404），自动回退到 `chat/completions` + `modalities:["image","text"]`。

---

## 六、改内容

打开 `index.html`，所有可变内容集中在 `<script>` 顶部：

```js
const PROFILE = { avatar, nickname, tagline, hobbies, goals };  // 个人介绍
const RECORDS = [ { date, title, desc, tag }, ... ];            // 学习记录，按日期倒序
const FOOTER  = "...";
```

配色改 `<style>` 里的 `:root` 变量（`--accent` 是主色）。

---

## 六、常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| 顶部显示「未连接本地服务」 | 服务没启动。运行 `node server.js`，右上角状态会变绿 |
| 「处理失败：接口返回 404」 | 页面不是由 `server.js` 托管的（比如被编辑器预览面板打开）。页面会自动尝试连 `localhost:5173`；最稳妥是直接访问 `http://localhost:5173` |
| 提示「还没连接本地服务」 | 直接用 `file://` 打开的。运行 `node server.js`，访问 `http://localhost:5173` |
| 提示 Token 未配置 | 设置 `REPLICATE_API_TOKEN` 后**重启**服务（环境变量只在启动时读一次） |
| 「Token 无效或已过期」 | Token 复制错了，或已被删除，重新生成一个 |
| 「账户额度不足」 | Replicate 免费额度用完了，去 billing 页面查看 |
| 一直转圈最后超时 | 图片太大或 Replicate 排队，换小一点的图重试 |
| 文生图提示「未配置 OPENROUTER_API_KEY」 | 设 `OPENROUTER_API_KEY` 后**重启**服务 |
| 生图等了 2 分钟还没好 | 这个模型本来就慢（P90 约 122 秒），看画布上有没有中间帧在变清晰 |
| 端口被占用 | `PORT=8080 node server.js` 换个端口 |
| 想让同学也能访问 | 现在只监听 `127.0.0.1`。要对外开放请自行加鉴权和 HTTPS，别直接暴露 |
