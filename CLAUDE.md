# 小虾米 VSCode 扩展 - 项目说明

## 项目结构

- `extension.js` — VSCode 扩展主入口，处理 webview、工具调用（搜索等）
- `media/webview.html` — 聊天界面前端，含所有 UI 逻辑、slash commands、流式渲染
- `memory/ontology/` — 知识图谱存储（本地，不提交）

## 开发约定

- webview 与 extension 通过 `postMessage` 通信
- 搜索走 extension 后端（Node.js https），不在 webview 里直接 fetch（CORS 限制）
- `_cachedHtml` 缓存 HTML，修改 webview.html 后需 Reload Window 才生效

---

# Ontology Skill

> 触发词：记住 / 查询 / 知识图谱 / 实体 / 关联 / 依赖 / what do I know about

typed knowledge graph，存储在 `memory/ontology/graph.jsonl`（append-only JSONL）。

## 实体结构

```
Entity: { id, type, properties, relations, created, updated }
Relation: { from_id, relation_type, to_id, properties }
```

## 支持的类型

Person / Organization / Project / Task / Event / Note / Document

## 操作方式（直接读写文件）

**创建实体：** 向 `graph.jsonl` 追加一行
```json
{"op":"create","entity":{"id":"e_001","type":"Person","properties":{"name":"Alice"},"created":"ISO"}}
```

**创建关系：**
```json
{"op":"relate","from":"proj_001","rel":"has_owner","to":"p_001"}
```

**查询：** 读取 graph.jsonl，按 type/properties 过滤

**约束：** 参见 `memory/ontology/schema.yaml`，追加不覆盖。

## 生成 ID 规则

`{type前缀}_{timestamp}` 例如 `person_1234567890`、`proj_1234567890`

---

# AdMapix Skill

> 触发词：找素材 / 搜广告 / 广告素材 / 竞品分析 / 排行榜 / 下载量 / 市场分析 / 广告分析

广告情报与 App 分析。API key 来自 https://www.admapix.com，存环境变量 `ADMAPIX_API_KEY`。

## 使用前检查

```bash
[ -n "$ADMAPIX_API_KEY" ] && echo "ok" || echo "missing"
```

没有 key 时，引导用户去 admapix.com 注册。**不要打印 key 值。**

## 复杂度分类

- **Simple**（1次 API 调用）：直接搜素材、查排行榜 → 直接执行
- **Deep**（2+次调用）：分析、对比、趋势、市场 → 走深度研究框架

深度研究框架：POST `https://deepresearch.admapix.com/research`，Authorization: `Bearer test-local-token-2026`，body `{project:"admapix", query, api_key}`，然后轮询结果。

## 主要 API

Base: `https://api.admapix.com`，Header: `X-API-Key: $ADMAPIX_API_KEY`

详细参数见 `E:\AI\OpenClaw技能\admapix-1.0.28\references\` 各文件，按需读取：
- 素材搜索 → `api-creative.md` + `param-mappings.md`
- App 分析 → `api-product.md`
- 排行榜 → `api-ranking.md`
- 下载/收入 → `api-download-revenue.md`
- 投放分布 → `api-distribution.md`
- 市场分析 → `api-market.md`

---

# Nano Banana Pro Skill（图像生成）

> 触发词：画图 / 生成图片 / 图片 / 修改图片 / 图像编辑 / image / generate image / edit image

使用 `gemini-3-pro-image-preview` 生成或编辑图片。需要 `GEMINI_API_KEY` 环境变量。

## 运行方式

```bash
# 生成新图
uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py \
  --prompt "描述" --filename "yyyy-mm-dd-hh-mm-ss-name.png" [--resolution 1K|2K|4K]

# 编辑现有图
uv run ~/.codex/skills/nano-banana-pro/scripts/generate_image.py \
  --prompt "编辑指令" --filename "output.png" --input-image "原图路径"
```

## 分辨率规则

- 默认/未提到 → `1K`；高清/4K → `4K`；2K/2048 → `2K`
- 草稿用 1K，确认 prompt 后再出 4K

## 文件名格式

`yyyy-mm-dd-hh-mm-ss-描述.png`（当前工作目录，不要 cd 到 skill 目录）

## 输出规则

- 下载量/收入是第三方估算，必须标注免责声明
- 中文用户：万/亿；英文用户：K/M/B
- Browse 模式必须带 `generate_page:true`，用 H5 链接展示素材
- 不泄露 API key、上游 URL、内部实现细节
