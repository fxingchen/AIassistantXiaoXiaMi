# 小虾米 v0.0.8 - 文件操作能力升级

## 🎉 重大更新

小虾米现在具备了类似 CodeBuddy 的文件操作能力！可以直接读取、修改、搜索文件了。

## ✨ 新增功能

### 1. 文件读取 (read-file)
```
<tool name="read-file" path="src/main.py"></tool>
```
- 支持相对路径和绝对路径
- 返回文件内容、行数、大小
- 自动识别语言类型

### 2. 文件写入 (write-file)
```
<tool name="write-file" path="config.json">{"key": "value"}</tool>
```
- 创建新文件或覆盖现有文件
- 自动创建目录
- 弹窗确认机制

### 3. 文件修改 (replace-in-file)
```
<tool name="replace-in-file" path="app.js" oldStr="const x = 1" newStr="const x = 2"></tool>
```
- 精确替换内容
- 要求 oldStr 唯一
- 弹窗确认机制

### 4. 目录列表 (list-dir)
```
<tool name="list-dir" path="src"></tool>
```
- 显示文件和目录
- 过滤隐藏文件
- 显示图标（📄 📁）

### 5. 文件搜索 (search-files)
```
<tool name="search-files" pattern="*.js" path="src"></tool>
```
- 支持通配符
- 递归搜索
- 最多 100 结果

### 6. 内容搜索 (search-content)
```
<tool name="search-content" pattern="function\\s+\\w+" path="src" glob="*.js"></tool>
```
- 正则表达式匹配
- 文件类型过滤
- 显示行号

## 🔐 安全机制

所有文件修改操作都会：
1. 弹出确认对话框
2. 显示操作详情
3. 让用户选择确认或取消

## 📦 技术实现

### extension.js
新增 6 个工具处理函数：
- `_readFile()` - 读取文件
- `_writeFile()` - 写入文件
- `_replaceInFile()` - 修改文件
- `_listDir()` - 列出目录
- `_searchFiles()` - 搜索文件
- `_searchContent()` - 搜索内容

### webview.html
1. 扩展工具调用解析器，支持多种工具格式
2. 新增工具响应处理器
3. 更新系统提示词，添加工具使用说明

## 🎯 使用场景

### 场景1：分析项目
```
用户：帮我看看这个项目的结构
小虾米：<tool name="list-dir" path="."></tool>
```

### 场景2：查找代码
```
用户：找出所有使用了 axios 的地方
小虾米：<tool name="search-content" pattern="axios" path="." glob="*.js"></tool>
```

### 场景3：修改配置
```
用户：把 package.json 的版本改成 2.0.0
小虾米：<tool name="read-file" path="package.json"></tool>
<tool name="replace-in-file" path="package.json" oldStr='"version": "1.0.0"' newStr='"version": "2.0.0"'></tool>
```

### 场景4：创建文件
```
用户：创建一个 .gitignore 文件
小虾米：<tool name="write-file" path=".gitignore">node_modules/
.env
dist/
*.log</tool>
```

## 🔄 更新内容

### 文件修改
- `extension.js` - 新增 6 个工具处理函数
- `webview.html` - 扩展工具调用逻辑和系统提示词
- `package.json` - 版本更新到 0.0.8

### 新增文件
- `FILE_TOOLS_GUIDE.md` - 详细使用指南
- `FILE_TOOLS_RELEASE_NOTES.md` - 本更新说明

## 📝 版本对比

| 版本 | 功能 |
|------|------|
| 0.0.7 | 消息菜单、错误分析、反馈按钮 |
| 0.0.8 | 文件操作能力（读取、写入、修改、搜索） |

## 🚀 下一步

现在小虾米可以：
- ✅ 分析项目代码结构
- ✅ 重构代码
- ✅ 查找和修复 bug
- ✅ 创建和修改配置文件
- ✅ 自动化代码审查

## 💡 提示

工具调用格式：
```
<tool name="工具名" 属性="值">内容</tool>
```

执行结果会以 `<result>...</result>` 形式返回，AI 会根据结果继续推理。

---

**小虾米越来越强大了！🐱**
