const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..');

function assertWebviewScriptsParse() {
  const html = fs.readFileSync(path.join(workspaceRoot, 'media', 'webview.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);

  assert(scripts.length >= 1, 'webview.html 应至少包含一个 script 标签');
  scripts.forEach((scriptContent, index) => {
    assert.doesNotThrow(() => {
      new Function(scriptContent);
    }, `webview.html 第 ${index + 1} 个 script 应可通过语法解析`);
  });
}

function assertWebviewToolBlockCompatibility() {
  const html = fs.readFileSync(path.join(workspaceRoot, 'media', 'webview.html'), 'utf8');
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
  const extractMatch = script.match(/function extractAgentToolCalls\(text\) \{[\s\S]*?\n\}/);
  const stripMatch = script.match(/function stripInternalToolMarkup\(text\) \{[\s\S]*?\n\}/);

  assert(extractMatch, '应能找到 extractAgentToolCalls 函数');
  assert(stripMatch, '应能找到 stripInternalToolMarkup 函数');

  const helpers = new Function(`${extractMatch[0]}\n${stripMatch[0]}\nreturn { extractAgentToolCalls, stripInternalToolMarkup };`)();
  const toolBlock = '开始\n```tool\n{"tool":"list_local_files","args":{"rootPath":"D:/demo"}}\n```\n结束';
  const agentToolBlock = '开始\n```agent-tool\n{"tool":"read_file","args":{"filePath":"extension.js","startLine":1,"endLine":2}}\n```\n结束';

  const parsedTool = helpers.extractAgentToolCalls(toolBlock);
  const parsedAgentTool = helpers.extractAgentToolCalls(agentToolBlock);

  assert.strictEqual(parsedTool.length, 1, '普通 tool 代码块也应被识别为工具调用');
  assert.strictEqual(parsedTool[0].tool, 'list_local_files', '应正确解析普通 tool 代码块里的工具名');
  assert.strictEqual(parsedAgentTool.length, 1, 'agent-tool 代码块仍应继续被识别');
  assert.strictEqual(helpers.stripInternalToolMarkup(toolBlock), '开始\n\n结束', '普通 tool 代码块应从可见文本中剥离');
}

function assertWebviewContinuationGuard() {
  const html = fs.readFileSync(path.join(workspaceRoot, 'media', 'webview.html'), 'utf8');
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).join('\n');
  const stripMatch = script.match(/function stripInternalToolMarkup\(text\) \{[\s\S]*?\n\}/);
  const continuationMatch = script.match(/function shouldForceAgentToolContinuation\(text, visibleText\) \{[\s\S]*?\n\}/);

  assert(stripMatch, '应能找到 stripInternalToolMarkup 函数');
  assert(continuationMatch, '应能找到 shouldForceAgentToolContinuation 函数');

  const helpers = new Function(`${stripMatch[0]}\n${continuationMatch[0]}\nreturn { shouldForceAgentToolContinuation };`)();
  assert.strictEqual(helpers.shouldForceAgentToolContinuation('', '请稍等，我正在读取本地文件结构和关键配置文件。'), true, '纯进度说明应触发自动续跑');
  assert.strictEqual(helpers.shouldForceAgentToolContinuation('', '分析结果如下：入口在 main.js，建议先修复配置。'), false, '已有明确分析结论时不应继续追问');
}

function createMockVscode() {
  const taskEvents = {
    startTask: new EventEmitter(),
    startTaskProcess: new EventEmitter(),
    endTaskProcess: new EventEmitter(),
    endTask: new EventEmitter()
  };
  const windowEvents = {
    activeEditor: new EventEmitter(),
    selection: new EventEmitter()
  };

  const mockTasks = [
    {
      name: 'verify:mock',
      source: 'workspace',
      detail: 'Mock verification task',
      isBackground: false,
      definition: { type: 'shell' },
      scope: { uri: { fsPath: workspaceRoot }, name: path.basename(workspaceRoot) }
    }
  ];

  const openDocuments = new Map();

  function syncOpenDocuments(target) {
    target.workspace.textDocuments = Array.from(openDocuments.values());
  }

  function ensureDocument(target, uri) {
    const key = uri.fsPath;
    if (openDocuments.has(key)) {
      return openDocuments.get(key);
    }

    const doc = {
      uri,
      fileName: uri.fsPath,
      isDirty: false,
      _text: fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, 'utf8') : '',
      getText() {
        return this._text;
      },
      async save() {
        fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
        fs.writeFileSync(uri.fsPath, this._text, 'utf8');
        this.isDirty = false;
        return true;
      },
      positionAt(offset) {
        const safeOffset = Math.max(0, Math.min(offset, this._text.length));
        const lines = this._text.slice(0, safeOffset).split(/\r?\n/);
        return {
          line: Math.max(0, lines.length - 1),
          character: (lines[lines.length - 1] || '').length
        };
      }
    };

    openDocuments.set(key, doc);
    syncOpenDocuments(vscode);
    return doc;
  }

  const vscode = {
    TaskScope: {
      Workspace: 1,
      Global: 2
    },
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3
    },
    window: {
      activeTextEditor: null,
      showErrorMessage() {},
      showInformationMessage() {},
      showWarningMessage() {},
      onDidChangeActiveTextEditor(listener) {
        windowEvents.activeEditor.on('event', listener);
        return { dispose() { windowEvents.activeEditor.off('event', listener); } };
      },
      onDidChangeTextEditorSelection(listener) {
        windowEvents.selection.on('event', listener);
        return { dispose() { windowEvents.selection.off('event', listener); } };
      }
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      textDocuments: [],
      async findFiles() {
        return [
          { fsPath: path.join(workspaceRoot, 'extension.js') },
          { fsPath: path.join(workspaceRoot, 'media', 'webview.html') },
          { fsPath: path.join(workspaceRoot, 'check_syntax.js') }
        ];
      },
      async openTextDocument(uri) {
        return ensureDocument(vscode, uri);
      },
      async applyEdit(edit) {
        for (const item of edit.edits) {
          const doc = ensureDocument(vscode, item.uri);
          doc._text = item.text;
          doc.isDirty = true;
        }
        return true;
      }
    },
    languages: {
      getDiagnostics(uri) {
        if (uri) return [];
        return [];
      }
    },
    Uri: {
      file(fsPath) { return { fsPath }; }
    },
    Range: class Range {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    WorkspaceEdit: class WorkspaceEdit {
      constructor() {
        this.edits = [];
      }
      replace(uri, _range, text) {
        this.edits.push({ uri, text });
      }
    },
    tasks: {
      async fetchTasks() {
        return mockTasks;
      },
      async executeTask(task) {
        const execution = { task, terminate() {} };
        setImmediate(() => {
          taskEvents.startTask.emit('event', { execution });
          taskEvents.startTaskProcess.emit('event', { execution, processId: 4321 });
          taskEvents.endTaskProcess.emit('event', { execution, exitCode: 0 });
          taskEvents.endTask.emit('event', { execution });
        });
        return execution;
      },
      onDidStartTask(listener) {
        taskEvents.startTask.on('event', listener);
        return { dispose() { taskEvents.startTask.off('event', listener); } };
      },
      onDidStartTaskProcess(listener) {
        taskEvents.startTaskProcess.on('event', listener);
        return { dispose() { taskEvents.startTaskProcess.off('event', listener); } };
      },
      onDidEndTaskProcess(listener) {
        taskEvents.endTaskProcess.on('event', listener);
        return { dispose() { taskEvents.endTaskProcess.off('event', listener); } };
      },
      onDidEndTask(listener) {
        taskEvents.endTask.on('event', listener);
        return { dispose() { taskEvents.endTask.off('event', listener); } };
      }
    }
  };

  return vscode;
}

const mockVscode = createMockVscode();
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return mockVscode;
  }
  return originalLoad(request, parent, isMain);
};

const { __test__ } = require('../extension.js');
Module._load = originalLoad;

async function run() {
  assertWebviewScriptsParse();
  assertWebviewToolBlockCompatibility();
  assertWebviewContinuationGuard();

  const context = { subscriptions: [], globalState: { update() {}, get(_key, fallback) { return fallback; } } };
  const provider = new __test__.ChatViewProvider({ fsPath: workspaceRoot }, context);
  const tempDir = path.join(workspaceRoot, '.tmp-selftest');
  const tempFile = '.tmp-selftest/agent-tools.js';
  const renamedFile = '.tmp-selftest/agent-tools-renamed.js';
  const localRoot = path.join(os.tmpdir(), `xiaoxiami-local-test-${Date.now()}`);

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(localRoot, { recursive: true, force: true });

  const files = await provider._listWorkspaceFiles('**/*', 10);
  assert(files.count >= 1, '应该至少找到一个工作区文件');
  assert(files.files.includes('extension.js'), '文件列表里应包含 extension.js');

  const search = await provider._searchWorkspaceText({ query: 'run_command', include: '**/*', maxResults: 20 });
  assert(search.count >= 1, '应该能搜到 run_command');

  const fileContent = await provider._readWorkspaceFile('package.json', 1, 20);
  assert(fileContent.content.includes('claude-chat'), '应该能读取 package.json 内容');

  const commands = await provider._listWorkspaceCommands();
  assert(Array.isArray(commands.suggestedCommands), 'list_commands 应返回 suggestedCommands');
  assert(commands.validationFiles.includes('check_syntax.js'), '应识别到 check_syntax.js 校验脚本');

  let blocked = false;
  try {
    provider._validateWorkspaceCommand('powershell', ['Remove-Item', '-Recurse']);
  } catch {
    blocked = true;
  }
  assert(blocked, '危险命令应被白名单拦截');

  const runCommand = await provider._runWorkspaceCommand({ command: 'node', args: ['check_syntax.js'], timeoutMs: 30000 }, 'selftest-command', () => {});
  assert.strictEqual(typeof runCommand.exitCode, 'number', 'run_command 应返回 exitCode');
  assert.strictEqual(runCommand.timedOut, false, 'check_syntax.js 不应超时');

  const tasks = await provider._listWorkspaceTasks();
  assert(tasks.count >= 1, '应能列出 mock 任务');
  assert(tasks.tasks.some(task => task.label === 'verify:mock'), '任务列表应包含 verify:mock');

  const runTask = await provider._runWorkspaceTask({ label: 'verify:mock', timeoutMs: 5000 }, 'selftest-task', () => {});
  assert.strictEqual(runTask.exitCode, 0, 'mock task 应返回成功 exitCode');
  assert.strictEqual(runTask.cancelled, false, 'mock task 不应被取消');

  const createResult = await provider._applyWorkspaceChanges([
    { action: 'create', filePath: tempFile, content: 'const value = 1;\nconst label = "old";\n' }
  ]);
  assert.strictEqual(createResult.success, true, 'create 应成功');
  assert(fs.existsSync(path.join(workspaceRoot, tempFile)), '应创建临时文件');

  const insertResult = await provider._applyWorkspaceChanges([
    { action: 'insert_after', filePath: tempFile, search: 'const value = 1;', content: '\nconst next = value + 1;' },
    { action: 'append', filePath: tempFile, content: '\nmodule.exports = label;\n' }
  ]);
  assert.strictEqual(insertResult.success, true, 'insert_after 和 append 应成功');

  const insertedText = fs.readFileSync(path.join(workspaceRoot, tempFile), 'utf8');
  assert(insertedText.includes('const next = value + 1;'), '文件中应插入 next 变量');
  assert(insertedText.includes('module.exports = label;'), '文件中应追加导出语句');

  const lineAndRegexResult = await provider._applyWorkspaceChanges([
    { action: 'replace_lines', filePath: tempFile, startLine: 3, endLine: 4, content: 'const label = "draft";\nconst output = next * 2;' },
    { action: 'insert_at_line', filePath: tempFile, line: 5, content: 'module.exports = output;' },
    { action: 'regex_replace', filePath: tempFile, pattern: '"draft"', replace: '"ready"', expectedMatches: 1 },
    { action: 'insert_at_line', filePath: tempFile, line: 1, content: '// temp header' },
    { action: 'delete_lines', filePath: tempFile, startLine: 1, endLine: 1 }
  ]);
  assert.strictEqual(lineAndRegexResult.success, true, '按行修改和 regex_replace 应成功');

  const rewrittenText = fs.readFileSync(path.join(workspaceRoot, tempFile), 'utf8');
  assert(rewrittenText.includes('const label = "ready";'), 'regex_replace 应更新字符串内容');
  assert(rewrittenText.includes('const output = next * 2;'), 'replace_lines 应替换目标行范围');
  assert(rewrittenText.includes('module.exports = output;'), 'insert_at_line 应插入新导出语句');
  assert(!rewrittenText.includes('// temp header'), 'delete_lines 应删除指定行');

  const renameResult = await provider._applyWorkspaceChanges([
    { action: 'rename', filePath: tempFile, newFilePath: renamedFile },
    { action: 'prepend', filePath: renamedFile, content: '// generated by selftest\n' }
  ]);
  assert.strictEqual(renameResult.success, true, 'rename 和 prepend 应成功');
  assert(!fs.existsSync(path.join(workspaceRoot, tempFile)), '原文件应已被重命名');

  const renamedText = fs.readFileSync(path.join(workspaceRoot, renamedFile), 'utf8');
  assert(renamedText.startsWith('// generated by selftest'), '重命名后的文件应成功 prepend');

  const deleteResult = await provider._applyWorkspaceChanges([
    { action: 'delete', filePath: renamedFile }
  ]);
  assert.strictEqual(deleteResult.success, true, 'delete 应成功');
  assert(!fs.existsSync(path.join(workspaceRoot, renamedFile)), '临时文件应被删除');

  fs.mkdirSync(path.join(localRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(localRoot, 'README.md'), '# Local App\nThis is a local install.\n', 'utf8');
  fs.writeFileSync(path.join(localRoot, 'package.json'), '{"name":"local-app"}\n', 'utf8');
  fs.writeFileSync(path.join(localRoot, 'src', 'engine.js'), 'function boot() {\n  return "CodeBuddy";\n}\nmodule.exports = { boot };\n', 'utf8');

  const localFiles = await provider._listLocalFiles({ rootPath: localRoot, pattern: '**/*', maxResults: 10 });
  assert(localFiles.count >= 3, '应能列出工作区外顶层和嵌套文件');
  assert(localFiles.files.includes('README.md'), '默认 **/* 应能命中顶层 README.md');
  assert(localFiles.files.includes('src/engine.js'), '应能返回相对路径 src/engine.js');
  assert(localFiles.topLevelEntries.some(item => item.name === 'src' && item.type === 'directory'), '应返回顶层目录摘要');
  assert(localFiles.interestingFiles.includes('package.json'), '应返回关键文件候选 package.json');

  const localSearch = await provider._searchLocalText({ rootPath: localRoot, query: 'CodeBuddy', include: '**/*', maxResults: 10 });
  assert(localSearch.count >= 1, '应能搜索工作区外本地文本');
  assert(localSearch.matches.some(item => item.filePath === 'src/engine.js'), '搜索结果应包含 src/engine.js');

  const localRead = await provider._readLocalFile({ rootPath: localRoot, filePath: 'src/engine.js', startLine: 1, endLine: 3 });
  assert.strictEqual(localRead.filePath, 'src/engine.js', '应能按相对路径读取工作区外本地文件');
  assert(localRead.content.includes('function boot()'), '读取结果应包含真实文件内容');

  const localReadWithCachedRoot = await provider._readLocalFile({ filePath: 'src/engine.js', startLine: 2, endLine: 2 });
  assert.strictEqual(localReadWithCachedRoot.filePath, 'src/engine.js', '缺少 rootPath 时应沿用最近一次成功的本地根目录');
  assert(localReadWithCachedRoot.content.includes('return "CodeBuddy";'), '沿用缓存根目录时应能读取真实内容');

  const localPatchCreate = await provider._applyLocalChanges({
    rootPath: localRoot,
    changes: [
      { action: 'create', filePath: 'src/patch.js', content: 'const version = 1;\n' },
      { action: 'insert_after', filePath: 'src/patch.js', search: 'const version = 1;', content: '\nconst next = version + 1;' }
    ]
  });
  assert.strictEqual(localPatchCreate.success, true, 'apply_local_patch 应能创建并修改工作区外本地文件');

  const localPatchedText = fs.readFileSync(path.join(localRoot, 'src', 'patch.js'), 'utf8');
  assert(localPatchedText.includes('const next = version + 1;'), '本地补丁应写入新增代码');

  const localPatchCachedRoot = await provider._applyLocalChanges({
    changes: [
      { action: 'replace', filePath: 'src/patch.js', search: 'version + 1', replace: 'version + 2' },
      { action: 'rename', filePath: 'src/patch.js', newFilePath: 'src/patch-renamed.js' }
    ]
  });
  assert.strictEqual(localPatchCachedRoot.success, true, 'apply_local_patch 缺少 rootPath 时应沿用最近一次成功的本地根目录');
  assert(!fs.existsSync(path.join(localRoot, 'src', 'patch.js')), '本地补丁 rename 后原文件应不存在');

  const renamedLocalPatchedText = fs.readFileSync(path.join(localRoot, 'src', 'patch-renamed.js'), 'utf8');
  assert(renamedLocalPatchedText.includes('version + 2'), '本地补丁 replace 应成功生效');

  fs.writeFileSync(path.join(localRoot, 'src', 'rollback.js'), 'const state = "original";\n', 'utf8');

  const localPatchRollback = await provider._applyLocalChanges({
    rootPath: localRoot,
    changes: [
      { action: 'replace', filePath: 'src/rollback.js', search: '"original"', replace: '"changed"' },
      { action: 'create', filePath: 'src/rollback-created.js', content: 'const temp = true;\n' },
      { action: 'replace', filePath: 'src/missing.js', search: 'x', replace: 'y' }
    ]
  });
  assert.strictEqual(localPatchRollback.success, false, '本地补丁中途失败时应返回失败');
  assert.strictEqual(localPatchRollback.rolledBack, true, '本地补丁失败后应自动回滚');
  assert(fs.existsSync(localPatchRollback.backupDir), '本地补丁应生成备份目录');
  assert.strictEqual(fs.readFileSync(path.join(localRoot, 'src', 'rollback.js'), 'utf8'), 'const state = "original";\n', '回滚后原文件内容应恢复');
  assert.strictEqual(fs.existsSync(path.join(localRoot, 'src', 'rollback-created.js')), false, '回滚后新增文件应被删除');

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(localRoot, { recursive: true, force: true });

  console.log('selftest passed');
}

run().catch(err => {
  console.error('selftest failed');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});