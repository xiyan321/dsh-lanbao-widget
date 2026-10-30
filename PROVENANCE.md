# 素材来源与许可范围（PROVENANCE）

本仓库的**代码**按 MIT 许可（见 [`LICENSE`](LICENSE)）。角色美术素材不在 MIT 覆盖范围内，
按下文「原样提供」。这样划分的理由：代码可以明确授权，而美术素材的来源与权利状态往往
无法百分之百举证 —— 与其给一个站不住的授权，不如如实标注范围，并承诺收到权利主张就处理。

## 一、许可范围

| 范围 | 许可 |
|---|---|
| `lib/`、`assets/lanbao-widget.js`、`tools/`、`cordis.patch.yml`、`package.json`、文档 | **MIT**（见 `LICENSE`） |
| `assets/expressions/**`（五张透明底表情，WebP） | **不适用 MIT**：由作者提供的设计稿经脚本处理而来，仅随本插件分发、仅用于运行本插件 |
| `assets/source/**`（五张设计稿 JPEG，1024 长边） | **不适用 MIT**：同属角色美术素材，作为可复现处理的输入一并附带 |
| `docs/design-sheet.jpg`（角色设定图：配色、发型、鲨鱼帽鳍等标注） | **不适用 MIT**：角色设定资料，仅供识别本角色 |
| `icon.png`（插件列表图标） | **不适用 MIT**：由 `assets/expressions/happy.webp` 裁切合成，仅用于标识本插件 |
| `docs/preview.png`、`docs/live-panel.png`、`tools/shots/**`（截图） | **不适用 MIT**：插件界面截图，含角色形象 |

## 二、逐项来源

| 文件 | 来源 / 说明 |
|---|---|
| `assets/source/{idle,thinking,busy,happy,confused}.jpg` | 来自作者提供的「蓝宝形象设计」设计稿（待机 / 思考 / 忙碌 / 开心 / 疑惑），AI 图像工具生成后由作者挑选。`tools/import-sources.mjs` 将其缩至 1024 长边、以 JPEG q92 重编码存档。 |
| `assets/expressions/*.webp` | 由 `tools/prepare-images.mjs` 从上一行素材完全脚本化生成：抠白底（只对最后一行封口，避免把白色帽兜抠穿）→ alpha 羽化 → 五图共用方形裁切框 → 640×640 WebP（带 alpha）。 |
| `docs/design-sheet.jpg` | 同一批设计稿中的角色设定图（配色：深海蓝 / 浅蓝 / 白色；特征：凌乱刘海、翘发尾、鲨鱼帽鳍、小鱼别针、双肩带）。 |
| `icon.png` | `tools/make-icon.mjs` 用 `happy.webp` 合成到浅蓝渐变圆角底上，256×256。 |

### 元数据清理

`tools/import-sources.mjs`、`tools/prepare-images.mjs`、`tools/make-icon.mjs` 全部使用 sharp
重新编码输出，sharp 默认**不写回** EXIF / XMP，因此仓库内的素材不含原始文件的工具名、
账号 id 等内嵌元数据。

## 三、代码参考

本插件的宿主端接线方式（`webServer.register` 注册静态资源路由、`webserver/index-inject`
注入脚本、`credentials.resolve('DEEPSEEK_API_KEY')` 读密钥、调用
`https://api.deepseek.com/user/balance`、订阅 `session/event` 计算「本轮花费」）参考了
同类插件 **DeepSeek 小鲸鱼记账挂件** 的实现：

- 项目：`DeepSeek-Balance-Whale-Widget`
- 作者：**MeteorNOX**
- 地址：https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget
- 许可：MIT（`Copyright (c) 2026 MeteorNOX`）

借用的是**接口用法与整体思路**，本仓库的代码为重新实现：状态机、五档余额模型、浏览器端
组件、样式、台词与全部工具脚本均为原创，未复制其源码或美术素材。若后续需要搬运具体代码
片段，请在该文件头部保留 MeteorNOX 的 MIT 版权声明。

## 四、权利主张 / Takedown

如果你认为 `assets/` 或 `docs/` 中有素材侵犯了你的权利，请在本仓库开一条 issue，说明
**文件名**与**依据**，我们会在核实后**立即替换或移除**，不附加其它条件。也欢迎直接提供
可自由再分发的替代素材。
