# 小虾米文件操作能力说明

## ✨ 新增功能

小虾米现在具备了类似 CodeBuddy 的文件操作能力！可以直接读取、修改、搜索文件了。

## 🛠️ 可用工具

### 1. 读取文件 (read-file)
读取指定文件的内容。

**格式：**
```
<tool name="read-file" path="文件路径"></tool>
```

**示例：**
```
<tool name="read-file" path="src/main.py"></tool>
<tool name="read-file" path="config.json"></tool>
<tool name="read-file" path="README.md"></tool>
```

**特点：**
- 支持相对路径（相对于工作区根目录）
- 支持绝对路径
- 返回文件内容、行数、大小
- 自动识别文件语言类型

---

### 2. 写入文件 (write-file)
创建新文件或覆盖现有文件。

**格式：**
```
<tool name="write-file" path="文件路径">文件内容</tool>
```

**示例：**
```
<tool name="write-file" path="config.json">{"name": "test", "version": "1.0"}</tool>
```

**特点：**
- 会提示用户确认是否覆盖现有文件
- 自动创建不存在的目录
- 显示写入的字节数

---

### 3. 修改文件 (replace-in-file)
精确替换文件中的内容。

**格式：**
```
<tool name="replace-in-file" path="文件路径" oldStr="原内容" newStr="新内容"></tool>
```

**示例：**
```
<tool name="replace-in-file" path="app.js" oldStr="const x = 1" newStr="const x = 2"></tool>
```

**特点：**
- oldStr 必须在文件中唯一，否则会报错
- 会提示用户确认修改
- 显示替换次数

---

### 4. 列出目录 (list-dir)
查看目录下的文件和子目录。

**格式：**
```
<tool name="list-dir" path="目录路径"></tool>
```

**示例：**
```
<tool name="list-dir" path="src"></tool>
<tool name="list-dir" path="."></tool>
```

**特点：**
- 显示文件和目录图标（📄 📁）
- 自动过滤隐藏文件
- 显示项目总数

---

### 5. 搜索文件 (search-files)
根据文件名模式搜索文件。

**格式：**
```
<tool name="search-files" pattern="通配符" path="搜索路径"></tool>
```

**示例：**
```
<tool name="search-files" pattern="*.js" path="src"></tool>
<tool name="search-files" pattern="**/*.ts" path="."></tool>
<tool name="search-files" pattern="test-*.py" path="tests"></tool>
```

**特点：**
- 支持通配符：* 匹配任意字符，** 递归匹配
- 显示相对路径
- 限制最多 100 个结果

---

### 6. 搜索内容 (search-content)
在文件中搜索特定内容。

**格式：**
```
<tool name="search-content" pattern="正则表达式" path="搜索路径" glob="文件过滤"></tool>
```

**示例：**
```
<tool name="search-content" pattern="function\\s+\\w+" path="src" glob="*.js"></tool>
<tool name="search-content" pattern="import.*from" path="." glob="*.ts"></tool>
<tool name="search-content" pattern="TODO|FIXME" path="src" glob="*.py"></tool>
```

**特点：**
- pattern 使用正则表达式
- glob 过滤文件类型
- 显示匹配行号和内容
- 限制最多 100 个匹配

---

## 🔐 安全机制

所有文件修改操作（write-file, replace-in-file）都会：
1. 弹出确认对话框
2. 显示操作详情
3. 让用户选择"确认"或"取消"

这确保了 AI 不会在用户不知情的情况下修改文件。

---

## 💡 使用场景

### 场景1：分析项目结构
```
用户：帮我看看这个项目的结构

小虾米：<tool name="list-dir" path="."></tool>
（执行后返回目录结构）
```

### 场景2：查找特定代码
```
用户：找出所有使用了 axios 的地方

小虾米：<tool name="search-content" pattern="axios" path="." glob="*.js"></tool>
（执行后返回所有匹配位置）
```

### 场景3：修改配置
```
用户：把 package.json 里的版本号改成 2.0.0

小虾米：<tool name="read-file" path="package.json"></tool>
（读取后找到当前版本）
<tool name="replace-in-file" path="package.json" oldStr='"version": "1.0.0"' newStr='"version": "2.0.0"'></tool>
（弹出确认对话框，用户确认后修改）
```

### 场景4：创建新文件
```
用户：创建一个 .gitignore 文件

小虾米：<tool name="write-file" path=".gitignore">node_modules/
.env
dist/
*.log</tool>
（弹出确认对话框，用户确认后创建）
```

---

## 🎯 与 CodeBuddy 的对比

| 功能 | CodeBuddy | 小虾米 |
|------|-----------|--------|
| 读取文件 | ✅ | ✅ |
| 写入文件 | ✅ | ✅ |
| 修改文件 | ✅ | ✅ |
| 搜索文件 | ✅ | ✅ |
| 搜索内容 | ✅ | ✅ |
| 执行命令 | ✅ | ✅（受限） |
| 权限确认 | 自动 | 弹窗确认 |

---

## 📝 注意事项

1. **相对路径**：相对于工作区根目录
2. **文件大小**：读取限制 50000 字符，搜索限制 3000 字符
3. **结果数量**：搜索最多返回 100 个结果
4. **编码格式**：统一使用 UTF-8
5. **隐藏文件**：自动过滤以 `.` 开头的文件

---

## 🚀 下一步

现在你可以让小虾米：
- 分析项目代码结构
- 重构代码
- 查找和修复 bug
- 创建和修改配置文件
- 自动化代码审查

享受 AI 辅助编程的乐趣吧！🐱
