# dsh-startup-screen-repair

DeepSeek Harness 的启动界面与启动动画插件，**同时适配 dsh web 与 dsh desktop**。

黑幕 DeepSeek 标识 → 过曝洗白 → 暖白「技术档案」底板 → 五步交互式访问授权 →
色散故障揭幕。

> 本项目是 [6shenhonghong9/dsh-startup-screen](https://github.com/6shenhonghong9/dsh-startup-screen)
> 的修复版（fork）。原版只用了 `webServer.tapIndex`，那是**服务端**改写 index.html 的接口，
> 而 dsh desktop 的 index.html 由 Electron 直接从磁盘读取，tapIndex 永远不会被调用，
> 因此在桌面端完全不生效。本版改用 `webserver/index-inject` 结构化注入行，
> 这是 web 与 desktop 共用的唯一通道，两端都能在应用挂载前生效。详见下方「实现原理」。

---

## 功能

**开机序列**　冷启动时播一段完整的开机动画，六幕连贯：厂牌标识 → 过曝洗白 →
暖白底板 → 五步授权 → 揭幕。中央一圈环形准星缓慢自转，缺口留在正下方，
不会挡住底部文字。

**可交互，不是播片**　第一、二步要你点按钮或按 Enter 才会继续（可以关掉）。
右上角有跳过按钮，Esc 也能跳。

**中文主字 + 英文等宽副标题**　英文副标题逐字打出来，像终端在接收数据。

**真声台词 + 界面音效**　五句台词和终幕欢迎语都是真声素材，界面音效取自同一段素材。
浏览器要求先有一次点击才准出声，所以点过按钮之后才会听到声音。

**语音没播完不会推进**　每一步停留多久由实际音频时长决定。你点得快也不会把语音掐断。

**三十三项设置**　身份名称、编号、权限等级、配色、速度、音色、语速、
开口留白、每处文案……都能在设置页实时改，改完立即生效。

**两端同源，一份配置**　web 与 desktop 跑的是同一个 web 应用，只是注入通道不同；
插件对两端下发同一张注入表，设置项也只有一份，不存在「桌面端另配一套」。

**不会把宿主拖死**　所有注入都带 9 秒兜底：无论运行时脚本因为什么原因没起来，
黑幕都会自动撤掉，应用照常可用。客户端的设置页注册也整个包在 try/catch 里，
宿主 API 变动最多让设置页少一项，不会把界面搞崩。

---

## 播放序列

| # | 中文主字 | 英文副标题 | 需要操作 |
|---|---|---|---|
| 1 | 需要访问许可 | `ACCESS PERMISSION REQUIRED` | 点按钮 / 按 Enter / 空格 |
| 2 | 身份资料确认 | `IDENTITY VERIFICATION` | 点按钮 / 按 Enter / 空格 |
| 3 | 接收访问需求 | `ACCESS REQUEST RECEIVED` | 自动 |
| 4 | 开始读取权限 | `PERMISSION READ STARTED` | 自动 |
| 5 | 读取完毕 · 核验通过 | `READ COMPLETE · VERIFIED` | 自动 |
| 6 | 欢迎「身份名称」访问 | `WELCOME, NAME` | 自动 |

---

## 安装

```bash
# dsh desktop（桌面端）
dsh plugin --profile desktop add ./dsh-startup-screen-repair-1.1.0.tgz

# dsh web
dsh plugin --profile web add ./dsh-startup-screen-repair-1.1.0.tgz

# 本地开发：直接链到工作目录，改完刷新即可
dsh plugin --profile desktop add link:R:\Dsh\dbaWorkspace\dsh-startup-screen-repair
```

**装完重启 dsh**（关掉启动器窗口再重新双击）。重启后刷新页面就能看到启动动画，
设置页里会多出一项「启动动画」。

### 环境要求

| 项 | 要求 |
|---|---|
| 平台 | DSH **web** 与 **desktop** profile 均可 |
| DSH | **>= 0.1.5-rc.1**（在 0.2.0-rc.2 上实测通过） |
| Node | **>= 20** |
| 依赖 | 无（不需要 `npm install`） |

### 卸载

```bash
dsh plugin --profile desktop remove dsh-startup-screen-repair
dsh plugin --profile web     remove dsh-startup-screen-repair
```

---

## 实现原理

这一节解释「为什么原版在桌面端不生效」以及本版是怎么修的，便于后续升级 DSH 时判断该改哪里。

### 两条注入通道

DSH 的 Host 提供两种往首页塞东西的方式：

| 通道 | 形态 | dsh web | dsh desktop |
|---|---|---|---|
| `webServer.tapIndex(fn)` | 服务端拿字符串改写 index.html | ✅ 生效 | ❌ **不生效** |
| `ctx.on('webserver/index-inject', table => table.push(row))` | 产出结构化注入行 | ✅ 生效 | ✅ **生效** |

原因是桌面端的 index.html **不经过 HTTP 服务**：Electron 通过 `dsh-app://` 协议
直接从磁盘读 `dsh-web-frontend/dist`，只有 `/plugins/*` 之类的请求才转发给 Host。
tapIndex 是服务端渲染路径上的钩子，自然一次都不会被调用 —— 这就是原版在桌面端毫无反应的原因。

而结构化注入行是一张**纯 JSON 可序列化**的表：web 端由 `renderIndexInjections`
渲染进 index.html 文本，桌面端由 Host 经 IPC 把同一张表交给页面侧解释器执行。
一份行表，两个渲染器，所以两端都能覆盖。

### 本插件下发的四行

```js
[ { kind: 'style',      text: CRITICAL_CSS },                    // 黑幕，必须最先生效
  { kind: 'script',     placement: 'head',
    text: 'window.__DSH_STARTUP_BASE__=…;window.__DSH_STARTUP__=…;' + BOOTSTRAP_JS },
  { kind: 'html',       placement: 'body',
    html: '<div id="dsh-startup-root" class="dsu-root dsu-boot"></div>' },
  { kind: 'script-src', placement: 'body', src: '/dsh-startup/splash.js' } ]
```

几个刻意的选择：

- **黑幕用 `style` 行而不是外部 CSS 链接。** `style` 行的内容被直接内联在 `<head>` 最前面，
  一定在应用入口 `<script type="module">` 之前解析完，所以刷新瞬间就是黑的，不会闪一下白底。
- **配置与兜底用内联 `script` 行。** 内联脚本按文档顺序同步执行，属于首屏关键路径，
  「该不该播」「9 秒兜底」这两个判断必须在应用挂载前就确定。同理 `enabled:false` 时
  直接返回空表，一行都不注入。
- **运行时用 `script-src` 行。** 外部脚本是异步资源，不保证在应用挂载前到达；
  但它只是全屏覆盖层，晚一点起来也只会让黑幕多停一瞬，而黑幕和 9 秒兜底已经在关键路径上了。
- **配置在 `emit` 时读取，不是在 `apply` 时快照。** `collectIndexInjections()`
  每次渲染首页都会重新发一次事件，所以在设置页改完**刷新即生效**，不用重启 DSH。
- **绝不拼 `window.location.origin`。** 桌面端页面 origin 是 `dsh-app://app`，
  不是 `http://127.0.0.1:<port>`，拼 origin 会得到一个根本不存在的地址。
  插件里所有路径都是站点根相对路径，前缀由注入的 `window.__DSH_STARTUP_BASE__` 给出。

### 降级与容错

- 四行都带 9 秒无条件兜底：撤掉黑幕、解除滚动锁、标记 `__DSH_STARTUP_FAILED__`。
- `enabled:false` → 空表；`enabled` 重新打开 → 恢复四行。
- 客户端半侧注册设置项失败只 `console.warn`，不影响界面。
- 所有路由都过 `connection.requestRejection` 信任围栏，未授权请求一律 403。

### 设置项写在哪

`$DSH_HOME/dsh-startup.json`（默认 `~/.dsh/dsh-startup.json`），原子写入。
Web 与 desktop 共用同一份，因为两端 Host 都在同一个用户目录下。

---

## 设置选项

装好后进入 **DSH 设置页 →「启动动画」**，改完点「保存」即刻写入配置文件。

### 播放

| 选项 | 默认 | 作用 |
|---|---|---|
| 启用 | 开 | 总开关，关掉就完全不播 |
| 显示模式 | 每次会话 | `每次会话` 一个浏览器会话播一次 / `总是` 每次刷新都播 / `每天` 一天一次 |
| 主题 | 暖白 | `暖白` 参考片原色 / `暗色` 暗底板 |
| 速度 | 1× | 整段动画的快慢，0.35 – 3 倍 |
| 要求确认 | 开 | 第 1、2 步是否等你点按钮才继续 |
| 允许跳过 | 开 | 是否显示右上角跳过按钮、是否响应 Esc |

### 身份资料

| 选项 | 默认 | 作用 |
|---|---|---|
| 身份名称 | `JOYCE MOORE` | 终幕「欢迎 xxx 访问」里的名字 |
| 身份编号 | `0087` | 第二步身份卡上的编号，建议填数字 |
| 权限等级 | `3` | 第二步身份卡上的权限等级 |

### 语音

| 选项 | 默认 | 作用 |
|---|---|---|
| 语音播报 | 开 | 是否念台词 |
| 语音来源 | 真声素材 | `真声素材` 用内置录音 / `系统 TTS` 用浏览器合成音 |
| 音色 | 自动 | 只在用系统 TTS 时有效。留空 = 自动挑一个女声 |
| 语速 | 0.88 | 只在用系统 TTS 时有效。越慢越有旁白感 |
| 音调 | 0.85 | 只在用系统 TTS 时有效。调低更沉稳，1.0 以上会像客服播报 |
| 音量 | 0.9 | 台词音量 |
| 播报前提示音 | 开 | 念台词前先响两声轻提示，更像系统播报 |
| 开口前留白 | 240 ms | 提示音响过之后停多久再开口，0 – 1200 ms |

### 界面音效

| 选项 | 默认 | 作用 |
|---|---|---|
| 界面音效 | 开 | 文字出现、阶段推进、按钮确认的「哒」声 |
| 音效音量 | 0.5 | 界面音效音量（不影响台词） |
| 音效来源 | 内置素材 | `内置素材` 用录音 / `现场合成` 用代码合成 |

### 视觉

| 选项 | 默认 | 作用 |
|---|---|---|
| 强调色 | `#ff7500` | 阶段条、进度条、准星的橙 |
| 故障色 A / B | `#ff3b30` / `#2971b8` | 揭幕那下色散故障的红与蓝 |

### 文案

| 选项 | 默认 | 作用 |
|---|---|---|
| 品牌三行 | `DEEPSEEK` / `SYNTHESIZE INTELLIGENCE` / `HARNESS OS` | 左上角品牌块 |
| 黑幕三行 | `深度求索` / `DEEPSEEK` / `DEEPSEEK HARNESS` | 开场黑幕上的字 |
| 终幕方框 | `DEEPSEEK HARNESS` | 揭幕后中央的黑底白字框 |
| 页脚 | `POWERED BY DEEPSEEK` | 右下角页脚 |

---

## 免责声明

**一、仅供学习交流。** 本项目为个人学习与娱乐性质的开源插件，不用于任何商业目的。

**二、第三方素材权利。** 本项目的视觉风格参考自动画作品，音频素材（人声与音效）
取自第三方视频，相关权利均归原权利人所有。本项目不对上述风格与素材主张任何权利，
亦未获得任何形式的授权或背书。

**三、二次创作风险自担。** 任何人基于本项目进行修改、改编、翻译、再分发等二次创作，
由此产生的侵权、纠纷或任何法律责任，均由该行为人自行承担，与本项目作者无关。

**四、商业使用风险自担。** 本项目**未授权任何商业用途**。若将本项目或其衍生作品
用于商业行为（包括但不限于售卖、付费分发、商业产品集成、商业宣传、商业演示），
由此引发的知识产权纠纷与全部法律责任，由使用者自行承担，作者不承担任何责任。

**五、许可范围。** 本项目的开源许可仅覆盖作者原创的代码与文案，
**不覆盖**上述第三方风格与素材。使用者在再利用第三方内容时，应自行取得相应授权。

**六、权利主张。** 若权利人认为本项目侵犯了其合法权益，请联系作者，
作者将在核实后立即移除相关内容。

---

## License

MIT © 沈宏宏
