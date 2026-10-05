# 安装说明

> 本包是 **dsh-startup-screen-repair**，同时支持 **dsh web** 与 **dsh desktop**。
> 它与原版 `dsh-startup-screen` 使用不同的插件 id，**可以共存**，
> 但同一个页面里同时装两个启动动画没有意义，建议先卸掉原版。

## 一、直接安装（推荐）

```bash
# 桌面端
dsh plugin --profile desktop add ./dsh-startup-screen-repair-1.1.0.tgz

# Web
dsh plugin --profile web add ./dsh-startup-screen-repair-1.1.0.tgz
```

装完 **重启 dsh**（关掉启动器窗口再重新双击）。刷新页面就能看到启动动画。

### 为什么必须用 `dsh plugin add`

DSH 靠 **`dsh.profile.bundles`** 这个层堆栈决定加载哪些插件，而
`dsh plugin add` 是 `pnpm add` 的包装，装完之后 DSH 会自动把
「声明了 `dsh.bundle` 的依赖」并入层堆栈 —— 插件自带的 `cordis.patch.yml`
就是在那时候作为一层被应用的。

**手工把目录拷进 `node_modules` 不会被识别。**

### 装完请检查一次

如果你之前是手工在 profile 的 `cordis.patch.yml` 里加了这类条目：

```yaml
- insert:
    - id: dsh-startup-screen-repair
      name: dsh-startup-screen-repair
```

**必须删掉。** 否则插件被注册两次，`apply` 跑两遍，
`ctx.webServer.register()` 对同一路径重复注册会报错
（`webServer` 对重复的 `(kind, path)` 是直接抛异常的）。

同时检查有没有残留的原版条目：

```yaml
- insert:
    - id: dsh-startup-screen        # ← 原版，建议一并删掉
      name: dsh-startup-screen
```

---

## 二、手工安装（不用 pnpm）

1. 把 `plugin/` 目录解压到任意位置
2. 让 profile 能解析到它 —— 在 `~/.dsh/profiles/<profile>/node_modules/` 下建目录联接：

   ```cmd
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-startup-screen-repair" "解压路径\plugin"
   ```

   `desktop` 换成 `web` 就是装到 web profile。

3. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-startup-screen-repair
         name: dsh-startup-screen-repair
   ```

4. 重启 dsh

---

## 三、验证装好了

重启后，**没带 token** 访问插件路由：

- `/dsh-startup/splash.js` 返回 **401** → 路由已注册
  （401 是插件自己的 `connection.requestRejection` 信任围栏，正常）
- 返回 **404** → 没装成功，或没重启

打开页面后应该看到：黑幕 → DeepSeek 标识 → 过曝洗白 → 暖白底板 →
五步授权序列 → 揭幕。

### 桌面端怎么确认注入通道走对了

桌面端的 index.html 由 Electron 从磁盘直读，**不经过 HTTP 服务**，
所以不能用「curl 首页」来判断。可靠办法是看页面有没有黑幕：
原版用的是 `tapIndex`（服务端钩子），在桌面端一次都不会被调用，页面不会变黑；
本版用 `webserver/index-inject` 结构化注入行，桌面端由 Host 经 IPC 下发，同样会变黑。

如果装了插件但页面完全不黑，先确认不是「显示模式 = 每次会话」导致本次会话已经播过了
（换一次 `每天` 或开无痕窗口即可排除）。

---

## 四、卸载

```bash
dsh plugin --profile desktop remove dsh-startup-screen-repair
dsh plugin --profile web     remove dsh-startup-screen-repair
```

走「二、手工安装」的，删掉目录联接和那两行 patch 条目即可。

---

## 五、配置项

设置页 → **启动动画**：

| 分组 | 可调 |
|---|---|
| 播放 | 显示模式（每次会话 / 总是 / 每天）、主题、速度、是否要求确认、是否可跳过 |
| 身份资料 | 身份名称（默认 `JOYCE MOORE`）、编号、权限等级 |
| 语音与音效 | 语音开关、**语音来源（真声素材 / 系统 TTS）**、音色、语速、音调、音量、播报前提示音、开口前留白；界面音效开关与音量 |
| 视觉 | 强调色、故障色 A / B |
| 文案 | 品牌三行 / 黑幕三行 / 终幕方框 / 页脚 |

配置落盘在 `$DSH_HOME/dsh-startup.json`（默认 `~/.dsh/dsh-startup.json`）。
web 与 desktop 共用同一份。配置在每次渲染首页时重新读取，所以**改完刷新即生效**，不用重启。

---

## 六、环境要求

| 项 | 要求 |
|---|---|
| Node | **>= 20** |
| 平台 | DSH **web** 与 **desktop** 均可（`dsh.client.platform = "web"`，桌面端也跑同一个 web 应用） |
| DSH 版本 | **>= 0.1.5-rc.1**（在 0.2.0-rc.2 上实测） |
| 运行时依赖 | **零**（`dependencies` / `peerDependencies` 都是空的） |
| 语音 | 浏览器 Web Speech API；Edge 里能挑到 `... Online (Natural)` 神经网络音色 |
| 真声素材 | 已内置 `lib/assets/`；**取不到会自动回落 TTS**，不影响启动 |

---

## 七、包内容

```
lib/index.js          Host 半：路由 + webserver/index-inject 注入行
lib/splash.js         启动动画运行时
lib/splash.css        全部样式
lib/client.js         设置面板（浏览器半）
lib/assets/           真声台词 x5 + 终幕欢迎语 + 界面音效 x2
cordis.patch.yml      bundle 层声明
preview/index.html    离线预览页
test/                 三套冒烟测试（195 项断言）
README.md             完整文档（含「实现原理」）
AUDIO-FIELDS.md       需要音频的字段清单
```

跑测试：`npm test`

三套测试各自覆盖什么：

| 套件 | 断言数 | 覆盖 |
|---|---|---|
| `test/smoke-host.mjs` | 82 | 导出形状、四个路由、信任围栏、**注入行形状 + web 渲染 + desktop 解释器双通道**、配置读写与钳制、XSS 转义、生命周期清理 |
| `test/smoke-splash.mjs` | 72 | 六幕序列、跳过与兜底、音频回落、语音队列不被打断、**BASE 前缀注入与降级** |
| `test/smoke-client.mjs` | 41 | 设置面板加载、字段渲染、保存/恢复默认、**宿主 API 变动时的降级路径** |

> 测试里的 `renderRow` / `renderIndexInjections` 是按 `dsh-host-webserver`
> 的真实实现复刻的。复刻版与真实实现的一致性已用「真插件 → 真渲染函数 → 真 dist/index.html」
> 的端到端对照单独验证过（7 组边界输入 markup 完全一致）。
