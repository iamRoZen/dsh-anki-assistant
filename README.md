# Anki Assistant

Anki Assistant 是 DeepSeek Harness（DSH）的制卡预设。你给出学习目标，Agent 可以帮你设计牌组，从教材、讲义、题库和网页中选材，再按试过的方案批量制卡。它也能通过 AnkiConnect 对 Anki 笔记库做增删改查（CRUD）。

## AI 已经会操作 Anki，为什么还要写这个预设？

用 Anki 学一门课，常常是教材和习题都在手边，却缺一副适合自己复习的牌组。AI 已经能代劳填字段、写 HTML 和逐张录入这些活。可只说一句「把这一章做成卡」，拿到的可能是一批排版整齐的段落摘要。等到合上书，才发现自己想练的那一步根本没被问到。

- 复核一批**数学推导卡**时，发现有的草稿省掉了「函数连续」这样的前提。修订时补回适用条件，推导中每一步只写一次变形。翻面核对时，就能看出自己忘了哪个条件，或是在哪一步接不下去。[这批高数卡的修改记录](examples/schemes/gaoshu-steps/evidence.md)
- 假设一张**医学辨析卡**让人分别复述两种贫血的定义。即使两段都背得出，仍可能把某项特征记反。可以把题面改成「缺铁性贫血和巨幼细胞性贫血的典型红细胞形态有何不同？」，背面按同一项特征对照教材的描述，保留限定语和出处。

我希望花在改第一批卡上的工夫，做下一章时还能用得上。Agent 可以从改动里提炼经验，把「逐步核对每次变形的前提」写进推导方案，把「选定同一项特征作对照」写进辨析方案。每份**制卡方案**都可以带上样卡、适用范围和检查规则，再拿一节新材料试做。后续批次可以沿用试过的版本，让同类卡保持一致的问法和格式。等真正复习过，答不好的卡又能成为修订方案的反例。

## 第一次做卡

在 **Anki Assistant** 会话里告诉 Agent 你要学什么，以及材料在哪里。比如准备一章高数的牌组，可以直接说出自己做题时卡在哪里。

> 教材和习题在这个目录。我记得公式，做题却经常卡在中间一步。请从这一章挑一段推导做张样卡，再做一张考定理适用条件的卡。把正反面和对应的教材页码给我看，我们再定整章的做法。

Agent 可以用 DSH 的文件和网页工具查阅资料，把用到的来源记在项目里。教材 PDF 可以定位到页和行，以后发现两份讲义说法不同，还能带着卡片回查原文。

新装时方案库是空的，可以从刚改好的样卡起草方案。要试已有方案，把本地仓库里 `examples/schemes/gaoshu-steps` 目录的完整路径发给 Agent，请它导入。这个示例使用自定义笔记类型，写入前要核对字段，运行其中的脚本时要在插件设置中启用导入的版本。[高数方案的字段、样卡与检查规则](examples/schemes/gaoshu-steps/body.md)

准备写入时，告诉 AI 目标牌组和笔记类型。`card_write plan` 会读取 Anki，检查字段和重复项，列出哪些题可写、哪些题受阻。你可以按计划预览卡面，改过草稿就重新生成计划。确认后，AI 用 `commit` 写入，再用 `verify` 把 Anki 里保存的字段与提交时的快照逐项比较。如果中途断线，重试同一个计划会沿用已写条目的回执。[线性代数样卡的正反面](screenshots/cards.png)

## 安装

1. 准备 Node.js 22.19 或更高版本，以及 DeepSeek Harness Desktop（插件支持的 DSH 版本为 `>=0.2.2-rc.3 <0.3.0`）。下载或克隆本仓库，在仓库根目录运行 `npm install --omit=dev`。
2. 在 DSH Desktop 的「插件」页添加插件，填入本地仓库的绝对路径。安装后重启 Desktop，新建会话并选择 **Anki Assistant**。[DSH 插件安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md#installing-a-bundle)
3. 要生成写入计划、写卡或按自己的笔记模板预览，请在 Anki 桌面版安装 AnkiConnect 并打开 Anki。[AnkiConnect 安装页](https://ankiweb.net/shared/info/2055492159)

## 使用方法

安装并重启 Desktop 后，新建一个会话。在模式选择里（标准模式、PTC 模式等选项的列表）**拉到最下面**，选择 **Anki Assistant**。

只有这个模式的会话能看到制卡工具；其他模式的会话不受影响。进入后直接说你要做什么，例如：

> 教材和习题在这个目录。先看这一章，做两张样卡给我看，我们再定整章的做法。

## 预设、方案和项目各管什么

预设提供各学科共用的工具和工作约定。方案保存某一类卡的具体做法。比如做图谱题，遮住哪个标注、怎么裁图、需要哪个脚本，都属于图谱方案。项目则留给手头这本书或这门课，记录读到了哪一页、这次舍弃了哪些题、哪几张样卡值得保留。

| 工具 | 用途 |
| --- | --- |
| `materials` | 按行读文本，按页和行读 PDF，也可以用关键词回查原文。 |
| `project` | 保存一次任务的资料、取舍和样卡。做完后可以从项目提炼出方案草稿。 |
| `scheme` | 新建、导入、测试和修订方案。每次保存都产生新版本，已有批次继续使用开工时选定的版本。 |
| `batch` | 逐题保存草稿、状态和校验发现的问题，中断后可以继续。 |
| `card_preview` | 按笔记模板预览卡片正反面，可生成 HTML、PNG 或 PDF。 |
| `card_write` | 为新增或修改笔记生成计划，按计划提交并回读核对。删除需要单独确认。 |
| `practice` | 记录一次实际制卡用了哪个版本、遇到什么问题、最后做出了什么。 |

方案、项目、批次、写入计划和回执都存在本机。默认目录是 `~/.dsh/anki-assistant/`，设置了 `DSH_HOME` 时则位于它的 `anki-assistant/` 子目录。

<details>
<summary>连接设置与可选依赖</summary>

需要调整默认设置时，在 DSH profile 中配置 `preset-anki-assistant` 下的 `anki-assistant` 项，改完重启 Desktop。

| 配置项 | 作用 |
| --- | --- |
| `dataDir` | 指定存放方案和工作记录的目录。 |
| `ankiUrl` | AnkiConnect 地址，默认 `http://127.0.0.1:8765`。 |
| `autoLaunchAnki` / `ankiExe` | 控制是否尝试启动 Anki，以及使用哪个可执行文件。 |
| `python` | 指定运行方案脚本的 Python 命令。 |
| `trustedSchemeVersions` | 要运行外部或旧方案自带的脚本时，在列表中填入审阅过的 `id@版本号`。 |

PDF 文本提取使用可选依赖 `pdfjs-dist`，导出 PNG 或 PDF 使用 Microsoft Edge。用到 Python 包的方案可以在自己的 `requirements.txt` 中声明依赖，`scheme test` 会检查缺哪些包，再由使用者安装。

</details>

## 文档与开发

- 编写自己的方案可从样卡、反例和验收标准入手。[方案格式](docs/SCHEME-FORMAT.md)
- 工具参数、写入流程和版本迁移见[执行手册](docs/AGENT-BRIEF.md)、[设计说明](docs/DETAIL.md)和[迁移指南](docs/MIGRATION.md)。
- 在仓库根目录用 `npm test` 运行测试，用 `npm run verify:package` 检查打包内容。[贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md)

本项目采用 [MIT 许可证](LICENSE)。
