# dsh-ndi-eye

让 AI 用 **NDI 当眼睛**。

任何 NDI 源都能变成模型真正看到的画面：VTube Studio 的相机输出、OBS 的节目画面、采集卡、局域网里另一台机器上的源。

和截屏的区别在于——**NDI 拿的是信号本身**，不是窗口。所以窗口被遮挡、被最小化、甚至画面根本不在本机（另一台电脑上跑着 OBS），都照样能看。

## 工具

| 工具 | 作用 |
| --- | --- |
| `ndi_sources` | 列出当前所有 NDI 源，标出会自动选中的那个 |
| `ndi_see` | 抓一帧送进视觉通道；不传 `source` 就复用上次的源，或自动挑最像相机/皮套的 |
| `ndi_watch` | 在若干秒内采样多帧，丢掉没变化的帧，用来看「刚才动了什么」 |
| `ndi_status` | 报连接状态、帧数、实际帧率、最后的错误，用来诊断而不是盲重试 |

## 安装

```powershell
dsh plugin --profile <你的 profile> add github:<owner>/dsh-ndi-eye
```

然后重启 DSH。

**装完必须确认 bundle 已登记**，否则包装上了、工具却不出现：

```powershell
dsh --profile <你的 profile> --dump-config | Select-String ndi-eye
```

看到 `id: ndi-eye` 才算成功。没有的话，编辑 `<profile 目录>/package.json`，把 `dsh-ndi-eye` 加进 `dsh.profile.bundles`：

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "dsh-ndi-eye"]
  }
}
```

> `dsh plugin add` 只是把参数转发给 pnpm，它**只写 `dependencies`，不写 `dsh.profile.bundles`**。
> 实测在全新 profile 上只执行 `add`：依赖里有 `dsh-ndi-eye`，但 bundles 里只有 `dsh-base` —— patch 没被挂载。

### 如果安装报 `ERR_PNPM_IGNORED_BUILDS`

在 `<profile 目录>/pnpm-workspace.yaml` 里加白名单，然后重装：

```yaml
allowBuilds:
  koffi: true
```

pnpm 默认不执行依赖的构建脚本。不加白名单会以 `exit code 1` 结束，DSH 报成 `kind: build-blocked`。

**这只是噪音，不是故障**：koffi 的预编译 addon 本身可用，即使脚本被忽略插件也照常工作。但别人看到 `exit 1` 容易以为装坏了，加白名单能彻底消掉。

两种写法都行：`koffi: true`（不限版本），或 `koffi@3.3.4: true`（钉版本）。安装器有时会自己写一行占位 `set this to true or false`，改成 `true` 即可。

### 其他安装方式

**压缩包**（不走 GitHub 时）：`npm pack` 后把 `.tgz` 给对方，`dsh plugin --profile <p> add "<tgz 绝对路径>"`。同样要加白名单、登记 bundle。

**本地开发**：`dsh plugin --profile <p> add "link:<本目录绝对路径>"`。

> **不要用 `link:` 分发。** 它只建符号链接、**不解析依赖**，而且 profile 里记的是本机绝对路径 —— 换台机器直接失效。

## 前置条件

- **NDI 运行时**：装 [NDI 6 Runtime / Tools](https://ndi.video/tools/)。插件会自动找 `NDI_RUNTIME_DIR_V6` 和 `C:\Program Files\NDI\*\v6`。
- **一个 NDI 发送端**：VTube Studio 打开 NDI 输出，或 OBS 装 NDI 插件。没有源插件也能装，只是没画面。
- **Windows**（当前只在这上面验过）。

插件**刻意不认** VTube Studio 自带的旧 NDI 4.x：那份运行时发现不到现代源、也收不到帧，接上去只会得到一堆被误判成「网络问题」的失败。

## 自测

```powershell
node test/selftest.mjs
```

自带一个合成 NDI 测试图源，**不需要** VTube Studio 或 OBS 在跑。覆盖四个工具和错误路径，全 PASS 且 `exit 0` 才算通过。

## 原理

1. 用 koffi 直接调用 NDI 运行库 `Processing.NDI.Lib.x64.dll`，不依赖 NDI SDK 头文件，也不需要编译器。
2. 接收器跑在 **worker 线程**：`NDIlib_recv_capture_v2` 会阻塞到自己的时间片用完，放主线程会把整个 harness 卡住。
3. 抓到的 BGRA 帧转成 RGB、编码成 PNG，交给 harness 的附件服务 `attachments.saveImage()`；缩放与校验归 harness。
4. 工具返回值经 `output.render` 投影成 `image` 块，请求组装时把画面带给模型。

## 实测数据（NDI 6.3.2.0）

| 项目 | 结果 |
| --- | --- |
| 源声明帧率 | `30000/1001`（29.97fps） |
| 实际投递 | 30.0–30.5 fps，帧时间戳间隔 p50 33.3ms |
| 单帧像素拷贝 + 转换 | 约 1.4ms |
| 建接收器 → 首帧 | **2–4 秒**（NDI 本身如此，非本插件开销） |
| 复用已连好的源 | 约 45–80ms 出一帧 |

## 踩过的坑（都已修，别重复踩）

- **`NDIlib_video_frame_v2_t` 不能省字段**。`frame_rate_N/D` 和 `picture_aspect_ratio` 漏掉会让后面每个字段整体错位：FourCC 读成 `"ARGB"`、stride 变成 30000，看着像一帧解码成功，其实全是垃圾。正确布局：
  `xres, yres, FourCC, frame_rate_N, frame_rate_D, picture_aspect_ratio, frame_format_type, timecode, data*, stride, metadata*, timestamp`。
- **NDI 运行时是进程级的**。`NDIlib_destroy()` 会拆掉进程里所有接收器。所以**只让一个线程碰 NDI**：源发现也走 worker。早期版本在主线程另开实例做发现，收尾时 destroy 把 worker 正在用的运行时拆了 —— 表现是进程退出时 `0xC0000005` 访问违例。
- **worker 必须先释放接收器再退出**。对着正在 `recv_capture` 的线程调 `terminate()` 会崩。`stop()` 先发 `quit` 让 worker 自己 `recv_destroy` + `NDIlib_destroy`，退出码才干净。
- **`stop()` 里先清 `this.worker` 再发命令**是个陷阱：`request()` 见 worker 为 null 立即拒绝，quit 从没发出去，最后变成强杀正在接收的线程。必须直接 `postMessage`。
- **建接收器后要 2–4 秒才出首帧**。不等就会把这段算进延迟，看起来像「插件很慢」。现在 `connect` 只在**真有像素到了**才返回成功。
- **`bandwidth: lowest` 收不到任何帧**，必须用 `highest`(0)。
- **源名会被加上主机名前缀**：注册 `DSH NDI Test Pattern`，被发现成 `BLOODPEACH (DSH NDI Test Pattern)`。
- **FourCC 是小端整数**：BGRA 字段值是 `0x41524742`（字节拼出 B,G,R,A），写成 `0x42475241` 发不出帧。
- **fps 不能太早算**。连接爬坡期读数偏低（同一源先读 21.5、稳定后 30.0），现在要求统计窗口至少跨 1 秒。
- **harness 的 schema 校验不接受 `type` 数组**。可空字段写成可选键（值不存在就不输出），不要写 `type: ['string','null']`，否则插件激活时报 `JsonSchemaError`。

## 配置

在 `cordis.patch.yml` 的 `config` 里改（或装好后用插件面板改）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `libraryPath` | 自动 | NDI 运行库目录或 DLL 路径 |
| `preferredSource` | 空 | 自动挑源时优先匹配的子串 |
| `maxWidth` | 1280 | 抓帧最大宽度 |
| `announce` | true | 在系统提示里告诉模型它有 NDI 眼睛 |

## 许可

MIT。NDI 是 Vizrt 的商标，本插件只调用你本机已安装的 NDI 运行时，不附带其 SDK。
