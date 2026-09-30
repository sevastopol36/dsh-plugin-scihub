# SciHub Papers for DSH

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供学术文献检索与全文获取能力的原生 Cordis 插件。

**一个查询 → 5 个元数据源 → 归并去重 → Sci-Hub 镜像优先取全文 → 不可达时按可访问性回退其他开放获取渠道。**

- **多源检索** — Crossref、OpenAlex、Europe PMC、**PubMed**、Semantic Scholar 并行检索并归并去重（arXiv、DOAJ 可选）
- **任意标识符互转** — DOI ⇄ PMID ⇄ PMCID ⇄ arXiv id，支持 doi.org / pubmed / pmc / arxiv 链接与标题
- **Sci-Hub 优先** — 默认先试 Sci-Hub 镜像；取不到时自动回退到 arXiv / PMC / Europe PMC / Unpaywall / OpenAlex / 出版商等
- **自带诊断** — `sevastopol36_scihub_probe` 实测镜像与渠道可用性，并给出可直接粘贴的配置
- **零运行时依赖** — 只用 Node 内置 `fetch` / `node:fs`

> ⚠️ Sci-Hub 仅用于学术/教育用途，请尊重版权。若希望优先走合法开放获取渠道，设置 `preferSciHub: false` 即可调换顺序。

## 提供的工具

| 工具 | 功能 |
|---|---|
| `sevastopol36_scihub_search` | 跨源检索论文元数据（标题、作者、年份、期刊、DOI、PMID、PMCID、arXiv id、被引数），归并去重后按相关度排序 |
| `sevastopol36_scihub_resolve` | 任意标识符（DOI / PMID / PMCID / arXiv id / 链接 / 标题）→ 完整标识符集合 + 引用链接（可选：实测 OA 全文位置） |
| `sevastopol36_scihub_fetch` | 下载全文并保存，报告来源与失败路线 |
| `sevastopol36_scihub_probe` | 实测每个 Sci-Hub 镜像（延迟 + 失败原因）与每个 OA 渠道 API 的连通性 |
| `sevastopol36_scihub_sources` | 列出全部数据源、路线、镜像与当前配置 |

### 使用示例

> “帮我下载《Attention Is All You Need》这篇论文”

```
sevastopol36_scihub_search  → 找到 arXiv:1706.03762 / DOI 10.48550/arXiv.1706.03762
sevastopol36_scihub_resolve → 补齐 PMID / PMCID，确认是同一篇
sevastopol36_scihub_fetch   → 保存 PDF 并返回路径
```

## 全文获取路线（默认顺序）

默认 `preferSciHub: true`：**Sci-Hub 优先**，取不到再按可访问性回退其他渠道。

| # | 路线 | 说明 |
|---|---|---|
| 1 | arXiv PDF | 已知 arXiv id 时——arXiv 论文的正式出处，也最快 |
| 2 | **Sci-Hub 镜像** | 主渠道，逐镜像尝试（见下） |
| 3 | bioRxiv / medRxiv | 预印本 |
| 4 | PubMed Central (PMC) | `citation_pdf_url`，自动跟随 bot-check 跳转 |
| 5 | Europe PMC | OA 全文 |
| 6 | Unpaywall | 全部 OA 位置（不只是 best） |
| 7 | OpenAlex | OA locations |
| 8 | Semantic Scholar | `openAccessPdf` |
| 9 | 出版商页面 | `citation_pdf_url`，带 cookie 跟随 meta-refresh |
| 10 | ar5iv HTML | 最后兜底，保存 HTML 而非 PDF |

设置 `preferSciHub: false` 后顺序变为：arXiv → bioRxiv/medRxiv → PMC → Europe PMC →
Unpaywall → OpenAlex → Semantic Scholar → 出版商 → **Sci-Hub** → ar5iv，即完全避免
Sci-Hub 处理本来就开放获取的论文。设置 `openAccessFallback: false` 则整组开放
获取路线都不再尝试。

## Sci-Hub 镜像（实测，2026-02）

默认列表按测得的延迟排序，全部经**下载 + 内容校验**确认能取到正确论文。
失效镜像分两类保存，可用 `sevastopol36_scihub_probe include_known_dead=true` 复查是否恢复。

```yaml
mirrors:
  - 'https://sci-hub.ren'           #  852ms 实测可用（含内容校验）
  - 'https://sci-hub.in'            # 1240ms 实测可用
  - 'https://sci-hub.ee'            # 1384ms 实测可用
  - 'https://sci-hub.mk'            # 2864ms 实测可用
  - 'https://sci-hub.al'            # 3043ms 实测可用
  - 'https://sci-hub.hkvisa.net'    # 1951ms 实测可用
  - 'https://sci-hub.vg'            # 4557ms 实测可用
  - 'https://sci-hub.usualwant.com' # 4017ms 实测可用
  - 'https://sci-hub.mksa.top'      # 3814ms 实测可用
  - 'https://sci-hub.ru'            # 唯一独立后端，但有间歇性验证墙，故排最后
```

两点关键事实：

1. **前九个镜像共享同一个后端**（`sci.bban.top`），因此这张列表提供的是 DNS/线路
   冗余，而非语料差异。
2. **`sci-hub.ru` 是唯一使用自己存储后端**（`sci-hub.red/storage/...`）的镜像，
   其 PDF 通过 `<object data=…>` 标签给出。它能取到别的后端没有的论文，但会间歇性
   返回 "are you a robot?" 验证墙，因此放在最后：它的重试不会拖慢前九个镜像。

### 失效镜像分两类

| 列表 | 含义 | 例子 |
|---|---|---|
| `ON_SITE_DEAD_MIRRORS` | 站点有响应但不提供 PDF | `sci-hub.st`（403）、`sci-hub.red`（502）、`sci-hub.yt`（无 PDF 链接） |
| `KNOWN_DEAD_MIRRORS` | 域名已不存在 | `sci-hub.se` / `.es` / `.tw` / `.glass` / `.box` / `.pro` … |

`sci-hub.shop` **不是镜像站**，其镜像表格由前端 JS 渲染，无法作为镜像源抓取。

### 防止保存错误论文

PDF 的 `%PDF-` 魔数只能证明“下载到了一个 PDF”，不能证明“下载到了这篇论文”。
插件因此额外做两件事：

- `isSelfReferentialPdfLink` —— 某些镜像对**不存在的 DOI** 会把文章页 URL 本身当作
  “PDF 链接”返回（实测 `sci-hub.vg` / `.ee`）；这种链接在下载前就被拒绝。
- `verifyPdfContent`（`verifyPdf: true`，默认开启）—— 从 PDF 元数据与首个解压流中
  读出 DOI，回退到标题相似度；明显不匹配则拒绝并尝试下一个候选。体量较大且结构正常
  的 PDF 会被信任接受，以免误伤正常论文。

## 安装

本插件是标准 dsh bundle（声明了 `dsh.bundle.patch`）：

```bash
dsh plugin --profile web add dsh-plugin-scihub
# 或从本地目录
dsh plugin --profile web add ./dsh-plugin-scihub
```

安装后需重启 profile：`dsh web`

## 配置

在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 按 id 覆盖：

```yaml
- id: sevastopol36-scihub
  config:
    downloadDir: 'papers'
    # ⚠️ Unpaywall 会拒绝 example.com 地址（HTTP 422），请填真实邮箱
    email: 'you@example.com'
    mirrors: [...]              # 见上
    preferSciHub: true          # true=先试 Sci-Hub；false=先走开放获取
    timeoutMs: 30000            # 单次请求
    lookupTimeoutMs: 10000      # 单个标识符源
    resolveDeadlineMs: 60000    # 标识符解析总预算
    searchRows: 8
    openAccessFallback: true    # Sci-Hub 失败后是否回退开放获取
    verifyPdf: true             # 校验下载到的 PDF 确实是目标论文
    # 可选：NCBI API key（免费申请），把 E-utilities 限额从 3 次/秒提到 10 次/秒
    # 申请：https://account.ncbi.nlm.nih.gov/settings/
    ncbiApiKey: ''
    allowHtmlFallback: true
    titleConfidence: 0.6
    searchProviders: [crossref, openalex, europepmc, pubmed, semanticscholar]
```

### PubMed 相关说明

- E-utilities 全部请求已串行化限流（无 key 间隔 360ms，有 key 120ms），因此并发检索
  不会触发 HTTP 429 而静默丢结果。
- Europe PMC 响应很慢（实测常 >20s 或 503），因此它排在最后并只给 6 秒预算，只用于
  补充元数据；标识符本身由 NCBI ID Converter（~0.7–2.5s）与 Crossref（~0.5s）提供。
- 命中 PMCID 后标识符已齐全时会**提前结束**，不再空跑 OpenAlex / Semantic Scholar。

### 镜像/渠道失效怎么办

```text
sevastopol36_scihub_probe                              # 实测 + 下载校验，并给出建议 mirrors 列表
sevastopol36_scihub_probe include_known_dead=true      # 复查已失效镜像是否恢复
sevastopol36_scihub_probe channels_only=true           # 只检查 API 渠道
```

## 开发

```bash
node test/smoke-ext.mjs            # 全部测试（离线 + 联网）
node test/smoke-ext.mjs offline    # 只跑离线单元测试
```

## 架构

```
dsh-plugin-scihub/
├── package.json          # dsh.bundle.patch -> cordis.patch.yml
├── cordis.patch.yml      # 注册行: - id: sevastopol36-scihub
└── lib/
    ├── index.mjs         # 插件入口：Config + 5 个工具
    ├── util.mjs          # HTTP/超时/重试、标识符解析、标题匹配、PDF 下载
    ├── sources.mjs       # 各数据源适配器 + PaperStore 归并
    ├── search.mjs        # 多源并行检索、排序、标题解析
    └── resolve.mjs       # 标识符解析 + 全文获取级联 + 镜像诊断
```

设计要点：

- **每个路线独立预算**（`ROUTE_BUDGET`），单个卡住的路线不会吃掉整次抓取的时间
- **主机熔断**：某主机超时/拒连后 10 分钟内不再重试
- **标题门槛**：1–3 个词的查询必须近乎完全一致（词二元组匹配），避免模糊查询静默命中错误论文
- **来源质量加权**：排序时优先期刊论文/PubMed 收录，压低镜像站 `posted-content`
- **PDF 魔数校验**：只有 `%PDF-` 开头的响应才会被接受——很多“OA 链接”实际返回 HTML
- **Sci-Hub 优先但有界**：镜像逐个尝试，每个镜像独立超时；全部失败才回退开放获取

## License

MIT

## English

Native Cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
search academic literature across five metadata providers and download the full text.

- **Multi-source search** — Crossref, OpenAlex, Europe PMC, PubMed and Semantic Scholar queried in
  parallel and merged, then de-duplicated and ranked (arXiv and DOAJ available on request).
- **Any identifier, either direction** — DOI, PMID, PMCID and arXiv id, from plain ids, doi.org /
  pubmed / pmc / arxiv URLs, or an exact title.
- **Full text, open access first** — arXiv, bioRxiv/medRxiv, PMC, Europe PMC, Unpaywall, OpenAlex,
  Semantic Scholar and publisher landing pages, then Sci-Hub mirrors, then ar5iv HTML.
- **Content-checked downloads** — the saved PDF is verified against the requested DOI or title, so a
  paywall page or the wrong paper is rejected and the next route is tried.
- **Live diagnostics** — `sevastopol36_scihub_probe` measures every mirror and channel and prints a
  paste-ready config; `sevastopol36_scihub_sources` lists the active routes.
- **Zero runtime dependencies** — Node's built-in `fetch` and `node:fs` only.

> Sci-Hub is intended for academic and educational access; respect copyright and your institution's
> policy. Set `preferSciHub: false` to try the publisher-sanctioned open-access routes first.

### Install

```bash
# Straight from GitHub (pnpm clones the repository)
dsh plugin --profile web add github:sevastopol36/dsh-plugin-scihub

# Or clone first and install from the local directory
git clone https://github.com/sevastopol36/dsh-plugin-scihub.git
dsh plugin --profile web add ./dsh-plugin-scihub
```

The repository ships prebuilt ESM, so **no build step and no `allowBuilds`
approval is needed**. Restart the profile afterwards (`dsh web`), or add the
directory on the plugin page of the DSH desktop app.

### Names

Every public identifier carries the publisher namespace `sevastopol36`, which is
what the harness needs to keep two plugins from colliding — a duplicate tool name
in one scope is rejected with `tool "X" is already registered`. The full
declaration is in [`dsh-plugin.naming.json`](./dsh-plugin.naming.json).

| Surface | Value |
|---|---|
| npm package | `dsh-plugin-scihub` |
| plugin module name | `sevastopol36-scihub` |
| loader row id | `sevastopol36-scihub` |
| tools | `sevastopol36_scihub_search`, `sevastopol36_scihub_resolve`, `sevastopol36_scihub_fetch`, `sevastopol36_scihub_probe`, `sevastopol36_scihub_sources` |

### Verify

```bash
node verify.mjs            # offline: 25 assertions, no network, no install
node verify.mjs --live     # add the network checks; unreachable hosts report as skipped, not failed
VERIFY_STRICT=1 node verify.mjs --live   # treat the network checks as hard failures
```

`verify.mjs` checks the plugin's export shape, its `dsh.bundle.patch`
declaration, that the declared tool names match `dsh-plugin.naming.json`, and
that every `@deepseek-ai/dsh*` peer range accepts the runtimes listed in
`dsh.compatibility.verifiedRuntimes`. `BUILD-INFO.json` records the sha256 of
every published file, so a reader can confirm the code here is the code that was
tested.

### License

MIT.

---

### 从本仓库安装

本插件是预构建的纯 ESM 源码，仓库里的 `lib/` 就是可运行产物，**不需要任何构建步骤或
`allowBuilds` 授权**：

```bash
# 从 GitHub 直接安装（pnpm 会 clone 本仓库）
dsh plugin --profile web add github:sevastopol36/dsh-plugin-scihub

# 或先 clone，再从本地目录安装
git clone https://github.com/sevastopol36/dsh-plugin-scihub.git
dsh plugin --profile web add ./dsh-plugin-scihub
```

安装后重启 profile（`dsh web`），或在 DSH 桌面端的插件页里添加该目录。

### 命名

所有对外标识符都带发布者命名空间 `sevastopol36`——宿主对同一作用域内的重名工具会直接
拒绝（`tool "X" is already registered`），带前缀才能与他人插件共存。完整声明见
[`dsh-plugin.naming.json`](./dsh-plugin.naming.json)。

### 验证

```bash
node verify.mjs            # 离线：25 项断言，不联网、不装依赖
node verify.mjs --live     # 追加联网检查；网络不可达时标记为 skip 而非失败
VERIFY_STRICT=1 node verify.mjs --live   # 把联网检查也当作硬性失败
```

`verify.mjs` 会校验插件导出形态、`dsh.bundle.patch` 声明、工具名与
`dsh-plugin.naming.json` 是否一致，以及每个 `@deepseek-ai/dsh*` peer 范围是否接受
`package.json` 中 `dsh.compatibility.verifiedRuntimes` 列出的运行时。
`BUILD-INFO.json` 记录了每个发布文件的 sha256，可用来确认仓库里的代码就是经过测试的那份。

### 许可

MIT。