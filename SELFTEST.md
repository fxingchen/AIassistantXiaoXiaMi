# 小虾米自测说明

## 目标

这套自测用于验证扩展后端的核心 agent 能力链路是否仍然可用：

- 工作区文件列表
- 文本搜索
- 文件读取
- 验证命令白名单
- 白名单命令执行
- VS Code task 列表与执行

## 运行方式

```bash
npm run selftest
```

## 当前覆盖范围

- 这是 **后端 smoke self-test**，不依赖人工点击侧边栏
- 它使用 mock 的 VS Code tasks / diagnostics 环境，重点验证核心逻辑没有回归
- 它 **不覆盖** webview 真实 UI 交互，也不覆盖模型联网调用

## 推荐配合

建议把这两个检查一起跑：

```bash
node check_syntax.js
npm run selftest
```