const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { exec, spawn } = require('child_process');
const { getProvider, buildRequestConfig } = require('./src/providers');

const EVENT_TYPES = {
  GET_EDITOR: 'getEditor',
  GET_FILE: 'getFile',
  SHOW_INFO: 'showInfo',
  SHOW_ERROR: 'showError',
  CODE_CONTEXT: 'codeContext',
  EDITOR_CONTEXT: 'editorContext'
};

const PRIMARY_API_KEY_SECRET = 'sf_api_key';
const FORBIDDEN_PATH_SEGMENTS = new Set(['.git', '.vscode', 'node_modules', '.claude']);
const LOCAL_READ_SKIP_DIRS = new Set(['.git', '.vscode']);
const ALLOWED_PACKAGE_RUNNERS = new Set(['npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd']);
const ALLOWED_NPX_RUNNERS = new Set(['npx', 'npx.cmd']);
const ALLOWED_DIRECT_TOOLS = new Set(['eslint', 'tsc', 'vitest', 'jest']);
const ALLOWED_SCRIPT_NAMES = /^(test|lint|build|typecheck|check|verify|validate)(?::[\w.-]+)?$/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let chatViewProvider;

function getEditorContext(editor) {
  if (!editor) {
    return { error: '没有打开的文件，请先在编辑器中打开文件' };
  }
  const document = editor.document;
  const selection = editor.selection;
  const selectedText = document.getText(selection);
  const fileName = path.basename(document.fileName);
  const lang = document.languageId;
  return { editor, document, selection, selectedText, fileName, lang };
}

function activate(context) {
  chatViewProvider = new ChatViewProvider(context.extensionUri, context);
  console.log('ChatViewProvider初始化完成');
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeChat.chatView', chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeChat.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.selection;
      const text = editor.document.getText(selection);
      const lang = editor.document.languageId;
      const fileName = path.basename(editor.document.fileName);
      if (text && text.trim()) {
        chatViewProvider.sendCodeContext(`来自 ${fileName} 的选中代码`, text, lang);
        vscode.commands.executeCommand('claudeChat.chatView.focus');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeChat.sendFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText();
      const lang = editor.document.languageId;
      const fileName = path.basename(editor.document.fileName);
      chatViewProvider.sendCodeContext(`当前文件: ${fileName}`, text, lang);
      vscode.commands.executeCommand('claudeChat.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeChat.focus', () => {
      vscode.commands.executeCommand('claudeChat.chatView.focus');
    })
  );
}

class ChatViewProvider {
  constructor(extensionUri, context) {
    this._extensionUri = extensionUri;
    this._context = context;
    this._secretStorage = context.secrets || null;
    this._view = null;
    this._lastEditor = null;
    this._lastLocalRootPath = '';
    this._autoCtxTimer = null;
    this._cachedHtml = null;
    this._runningAgentCommands = new Map();
    this._runningAgentTasks = new Map();
    this._runningChatRequests = new Map();

    // 记录最后一个活跃的文本编辑器（点击 webview 时不会丢失）
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
          this._lastEditor = editor;
          if (this._view?.visible) this._debouncedPushAutoContext(editor);
        }
      })
    );
    // 选区变化时自动推送上下文
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (this._view?.visible) this._debouncedPushAutoContext(e.textEditor);
      })
    );
    // 初始化时捕获当前编辑器
    if (vscode.window.activeTextEditor) {
      this._lastEditor = vscode.window.activeTextEditor;
    }

    context.subscriptions.push(
      vscode.tasks.onDidStartTask(event => this._handleTaskStart(event))
    );
    context.subscriptions.push(
      vscode.tasks.onDidStartTaskProcess(event => this._handleTaskProcessStart(event))
    );
    context.subscriptions.push(
      vscode.tasks.onDidEndTaskProcess(event => this._handleTaskProcessEnd(event))
    );
    context.subscriptions.push(
      vscode.tasks.onDidEndTask(event => this._handleTaskEnd(event))
    );
  }

  _debouncedPushAutoContext(ed) {
    clearTimeout(this._autoCtxTimer);
    this._autoCtxTimer = setTimeout(() => this._pushAutoContext(ed), 300);
  }

  _pushAutoContext(ed) {
    if (!this._view?.webview) return;
    const ctx = getEditorContext(ed || this._lastEditor || vscode.window.activeTextEditor);
    if (ctx.error) {
      this._view.webview.postMessage({ type: 'autoContext', clear: true });
      return;
    }
    const { document, selection, fileName, lang } = ctx;
    const code = selection.isEmpty ? document.getText() : document.getText(selection);
    const label = selection.isEmpty
      ? fileName
      : `${fileName}:${selection.start.line + 1}-${selection.end.line + 1}`;
    this._view.webview.postMessage({ type: 'autoContext', label, code, lang });
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._debouncedPushAutoContext();
    });

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case EVENT_TYPES.GET_EDITOR:
          this._sendEditorContext();
          break;
        case EVENT_TYPES.GET_FILE:
          this._sendFileContext();
          break;
        case EVENT_TYPES.SHOW_INFO:
          vscode.window.showInformationMessage(msg.text);
          break;
        case EVENT_TYPES.SHOW_ERROR:
          vscode.window.showErrorMessage(msg.text);
          break;
        case 'tool':
          this._handleTool(msg);
          break;
        case 'agentTool':
          await this._handleAgentTool(msg);
          break;
        case 'cancelAgentTool':
          await this._cancelAgentTool(msg.id);
          break;
        case 'saveSessions': {
          const { sessions, lastSessionId } = msg;
          this._context.globalState.update('vsc_sessions', sessions);
          if (lastSessionId !== undefined) {
            this._context.globalState.update('vsc_last_session_id', lastSessionId);
          }
          break;
        }
        case 'requestSessions': {
          const sessions = this._context.globalState.get('vsc_sessions', []);
          const lastSessionId = this._context.globalState.get('vsc_last_session_id', null);
          this._view?.webview.postMessage({ type: 'loadSessions', sessions, lastSessionId });
          break;
        }
        case 'saveApiKey': {
          await this._saveStoredApiKey(msg.key);
          break;
        }
        case 'requestApiKey': {
          const key = await this._getStoredApiKey();
          this._view?.webview.postMessage({
            type: 'loadApiKey',
            hasKey: !!key,
            maskedKey: this._maskSecretValue(key)
          });
          break;
        }
        case 'chatStreamRequest': {
          await this._handleChatStreamRequest(msg);
          break;
        }
        case 'cancelChatStream': {
          await this._cancelChatRequest(msg.id);
          break;
        }
        case 'chatCompletionRequest': {
          await this._handleChatCompletionRequest(msg);
          break;
        }
        case 'applyCode': {
          const options = {
            isNewFile: msg.isNewFile || false,
            previewMode: msg.previewMode || false
          };
          await this._applyCodeToEditor(msg.code, msg.filePath, options);
          break;
        }
        case 'applyCodeBatch': {
          const previewMode = msg.previewMode || false;
          await this._applyCodeBatch(msg.changes, previewMode);
          break;
        }
        case 'acceptCode': {
          await this._acceptCode(msg.code, msg.lang);
          break;
        }
      }
    });
  }

  _handleTool(msg) {
    const post = (payload) => this._view?.webview.postMessage({ type: 'toolResponse', tool: msg.tool, ...payload });
    const handlers = {
      'search':         () => this._webSearch(msg.query || '').then(result => post({ result })),
      'generate-image': () => this._generateImage(msg.prompt || '', msg.resolution || '1K', msg.apiKey || '').then(result => post(result)),
      'browse':         () => this._browseUrl(msg.url || '').then(result => post(result)),
      'maton-api':      () => this._matonApi(msg.args || '', msg.apiKey || '').then(result => post(result)),
      'admapix-search': () => this._admapixSearch(msg.query || '', msg.apiKey || '').then(result => post({ result })),
      'admapix-deep':   () => this._admapixDeepResearch(msg.query || '', msg.apiKey || '').then(result => post({ result })),
      'baidu-search':   () => this._baiduSearch(msg.query || '', msg.apiKey || '').then(result => post({ result })),
      'prismfy-search': () => this._prismfySearch(msg.query || '', msg.apiKey || '').then(result => post({ result })),
      'bilibili-search':() => this._bilibiliSearch(msg.query || '', msg.searchType || 'video').then(result => post({ result })),
      'exec-skill':     () => this._execSkill(msg.cmd || '').then(result => post({ id: msg.id, result })),
    };
    handlers[msg.tool]?.();
  }

  async _handleAgentTool(msg) {
    const post = (payload) => this._view?.webview.postMessage({ type: 'agentToolResult', id: msg.id, tool: msg.tool, ...payload });
    const emitStream = (payload) => this._view?.webview.postMessage({ type: 'agentToolStream', id: msg.id, tool: msg.tool, ...payload });
    const args = msg.args || {};

    try {
      const confirmation = this._buildHighRiskToolConfirmation(msg.tool, args);
      if (confirmation) {
        const approved = await this._confirmHighRiskToolExecution(confirmation);
        if (!approved) {
          post({ success: false, error: '用户取消了高风险操作', cancelled: true });
          return;
        }
      }

      let result;
      switch (msg.tool) {
        case 'web_search':
          result = await this._webSearch(args.query || '');
          break;
        case 'list_files':
          result = await this._listWorkspaceFiles(args.pattern || '**/*', args.maxResults || 200);
          break;
        case 'list_local_files':
          result = await this._listLocalFiles(args);
          break;
        case 'search_text':
          result = await this._searchWorkspaceText(args);
          break;
        case 'search_local_text':
          result = await this._searchLocalText(args);
          break;
        case 'read_file':
          result = await this._readWorkspaceFile(args.filePath, args.startLine, args.endLine);
          break;
        case 'read_local_file':
          result = await this._readLocalFile(args);
          break;
        case 'apply_local_patch':
          result = await this._applyLocalChanges(args);
          break;
        case 'apply_patch':
          result = await this._applyWorkspaceChanges(args.changes || [], !!args.previewMode);
          break;
        case 'get_diagnostics':
          result = await this._getWorkspaceDiagnostics(args.filePath);
          break;
        case 'list_commands':
          result = await this._listWorkspaceCommands();
          break;
        case 'list_tasks':
          result = await this._listWorkspaceTasks();
          break;
        case 'run_command':
          result = await this._runWorkspaceCommand(args, msg.id, emitStream);
          break;
        case 'run_task':
          result = await this._runWorkspaceTask(args, msg.id, emitStream);
          break;
        default:
          throw new Error(`不支持的工具: ${msg.tool}`);
      }

      post({ success: true, result });
    } catch (err) {
      post({ success: false, error: err?.message || '未知错误' });
    }
  }

  async _cancelAgentTool(id) {
    if (!id) return;
    const taskEntry = this._runningAgentTasks.get(id);
    if (taskEntry) {
      taskEntry.cancelled = true;
      try {
        taskEntry.execution?.terminate();
      } catch {}
      return;
    }

    const entry = this._runningAgentCommands.get(id);
    if (!entry) return;

    entry.cancelled = true;
    const child = entry.child;

    try {
      if (process.platform === 'win32' && child?.pid) {
        exec(`taskkill /pid ${child.pid} /T /F`, () => {});
      } else {
        child?.kill('SIGTERM');
      }
    } catch {}
  }

  async _handleChatStreamRequest(msg) {
    const requestId = String(msg?.id || '').trim();
    if (!requestId) {
      throw new Error('chatStreamRequest 缺少 id');
    }

    try {
      const apiKey = await this._getStoredApiKey();
      if (!apiKey) {
        throw new Error('请先配置 API Key');
      }

      const request = this._buildHostedChatRequest(msg, apiKey, true);
      const result = await this._streamHostedChatRequest(requestId, request);
      this._view?.webview.postMessage({
        type: 'chatStreamEnd',
        id: requestId,
        usage: result.usage || null,
        finishReason: result.finishReason || ''
      });
    } catch (err) {
      this._view?.webview.postMessage({
        type: 'chatStreamError',
        id: requestId,
        error: err?.message || '未知错误',
        errorName: err?.name || 'Error',
        cancelled: err?.name === 'AbortError'
      });
    }
  }

  async _handleChatCompletionRequest(msg) {
    const requestId = String(msg?.id || '').trim();
    if (!requestId) {
      throw new Error('chatCompletionRequest 缺少 id');
    }

    try {
      const apiKey = await this._getStoredApiKey();
      if (!apiKey) {
        throw new Error('请先配置 API Key');
      }

      const request = this._buildHostedChatRequest(msg, apiKey, false);
      const response = await this._performHostedChatCompletion(requestId, request);
      this._view?.webview.postMessage({
        type: 'chatCompletionResult',
        id: requestId,
        success: true,
        content: this._extractChatCompletionContent(response.data),
        usage: response.data?.usage || null,
        raw: response.data
      });
    } catch (err) {
      this._view?.webview.postMessage({
        type: 'chatCompletionResult',
        id: requestId,
        success: false,
        error: err?.message || '未知错误',
        errorName: err?.name || 'Error',
        cancelled: err?.name === 'AbortError'
      });
    }
  }

  async _cancelChatRequest(id) {
    const requestId = String(id || '').trim();
    if (!requestId) return;

    const entry = this._runningChatRequests.get(requestId);
    if (!entry) return;

    entry.cancelled = true;
    entry.state.cancelled = true;
    try {
      entry.request.destroy(new Error('REQUEST_ABORTED'));
    } catch {}
  }

  _buildHostedChatRequest(msg, apiKey, stream) {
    const providerId = String(msg?.providerId || 'siliconflow').trim() || 'siliconflow';
    const model = String(msg?.model || '').trim();
    if (!model) {
      throw new Error('缺少 model');
    }

    if (!Array.isArray(msg?.messages) || msg.messages.length === 0) {
      throw new Error('缺少 messages');
    }

    const provider = getProvider(providerId);
    const baseURL = this._resolveHostedChatBaseURL(provider, msg?.baseURL);
    const { config } = buildRequestConfig(providerId, model, apiKey, msg.messages, {
      stream,
      temperature: msg?.temperature,
      max_tokens: msg?.maxTokens,
      extra: msg?.extra || {}
    });

    return {
      url: `${baseURL}${provider.chatPath}`,
      method: config.method,
      headers: config.headers,
      body: config.body
    };
  }

  _resolveHostedChatBaseURL(provider, baseURL) {
    const override = String(baseURL || '').trim().replace(/\/$/, '');
    if (override) {
      return override;
    }

    const fallback = String(provider?.baseURL || '').trim().replace(/\/$/, '');
    if (!fallback) {
      throw new Error('当前 provider 缺少 baseURL，请先在设置中填写 API 地址');
    }

    return fallback;
  }

  async _streamHostedChatRequest(requestId, request) {
    const response = await this._performHostedHttpRequest(requestId, request, true, chunk => {
      this._view?.webview.postMessage({ type: 'chatStreamChunk', id: requestId, delta: chunk });
    });
    return response;
  }

  async _performHostedChatCompletion(requestId, request) {
    return this._performHostedHttpRequest(requestId, request, false);
  }

  _performHostedHttpRequest(requestId, request, expectStream, onChunk = () => {}) {
    const target = new URL(request.url);
    const transport = target.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const options = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: request.method || 'POST',
        headers: request.headers || {}
      };

      const state = { cancelled: false };
      const req = transport.request(options, res => {
        const ok = typeof res.statusCode === 'number' && res.statusCode >= 200 && res.statusCode < 300;
        let rawBody = '';
        let eventBuffer = '';
        let usage = null;
        let finishReason = '';

        res.setEncoding('utf8');

        const failFromBody = () => {
          const message = this._extractHttpErrorMessage(rawBody, res.statusCode);
          const error = new Error(message);
          error.statusCode = res.statusCode;
          reject(error);
        };

        res.on('data', chunk => {
          if (state.cancelled) return;

          if (!ok) {
            rawBody += chunk;
            return;
          }

          if (!expectStream) {
            rawBody += chunk;
            return;
          }

          eventBuffer += chunk;
          const lines = eventBuffer.split(/\r?\n/);
          eventBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;

            try {
              const event = JSON.parse(raw);
              const delta = event?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) {
                onChunk(delta);
              }
              if (event?.usage) {
                usage = event.usage;
              }
              if (event?.choices?.[0]?.finish_reason) {
                finishReason = event.choices[0].finish_reason;
              }
            } catch {}
          }
        });

        res.on('end', () => {
          this._runningChatRequests.delete(requestId);

          if (state.cancelled) {
            const error = new Error('请求已停止');
            error.name = 'AbortError';
            reject(error);
            return;
          }

          if (!ok) {
            failFromBody();
            return;
          }

          if (expectStream) {
            resolve({ usage, finishReason });
            return;
          }

          try {
            resolve({ data: rawBody ? JSON.parse(rawBody) : {} });
          } catch (err) {
            reject(new Error(`响应解析失败: ${err?.message || '未知错误'}`));
          }
        });
      });

      this._runningChatRequests.set(requestId, { request: req, cancelled: false, state });

      req.on('error', err => {
        this._runningChatRequests.delete(requestId);
        if (state.cancelled || err?.message === 'REQUEST_ABORTED') {
          const abortError = new Error('请求已停止');
          abortError.name = 'AbortError';
          reject(abortError);
          return;
        }
        reject(err);
      });

      req.write(request.body || '');
      req.end();
    });
  }

  _extractHttpErrorMessage(rawBody, statusCode) {
    try {
      const parsed = JSON.parse(rawBody || '{}');
      return parsed?.error?.message || parsed?.message || `HTTP ${statusCode || 500}`;
    } catch {
      return (rawBody || '').trim().slice(0, 300) || `HTTP ${statusCode || 500}`;
    }
  }

  _extractChatCompletionContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map(part => part?.text || '').join('');
    }
    return '';
  }

  async _saveStoredApiKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) {
      throw new Error('API Key 不能为空');
    }

    if (this._secretStorage?.store) {
      await this._secretStorage.store(PRIMARY_API_KEY_SECRET, key);
      await this._context.globalState.update('sf_api_key', '');
      return;
    }

    await this._context.globalState.update('sf_api_key', key);
  }

  async _getStoredApiKey() {
    if (this._secretStorage?.get) {
      const storedKey = String(await this._secretStorage.get(PRIMARY_API_KEY_SECRET) || '').trim();
      if (storedKey) {
        return storedKey;
      }
    }

    const legacyKey = String(this._context.globalState.get('sf_api_key', '') || '').trim();
    if (!legacyKey) {
      return '';
    }

    if (this._secretStorage?.store) {
      await this._secretStorage.store(PRIMARY_API_KEY_SECRET, legacyKey);
      await this._context.globalState.update('sf_api_key', '');
    }

    return legacyKey;
  }

  _maskSecretValue(value) {
    const secret = String(value || '').trim();
    if (!secret) return '';
    if (secret.length <= 8) return `${secret.slice(0, 2)}****`;
    return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
  }

  _buildHighRiskToolConfirmation(tool, args = {}) {
    if (tool === 'run_command') {
      return {
        title: '确认执行命令',
        detail: `命令: ${String(args.command || '').trim() || 'unknown'} ${(Array.isArray(args.args) ? args.args.join(' ') : '').trim()}`.trim(),
        confirmLabel: '继续执行'
      };
    }

    if (tool === 'run_task') {
      return {
        title: '确认执行任务',
        detail: `任务: ${String(args.label || args.name || 'unknown').trim()}${args.source ? ` [${args.source}]` : ''}`,
        confirmLabel: '继续执行'
      };
    }

    if (tool === 'apply_local_patch' && !args.previewMode) {
      const changes = Array.isArray(args.changes) ? args.changes : [];
      if (!changes.length) return null;
      const actions = [...new Set(changes.map(change => String(change?.action || 'unknown')))].join(', ');
      return {
        title: '确认修改工作区外目录',
        detail: `目录: ${String(args.rootPath || this._lastLocalRootPath || '(使用最近一次目录)').trim()}\n动作: ${actions}\n数量: ${changes.length}`,
        confirmLabel: '继续修改'
      };
    }

    if (tool === 'apply_patch' && !args.previewMode) {
      const changes = Array.isArray(args.changes) ? args.changes : [];
      const dangerousActions = changes.filter(change => this._isHighRiskPatchAction(change));
      if (!dangerousActions.length) return null;
      const actions = [...new Set(dangerousActions.map(change => String(change?.action || 'unknown')))].join(', ');
      return {
        title: '确认高风险工作区修改',
        detail: `动作: ${actions}\n数量: ${dangerousActions.length}`,
        confirmLabel: '继续修改'
      };
    }

    return null;
  }

  _isHighRiskPatchAction(change) {
    const action = String(change?.action || '');
    if (action === 'delete' || action === 'rename' || action === 'write') {
      return true;
    }
    return action === 'create' && !!change?.overwrite;
  }

  async _confirmHighRiskToolExecution(request) {
    const confirmLabel = request?.confirmLabel || '继续';
    const detail = String(request?.detail || '').trim();
    const selection = await vscode.window.showWarningMessage(
      request?.title || '确认高风险操作',
      { modal: true, detail },
      confirmLabel,
      '取消'
    );
    return selection === confirmLabel;
  }

  _getWorkspaceRoot() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('没有打开的工作区');
    }
    return workspaceFolders[0].uri.fsPath;
  }

  _toRelativePath(absPath) {
    return path.relative(this._getWorkspaceRoot(), absPath).replace(/\\/g, '/');
  }

  _normalizePathSlashes(targetPath) {
    return String(targetPath || '').replace(/\\/g, '/');
  }

  _validateLocalRootPath(rootPath) {
    const rawPath = String(rootPath || '').trim();
    if (!rawPath) {
      throw new Error('需要提供本机绝对路径 rootPath');
    }

    if (!path.isAbsolute(rawPath)) {
      throw new Error('rootPath 必须是本机绝对路径');
    }

    const normalized = path.resolve(rawPath);
    if (!fs.existsSync(normalized)) {
      throw new Error(`路径不存在: ${rawPath}`);
    }

    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      throw new Error(`rootPath 不是目录: ${rawPath}`);
    }

    return normalized;
  }

  _getEffectiveLocalRootPath(rootPath, allowCached = false) {
    const rawPath = String(rootPath || '').trim();
    if (rawPath) {
      const normalized = this._validateLocalRootPath(rawPath);
      this._lastLocalRootPath = normalized;
      return normalized;
    }

    if (allowCached && this._lastLocalRootPath) {
      const normalized = this._validateLocalRootPath(this._lastLocalRootPath);
      this._lastLocalRootPath = normalized;
      return normalized;
    }

    throw new Error('需要提供本机绝对路径 rootPath');
  }

  _resolveLocalReadTarget(filePath, rootPath = '') {
    const rawFilePath = String(filePath || '').trim();
    if (!rawFilePath) {
      throw new Error('需要提供 filePath');
    }

    if (rootPath || (!path.isAbsolute(rawFilePath) && this._lastLocalRootPath)) {
      const absRoot = this._getEffectiveLocalRootPath(rootPath, true);
      const absPath = path.isAbsolute(rawFilePath)
        ? path.resolve(rawFilePath)
        : path.resolve(absRoot, rawFilePath);
      const relative = path.relative(absRoot, absPath);

      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('文件路径超出 rootPath 范围');
      }

      return {
        absPath,
        rootPath: absRoot,
        displayPath: this._normalizePathSlashes(relative)
      };
    }

    if (!path.isAbsolute(rawFilePath)) {
      throw new Error('工作区外文件读取需要绝对路径 filePath 或提供 rootPath');
    }

    return {
      absPath: path.resolve(rawFilePath),
      rootPath: '',
      displayPath: this._normalizePathSlashes(path.resolve(rawFilePath))
    };
  }

  _createGlobMatcher(pattern = '**/*') {
    const normalizedPattern = this._normalizePathSlashes(pattern || '**/*');
    const tokenized = normalizedPattern
      .replace(/\*\*\//g, '__DOUBLE_STAR_DIR__')
      .replace(/\*\*/g, '__DOUBLE_STAR__')
      .replace(/\*/g, '__SINGLE_STAR__')
      .replace(/\?/g, '__QUESTION__');
    const escaped = tokenized.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
    const source = escaped
      .replace(/__DOUBLE_STAR_DIR__/g, '(?:.*/)?')
      .replace(/__DOUBLE_STAR__/g, '.*')
      .replace(/__SINGLE_STAR__/g, '[^/]*')
      .replace(/__QUESTION__/g, '[^/]');
    const regex = new RegExp(`^${source}$`, 'i');
    return target => regex.test(this._normalizePathSlashes(target));
  }

  _getLocalTopLevelEntries(absRoot, limit = 30) {
    let entries = [];
    try {
      entries = fs.readdirSync(absRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other')
      }));
  }

  _getInterestingLocalFiles(absRoot, limit = 20) {
    const interesting = [];
    const pattern = /(^|\/)(package\.json|product(?:-[^/]+)?\.json|readme(?:\.[^/]+)?|license(?:\.[^/]+)?|manifest(?:\.[^/]+)?|.*\.asar)$/i;

    this._walkLocalFiles(absRoot, (_absPath, relPath) => {
      if (pattern.test(relPath)) {
        interesting.push(relPath);
      }
      return interesting.length < limit;
    }, 4000);

    return interesting;
  }

  _walkLocalFiles(absRoot, onFile, maxVisited = 5000) {
    const stack = [''];
    let visited = 0;
    let truncated = false;

    while (stack.length > 0) {
      const currentRel = stack.pop();
      const currentAbs = currentRel ? path.join(absRoot, currentRel) : absRoot;
      let entries = [];

      try {
        entries = fs.readdirSync(currentAbs, { withFileTypes: true });
      } catch {
        continue;
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        const relPath = currentRel
          ? this._normalizePathSlashes(path.join(currentRel, entry.name))
          : entry.name;

        if (entry.isDirectory()) {
          if (LOCAL_READ_SKIP_DIRS.has(entry.name)) continue;
          stack.push(relPath);
          continue;
        }

        if (!entry.isFile()) continue;

        visited++;
        if (visited > maxVisited) {
          truncated = true;
          return { visited: visited - 1, truncated };
        }

        const shouldContinue = onFile(path.join(absRoot, relPath), relPath);
        if (shouldContinue === false) {
          return { visited, truncated };
        }
      }
    }

    return { visited, truncated };
  }

  _readTextFileSafe(absPath) {
    const stat = fs.statSync(absPath);
    if (stat.size > 1024 * 1024) {
      throw new Error('文件过大，当前只支持读取 1MB 以内的文本文件');
    }

    const content = fs.readFileSync(absPath, 'utf8');
    if (content.includes('\u0000')) {
      throw new Error('文件似乎是二进制内容，当前只支持文本分析');
    }

    return content;
  }

  async _listWorkspaceFiles(pattern, maxResults) {
    const uris = await vscode.workspace.findFiles(
      pattern,
      '{**/node_modules/**,**/.git/**,**/.vscode/**,**/.claude/**}',
      Math.max(1, Math.min(Number(maxResults) || 200, 1000))
    );

    return {
      pattern,
      count: uris.length,
      files: uris.map(uri => this._toRelativePath(uri.fsPath))
    };
  }

  async _searchWorkspaceText(options = {}) {
    const {
      query,
      include = '**/*',
      maxResults = 50,
      isRegexp = false,
      caseSensitive = false
    } = options;

    if (!query) {
      throw new Error('search_text 需要 query');
    }

    const uris = await vscode.workspace.findFiles(
      include,
      '{**/node_modules/**,**/.git/**,**/.vscode/**,**/.claude/**}',
      500
    );

    const regex = new RegExp(isRegexp ? query : escapeRegExp(query), caseSensitive ? 'g' : 'gi');
    const results = [];

    for (const uri of uris) {
      if (results.length >= maxResults) break;

      let content;
      try {
        const stat = fs.statSync(uri.fsPath);
        if (stat.size > 1024 * 1024) continue;
        content = fs.readFileSync(uri.fsPath, 'utf8');
      } catch {
        continue;
      }

      if (content.includes('\u0000')) continue;

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[index])) continue;

        results.push({
          filePath: this._toRelativePath(uri.fsPath),
          line: index + 1,
          text: lines[index].trim().slice(0, 300)
        });

        if (results.length >= maxResults) break;
      }
    }

    return { query, count: results.length, matches: results };
  }

  async _readWorkspaceFile(filePath, startLine = 1, endLine = 200) {
    if (!filePath) {
      throw new Error('read_file 需要 filePath');
    }

    const absPath = this._validateFilePath(filePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const content = fs.readFileSync(absPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const safeStart = Math.max(1, Number(startLine) || 1);
    const safeEnd = Math.min(lines.length, Math.max(safeStart, Number(endLine) || safeStart));

    return {
      filePath: this._toRelativePath(absPath),
      startLine: safeStart,
      endLine: safeEnd,
      totalLines: lines.length,
      content: lines.slice(safeStart - 1, safeEnd).join('\n')
    };
  }

  async _listLocalFiles(options = {}) {
    const absRoot = this._getEffectiveLocalRootPath(options.rootPath);
    const pattern = String(options.pattern || '**/*');
    const maxResults = Math.max(1, Math.min(Number(options.maxResults) || 200, 1000));
    const matcher = this._createGlobMatcher(pattern);
    const files = [];
    const topLevelEntries = this._getLocalTopLevelEntries(absRoot, 30);
    const interestingFiles = this._getInterestingLocalFiles(absRoot, 20);

    const walk = this._walkLocalFiles(absRoot, (_absPath, relPath) => {
      if (matcher(relPath)) {
        files.push(relPath);
      }
      return files.length < maxResults;
    }, Math.max(maxResults * 20, 2000));

    return {
      rootPath: this._normalizePathSlashes(absRoot),
      pattern,
      count: files.length,
      scannedFiles: walk.visited,
      truncated: walk.truncated,
      topLevelEntries,
      interestingFiles,
      files
    };
  }

  async _searchLocalText(options = {}) {
    const absRoot = this._getEffectiveLocalRootPath(options.rootPath, true);
    const query = String(options.query || '');
    const include = String(options.include || '**/*');
    const maxResults = Math.max(1, Math.min(Number(options.maxResults) || 50, 200));
    const isRegexp = !!options.isRegexp;
    const caseSensitive = !!options.caseSensitive;

    if (!query) {
      throw new Error('search_local_text 需要 query');
    }

    const matcher = this._createGlobMatcher(include);
    const regex = new RegExp(isRegexp ? query : escapeRegExp(query), caseSensitive ? 'g' : 'gi');
    const matches = [];

    const walk = this._walkLocalFiles(absRoot, (absPath, relPath) => {
      if (!matcher(relPath)) {
        return true;
      }

      let content;
      try {
        content = this._readTextFileSafe(absPath);
      } catch {
        return true;
      }

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[index])) continue;

        matches.push({
          filePath: relPath,
          line: index + 1,
          text: lines[index].trim().slice(0, 300)
        });

        if (matches.length >= maxResults) {
          return false;
        }
      }

      return true;
    }, Math.max(maxResults * 40, 3000));

    return {
      rootPath: this._normalizePathSlashes(absRoot),
      query,
      include,
      count: matches.length,
      scannedFiles: walk.visited,
      truncated: walk.truncated,
      matches
    };
  }

  async _readLocalFile(options = {}) {
    const resolved = this._resolveLocalReadTarget(options.filePath, options.rootPath || '');
    if (!fs.existsSync(resolved.absPath)) {
      throw new Error(`文件不存在: ${options.filePath}`);
    }

    const stat = fs.statSync(resolved.absPath);
    if (!stat.isFile()) {
      throw new Error(`不是文件: ${options.filePath}`);
    }

    const content = this._readTextFileSafe(resolved.absPath);
    const lines = content.split(/\r?\n/);
    const safeStart = Math.max(1, Number(options.startLine) || 1);
    const safeEnd = Math.min(lines.length, Math.max(safeStart, Number(options.endLine) || safeStart));

    return {
      rootPath: resolved.rootPath ? this._normalizePathSlashes(resolved.rootPath) : '',
      absolutePath: this._normalizePathSlashes(resolved.absPath),
      filePath: resolved.displayPath,
      startLine: safeStart,
      endLine: safeEnd,
      totalLines: lines.length,
      content: lines.slice(safeStart - 1, safeEnd).join('\n')
    };
  }

  async _applyLocalChanges(options = {}) {
    const rootPath = this._getEffectiveLocalRootPath(options.rootPath, true);
    const previewMode = !!options.previewMode;
    const changes = options.changes;

    if (!Array.isArray(changes) || changes.length === 0) {
      throw new Error('apply_local_patch 需要非空 changes 数组');
    }

    const results = [];
    let successCount = 0;

    if (previewMode) {
      for (const change of changes) {
        try {
          const result = await this._applySingleLocalChange(change, rootPath, true);
          results.push({ success: true, ...result });
          successCount++;
        } catch (err) {
          results.push({
            success: false,
            action: change?.action || 'unknown',
            filePath: change?.filePath || '',
            error: err?.message || '未知错误'
          });
        }
      }

      return {
        rootPath: this._normalizePathSlashes(rootPath),
        success: successCount === changes.length,
        summary: `成功 ${successCount}/${changes.length} 项本地修改`,
        results
      };
    }

    const backupSession = this._createLocalBackupSession(rootPath, changes);
    let failure = null;

    for (const change of changes) {
      try {
        const result = await this._applySingleLocalChange(change, rootPath, false);
        results.push({ success: true, ...result });
        successCount++;
      } catch (err) {
        failure = {
          success: false,
          action: change?.action || 'unknown',
          filePath: change?.filePath || '',
          error: err?.message || '未知错误'
        };
        results.push(failure);
        break;
      }
    }

    if (failure) {
      const rollback = await this._rollbackLocalBackupSession(backupSession);
      return {
        rootPath: this._normalizePathSlashes(rootPath),
        success: false,
        summary: `本地修改在第 ${results.length} 项失败，已自动回滚`,
        results,
        rolledBack: true,
        rollbackReason: failure.error,
        rollback,
        backupDir: this._normalizePathSlashes(backupSession.backupDir),
        backedUpFiles: backupSession.trackedPaths
      };
    }

    return {
      rootPath: this._normalizePathSlashes(rootPath),
      success: successCount === changes.length,
      summary: `成功 ${successCount}/${changes.length} 项本地修改`,
      results,
      backupDir: this._normalizePathSlashes(backupSession.backupDir),
      backedUpFiles: backupSession.trackedPaths
    };
  }

  _createLocalBackupSession(rootPath, changes) {
    const backupId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const backupDir = path.join(os.tmpdir(), 'xiaoxiami-local-backups', backupId);
    const snapshots = [];
    const trackedPaths = [];
    const seen = new Set();

    fs.mkdirSync(backupDir, { recursive: true });

    for (const change of changes) {
      for (const target of this._collectLocalChangeTargets(change, rootPath)) {
        if (seen.has(target.displayPath)) continue;
        seen.add(target.displayPath);
        const snapshot = this._snapshotLocalPath(target, backupDir);
        snapshots.push(snapshot);
        trackedPaths.push(snapshot.filePath);
      }
    }

    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
      createdAt: new Date().toISOString(),
      rootPath: this._normalizePathSlashes(rootPath),
      trackedPaths,
      snapshots: snapshots.map(snapshot => ({
        filePath: snapshot.filePath,
        absolutePath: this._normalizePathSlashes(snapshot.absolutePath),
        existed: snapshot.existed,
        backupPath: snapshot.backupPath ? this._normalizePathSlashes(snapshot.backupPath) : ''
      }))
    }, null, 2), 'utf8');

    return { backupDir, trackedPaths, snapshots };
  }

  _collectLocalChangeTargets(change, rootPath) {
    const targets = [];
    const filePath = String(change?.filePath || '').trim();

    if (filePath) {
      targets.push(this._resolveLocalReadTarget(filePath, rootPath));
    }

    if (String(change?.action || '') === 'rename') {
      const newFilePath = String(change?.newFilePath || '').trim();
      if (newFilePath) {
        targets.push(this._resolveLocalReadTarget(newFilePath, rootPath));
      }
    }

    return targets;
  }

  _snapshotLocalPath(target, backupDir) {
    const exists = fs.existsSync(target.absPath);
    const snapshot = {
      filePath: target.displayPath,
      absolutePath: target.absPath,
      existed: exists,
      backupPath: ''
    };

    if (!exists) {
      return snapshot;
    }

    const stat = fs.statSync(target.absPath);
    if (!stat.isFile()) {
      throw new Error(`当前只支持修改文件，不支持目录路径: ${target.displayPath}`);
    }

    const backupPath = path.join(backupDir, target.displayPath.replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(target.absPath, backupPath);
    snapshot.backupPath = backupPath;
    return snapshot;
  }

  async _rollbackLocalBackupSession(session) {
    const snapshots = [...(session?.snapshots || [])].sort((left, right) => right.filePath.localeCompare(left.filePath));
    let restoredCount = 0;
    let removedCount = 0;

    for (const snapshot of snapshots) {
      const absPath = snapshot.absolutePath;
      if (!snapshot.existed) {
        if (fs.existsSync(absPath)) {
          const stat = fs.statSync(absPath);
          if (!stat.isFile()) {
            throw new Error(`回滚失败，目标不是文件: ${snapshot.filePath}`);
          }
          const openDoc = this._getOpenDocumentByPath(absPath);
          if (openDoc?.isDirty) {
            throw new Error(`回滚失败，文件有未保存修改: ${snapshot.filePath}`);
          }
          fs.unlinkSync(absPath);
          removedCount++;
        }
        continue;
      }

      const content = fs.readFileSync(snapshot.backupPath, 'utf8');
      await this._writeTextFile(absPath, content, snapshot.filePath);
      restoredCount++;
    }

    return {
      restoredCount,
      removedCount
    };
  }

  async _applySingleLocalChange(change, rootPath, previewMode = false) {
    const action = change?.action;
    const filePath = change?.filePath;

    if (!action || !filePath) {
      throw new Error('每个 change 都需要 action 和 filePath');
    }

    if (action === 'create') {
      if (previewMode) {
        return { action, filePath, preview: true, message: 'create 操作暂不支持预览' };
      }
      if (typeof change.content !== 'string') {
        throw new Error('create 操作需要 content');
      }
      const resolved = this._resolveLocalReadTarget(filePath, rootPath);
      if (fs.existsSync(resolved.absPath) && !change.overwrite) {
        throw new Error(`文件已存在: ${resolved.displayPath}`);
      }
      await this._writeTextFile(resolved.absPath, change.content, resolved.displayPath);
      return { action, filePath: resolved.displayPath };
    }

    if (action === 'delete') {
      if (previewMode) {
        return { action, filePath, preview: true, message: 'delete 操作暂不支持预览' };
      }
      const resolved = this._resolveLocalReadTarget(filePath, rootPath);
      if (!fs.existsSync(resolved.absPath)) {
        throw new Error(`文件不存在: ${resolved.displayPath}`);
      }
      const openDoc = this._getOpenDocumentByPath(resolved.absPath);
      if (openDoc?.isDirty) {
        throw new Error(`文件有未保存修改，已阻止删除: ${resolved.displayPath}`);
      }
      fs.unlinkSync(resolved.absPath);
      return { action, filePath: resolved.displayPath };
    }

    const resolved = this._resolveLocalReadTarget(filePath, rootPath);
    if (!fs.existsSync(resolved.absPath)) {
      throw new Error(`文件不存在: ${resolved.displayPath}`);
    }

    if (action === 'rename') {
      const newFilePath = String(change.newFilePath || '').trim();
      if (!newFilePath) {
        throw new Error('rename 操作需要 newFilePath');
      }

      const nextResolved = this._resolveLocalReadTarget(newFilePath, rootPath);
      if (nextResolved.absPath === resolved.absPath) {
        throw new Error('rename 目标路径不能与原路径相同');
      }

      const sourceDoc = this._getOpenDocumentByPath(resolved.absPath);
      if (sourceDoc?.isDirty) {
        throw new Error(`文件有未保存修改，已阻止重命名: ${resolved.displayPath}`);
      }

      const targetDoc = this._getOpenDocumentByPath(nextResolved.absPath);
      if (targetDoc?.isDirty) {
        throw new Error(`目标文件有未保存修改，已阻止重命名: ${nextResolved.displayPath}`);
      }

      if (previewMode) {
        return { action, filePath: resolved.displayPath, newFilePath: nextResolved.displayPath, preview: true, message: 'rename 操作暂不支持预览' };
      }

      if (fs.existsSync(nextResolved.absPath)) {
        if (!change.overwrite) {
          throw new Error(`目标文件已存在: ${nextResolved.displayPath}`);
        }
        const targetStat = fs.statSync(nextResolved.absPath);
        if (!targetStat.isFile()) {
          throw new Error(`目标路径不是文件: ${nextResolved.displayPath}`);
        }
        fs.unlinkSync(nextResolved.absPath);
      }

      fs.mkdirSync(path.dirname(nextResolved.absPath), { recursive: true });
      fs.renameSync(resolved.absPath, nextResolved.absPath);
      return { action, filePath: resolved.displayPath, newFilePath: nextResolved.displayPath };
    }

    const originalContent = fs.readFileSync(resolved.absPath, 'utf8');
    let nextContent = originalContent;

    if (action === 'write') {
      if (typeof change.content !== 'string') {
        throw new Error('write 操作需要 content');
      }
      nextContent = change.content;
    } else if (action === 'append') {
      if (typeof change.content !== 'string') {
        throw new Error('append 操作需要 content');
      }
      nextContent = originalContent + change.content;
    } else if (action === 'prepend') {
      if (typeof change.content !== 'string') {
        throw new Error('prepend 操作需要 content');
      }
      nextContent = change.content + originalContent;
    } else if (action === 'replace_lines') {
      if (typeof change.content !== 'string') {
        throw new Error('replace_lines 操作需要 content');
      }
      nextContent = this._applyLineRangeChange(originalContent, change, resolved.displayPath, action, { mode: 'replace' });
    } else if (action === 'delete_lines') {
      nextContent = this._applyLineRangeChange(originalContent, change, resolved.displayPath, action, { mode: 'delete' });
    } else if (action === 'insert_at_line') {
      if (typeof change.content !== 'string') {
        throw new Error('insert_at_line 操作需要 content');
      }
      nextContent = this._applyLineInsertChange(originalContent, change, resolved.displayPath, action);
    } else if (action === 'regex_replace') {
      if (typeof change.replace !== 'string') {
        throw new Error('regex_replace 操作需要 pattern 和 replace');
      }
      nextContent = this._applyRegexReplaceChange(originalContent, change, resolved.displayPath, action);
    } else if (action === 'replace') {
      if (typeof change.replace !== 'string') {
        throw new Error('replace 操作需要 search 和 replace');
      }
      const { search } = this._resolveSearchChange(change, originalContent, resolved.displayPath, action);
      nextContent = change.all
        ? originalContent.split(search).join(change.replace)
        : originalContent.replace(search, change.replace);
    } else if (action === 'insert_before') {
      if (typeof change.content !== 'string') {
        throw new Error('insert_before 操作需要 search 和 content');
      }
      const { search } = this._resolveSearchChange(change, originalContent, resolved.displayPath, action);
      nextContent = change.all
        ? originalContent.split(search).join(change.content + search)
        : originalContent.replace(search, change.content + search);
    } else if (action === 'insert_after') {
      if (typeof change.content !== 'string') {
        throw new Error('insert_after 操作需要 search 和 content');
      }
      const { search } = this._resolveSearchChange(change, originalContent, resolved.displayPath, action);
      nextContent = change.all
        ? originalContent.split(search).join(search + change.content)
        : originalContent.replace(search, search + change.content);
    } else {
      throw new Error(`不支持的 change.action: ${action}`);
    }

    if (previewMode) {
      const preview = await this._showDiffPreview(originalContent, nextContent, resolved.displayPath);
      if (!preview.success) {
        throw new Error(preview.error || '预览失败');
      }
      return { action, filePath: resolved.displayPath, preview: true };
    }

    await this._writeTextFile(resolved.absPath, nextContent, resolved.displayPath);
    return { action, filePath: resolved.displayPath };
  }

  async _listWorkspaceCommands() {
    const workspaceRoot = this._getWorkspaceRoot();
    const packageJsonPath = path.join(workspaceRoot, 'package.json');
    let scripts = {};

    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        scripts = pkg.scripts || {};
      } catch {
        scripts = {};
      }
    }

    const suggested = [];
    const scriptNames = Object.keys(scripts);
    ['test', 'lint', 'build', 'typecheck', 'check', 'verify', 'validate'].forEach(name => {
      if (scriptNames.includes(name)) {
        suggested.push({ command: 'npm', args: ['run', name], source: 'package.json' });
      }
    });

    if (scriptNames.includes('test')) {
      suggested.unshift({ command: 'npm', args: ['test'], source: 'package.json' });
    }

    const validationFiles = ['check_syntax.js', 'check.js', 'validate.js', 'verify.js']
      .filter(file => fs.existsSync(path.join(workspaceRoot, file)));

    validationFiles.forEach(file => {
      suggested.push({ command: 'node', args: [file], source: 'workspace' });
    });

    return {
      packageScripts: scripts,
      validationFiles,
      suggestedCommands: suggested
    };
  }

  async _listWorkspaceTasks() {
    const tasks = await vscode.tasks.fetchTasks();
    const workspaceRoot = this._getWorkspaceRoot();
    const scopedTasks = tasks.filter(task => this._isTaskInWorkspace(task, workspaceRoot));
    const mapped = scopedTasks.map(task => ({
      label: this._getTaskLabel(task),
      source: task.source || '',
      type: task.definition?.type || '',
      detail: task.detail || '',
      isBackground: !!task.isBackground,
      group: task.group?.id || '',
      scope: this._formatTaskScope(task.scope)
    }));

    return {
      count: mapped.length,
      tasks: mapped,
      suggestedTasks: mapped.filter(task => /test|lint|build|typecheck|check|verify|validate/i.test(task.label)).slice(0, 20)
    };
  }

  async _runWorkspaceCommand(options = {}, requestId, emitStream = () => {}) {
    const command = String(options.command || '').trim();
    const args = Array.isArray(options.args) ? options.args.map(arg => String(arg)) : [];
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 120000, 300000));

    if (!command) {
      throw new Error('run_command 需要 command');
    }

    this._validateWorkspaceCommand(command, args);
    const workspaceRoot = this._getWorkspaceRoot();
    const start = Date.now();
    const executable = this._resolveCommandExecutable(command);

    const result = await new Promise(resolve => {
      const child = spawn(executable, args, {
        cwd: workspaceRoot,
        windowsHide: true,
        shell: false,
        env: process.env
      });

      const state = {
        child,
        cancelled: false,
        stdout: '',
        stderr: '',
        finished: false
      };
      if (requestId) {
        this._runningAgentCommands.set(requestId, state);
      }

      const appendOutput = (key, chunk, stream) => {
        if (!chunk) return;
        state[key] = (state[key] + chunk).slice(-12000);
        emitStream({ stream, chunk: chunk.slice(-4000) });
      };

      const timer = setTimeout(() => {
        state.timedOut = true;
        if (process.platform === 'win32' && child.pid) {
          exec(`taskkill /pid ${child.pid} /T /F`, () => {});
        } else {
          child.kill('SIGTERM');
        }
      }, timeoutMs);

      child.stdout?.on('data', data => appendOutput('stdout', String(data), 'stdout'));
      child.stderr?.on('data', data => appendOutput('stderr', String(data), 'stderr'));

      child.on('error', err => {
        clearTimeout(timer);
        if (requestId) {
          this._runningAgentCommands.delete(requestId);
        }
        resolve({
          exitCode: typeof err?.code === 'number' ? err.code : 1,
          timedOut: false,
          cancelled: state.cancelled,
          stdout: state.stdout,
          stderr: state.stderr,
          error: err.message || '命令启动失败'
        });
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (requestId) {
          this._runningAgentCommands.delete(requestId);
        }
        resolve({
          exitCode: typeof code === 'number' ? code : (state.cancelled ? 130 : 1),
          timedOut: !!state.timedOut,
          cancelled: state.cancelled,
          stdout: state.stdout,
          stderr: state.stderr,
          error: state.cancelled ? '命令已停止' : ''
        });
      });
    });

    const diagnostics = await this._getWorkspaceDiagnostics();

    return {
      command,
      args,
      timeoutMs,
      durationMs: Date.now() - start,
      ...result,
      diagnostics
    };
  }

  async _runWorkspaceTask(options = {}, requestId, emitStream = () => {}) {
    const label = String(options.label || options.name || '').trim();
    const source = String(options.source || '').trim();
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 120000, 300000));

    if (!label) {
      throw new Error('run_task 需要 label');
    }

    const task = await this._findWorkspaceTask(label, source);
    if (!task) {
      throw new Error(`未找到任务: ${label}${source ? ` (source: ${source})` : ''}`);
    }

    const execution = await vscode.tasks.executeTask(task);
    const taskLabel = this._getTaskLabel(task);
    emitStream({ stream: 'system', chunk: `任务已启动: ${taskLabel}` });

    return await new Promise(resolve => {
      const state = {
        requestId,
        execution,
        resolve,
        emitStream,
        label: taskLabel,
        source: task.source || '',
        taskType: task.definition?.type || '',
        detail: task.detail || '',
        startedAt: Date.now(),
        timeoutMs,
        timedOut: false,
        cancelled: false,
        finalized: false,
        hadProcess: false,
        processId: null,
        timeoutHandle: setTimeout(() => {
          state.timedOut = true;
          emitStream({ stream: 'system', chunk: `任务超时，已请求停止: ${taskLabel}` });
          try {
            execution.terminate();
          } catch {}
        }, timeoutMs)
      };

      if (requestId) {
        this._runningAgentTasks.set(requestId, state);
      }
    });
  }

  _isTaskInWorkspace(task, workspaceRoot) {
    if (!task) return false;
    if (task.scope === vscode.TaskScope.Workspace || task.scope === vscode.TaskScope.Global) {
      return true;
    }
    if (task.scope && typeof task.scope === 'object' && task.scope.uri?.fsPath) {
      return task.scope.uri.fsPath.startsWith(workspaceRoot);
    }
    return true;
  }

  _formatTaskScope(scope) {
    if (scope === vscode.TaskScope.Workspace) return 'workspace';
    if (scope === vscode.TaskScope.Global) return 'global';
    if (scope && typeof scope === 'object' && scope.name) return scope.name;
    return '';
  }

  _getTaskLabel(task) {
    return task?.name || task?.definition?.label || task?.definition?.script || task?.source || 'unnamed-task';
  }

  async _findWorkspaceTask(label, source = '') {
    const tasks = await vscode.tasks.fetchTasks();
    const workspaceRoot = this._getWorkspaceRoot();
    const normalizedLabel = label.toLowerCase();
    const normalizedSource = source.toLowerCase();
    const candidates = tasks.filter(task => this._isTaskInWorkspace(task, workspaceRoot));

    const exact = candidates.find(task => {
      const taskLabel = this._getTaskLabel(task).toLowerCase();
      const taskSource = String(task.source || '').toLowerCase();
      return taskLabel === normalizedLabel && (!normalizedSource || taskSource === normalizedSource);
    });
    if (exact) return exact;

    const looseMatches = candidates.filter(task => {
      const taskLabel = this._getTaskLabel(task).toLowerCase();
      const taskSource = String(task.source || '').toLowerCase();
      return taskLabel.includes(normalizedLabel) && (!normalizedSource || taskSource === normalizedSource);
    });

    return looseMatches.length === 1 ? looseMatches[0] : null;
  }

  _findRunningTaskEntry(execution) {
    for (const entry of this._runningAgentTasks.values()) {
      if (entry.execution === execution) {
        return entry;
      }
    }
    return null;
  }

  _handleTaskStart(event) {
    const entry = this._findRunningTaskEntry(event.execution);
    if (!entry || entry.finalized) return;
    entry.emitStream({ stream: 'system', chunk: `任务开始: ${entry.label}` });
  }

  _handleTaskProcessStart(event) {
    const entry = this._findRunningTaskEntry(event.execution);
    if (!entry || entry.finalized) return;
    entry.hadProcess = true;
    entry.processId = event.processId;
    entry.emitStream({ stream: 'system', chunk: `任务进程已启动${event.processId ? ` (PID: ${event.processId})` : ''}` });
  }

  _handleTaskProcessEnd(event) {
    const entry = this._findRunningTaskEntry(event.execution);
    if (!entry || entry.finalized) return;
    this._finalizeRunningTask(entry, { exitCode: typeof event.exitCode === 'number' ? event.exitCode : 1 });
  }

  _handleTaskEnd(event) {
    const entry = this._findRunningTaskEntry(event.execution);
    if (!entry || entry.finalized) return;
    if (!entry.hadProcess) {
      this._finalizeRunningTask(entry, { exitCode: entry.cancelled ? 130 : 0 });
    }
  }

  async _finalizeRunningTask(entry, override = {}) {
    if (!entry || entry.finalized) return;
    entry.finalized = true;
    clearTimeout(entry.timeoutHandle);
    if (entry.requestId) {
      this._runningAgentTasks.delete(entry.requestId);
    }

    const diagnostics = await this._getWorkspaceDiagnostics();
    const exitCode = typeof override.exitCode === 'number' ? override.exitCode : (entry.cancelled ? 130 : 0);
    entry.emitStream({ stream: 'system', chunk: `任务结束: ${entry.label} (exitCode: ${exitCode})` });

    entry.resolve({
      label: entry.label,
      source: entry.source,
      taskType: entry.taskType,
      detail: entry.detail,
      processId: entry.processId,
      exitCode,
      timedOut: !!entry.timedOut,
      cancelled: !!entry.cancelled,
      durationMs: Date.now() - entry.startedAt,
      diagnostics,
      note: entry.hadProcess
        ? '任务已执行完成，输出请查看 VS Code 任务终端；此处返回 exitCode 与 diagnostics。'
        : '任务未暴露独立进程输出，此处返回 exitCode 与 diagnostics。',
      error: entry.cancelled ? '任务已停止' : ''
    });
  }

  _resolveCommandExecutable(command) {
    const normalizedCommand = path.basename(command).toLowerCase();
    if (process.platform === 'win32' && !normalizedCommand.endsWith('.cmd')) {
      if (ALLOWED_PACKAGE_RUNNERS.has(normalizedCommand) || ALLOWED_NPX_RUNNERS.has(normalizedCommand)) {
        return `${normalizedCommand}.cmd`;
      }
    }
    return command;
  }

  _validateWorkspaceCommand(command, args) {
    if (!Array.isArray(args)) {
      throw new Error('run_command.args 必须是字符串数组');
    }

    if (args.some(arg => typeof arg !== 'string' || arg.length > 200)) {
      throw new Error('run_command.args 包含非法参数');
    }

    const normalizedCommand = path.basename(command).toLowerCase();

    if (ALLOWED_PACKAGE_RUNNERS.has(normalizedCommand)) {
      this._validatePackageRunnerArgs(args);
      return;
    }

    if (normalizedCommand === 'node') {
      this._validateNodeRunnerArgs(args);
      return;
    }

    if (ALLOWED_NPX_RUNNERS.has(normalizedCommand)) {
      this._validateNpxArgs(args);
      return;
    }

    throw new Error(`命令未被允许: ${command}`);
  }

  _validatePackageRunnerArgs(args) {
    if (args.length === 1 && args[0] === 'test') {
      return;
    }

    if (args.length === 2 && args[0] === 'run' && ALLOWED_SCRIPT_NAMES.test(args[1])) {
      return;
    }

    throw new Error('当前只允许 npm/pnpm/yarn 执行 test 或 run test|lint|build|typecheck|check|verify|validate');
  }

  _validateNodeRunnerArgs(args) {
    if (args.length !== 1) {
      throw new Error('node 仅允许执行单个工作区校验脚本');
    }

    const filePath = args[0];
    if (!/^[\w./-]+\.(js|cjs|mjs)$/i.test(filePath)) {
      throw new Error('node 仅允许执行相对路径的 JS 校验脚本');
    }

    if (!/(check|test|lint|build|verify|validate|syntax)/i.test(path.basename(filePath))) {
      throw new Error('node 仅允许执行名称明确为校验用途的脚本');
    }

    this._validateFilePath(filePath);
  }

  _validateNpxArgs(args) {
    if (args.length === 0) {
      throw new Error('npx 需要工具名');
    }

    if (!ALLOWED_DIRECT_TOOLS.has(args[0])) {
      throw new Error(`npx 仅允许执行以下工具: ${Array.from(ALLOWED_DIRECT_TOOLS).join(', ')}`);
    }

    if (args.slice(1).some(arg => /[|&;><]/.test(arg))) {
      throw new Error('npx 参数包含非法字符');
    }
  }

  async _applyWorkspaceChanges(changes, previewMode = false) {
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new Error('apply_patch 需要非空 changes 数组');
    }

    const results = [];
    let successCount = 0;

    for (const change of changes) {
      try {
        const result = await this._applySingleWorkspaceChange(change, previewMode);
        results.push({ success: true, ...result });
        successCount++;
      } catch (err) {
        results.push({
          success: false,
          action: change?.action || 'unknown',
          filePath: change?.filePath || '',
          error: err?.message || '未知错误'
        });
      }
    }

    return {
      success: successCount === changes.length,
      summary: `成功 ${successCount}/${changes.length} 项修改`,
      results
    };
  }

  async _applySingleWorkspaceChange(change, previewMode = false) {
    const action = change?.action;
    const filePath = change?.filePath;

    if (!action || !filePath) {
      throw new Error('每个 change 都需要 action 和 filePath');
    }

    if (action === 'create') {
      if (previewMode) {
        return { action, filePath, preview: true, message: 'create 操作暂不支持预览' };
      }
      if (typeof change.content !== 'string') {
        throw new Error('create 操作需要 content');
      }
      const absPath = this._validateFilePath(filePath);
      if (fs.existsSync(absPath) && !change.overwrite) {
        throw new Error(`文件已存在: ${filePath}`);
      }
      await this._writeWorkspaceFile(filePath, change.content);
      const validation = await this._getWorkspaceDiagnostics(filePath);
      return { action, filePath, validation };
    }

    if (action === 'delete') {
      if (previewMode) {
        return { action, filePath, preview: true, message: 'delete 操作暂不支持预览' };
      }
      const absPath = this._validateFilePath(filePath);
      if (!fs.existsSync(absPath)) {
        throw new Error(`文件不存在: ${filePath}`);
      }
      const openDoc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === absPath);
      if (openDoc?.isDirty) {
        throw new Error(`文件有未保存修改，已阻止删除: ${filePath}`);
      }
      fs.unlinkSync(absPath);
      return { action, filePath };
    }

    const absPath = this._validateFilePath(filePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    if (action === 'rename') {
      const newFilePath = String(change.newFilePath || '').trim();
      if (!newFilePath) {
        throw new Error('rename 操作需要 newFilePath');
      }

      const newAbsPath = this._validateFilePath(newFilePath);
      if (newAbsPath === absPath) {
        throw new Error('rename 目标路径不能与原路径相同');
      }

      const sourceDoc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === absPath);
      if (sourceDoc?.isDirty) {
        throw new Error(`文件有未保存修改，已阻止重命名: ${filePath}`);
      }

      const targetDoc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === newAbsPath);
      if (targetDoc?.isDirty) {
        throw new Error(`目标文件有未保存修改，已阻止重命名: ${newFilePath}`);
      }

      if (previewMode) {
        return { action, filePath, newFilePath, preview: true, message: 'rename 操作暂不支持预览' };
      }

      if (fs.existsSync(newAbsPath)) {
        if (!change.overwrite) {
          throw new Error(`目标文件已存在: ${newFilePath}`);
        }
        const targetStat = fs.statSync(newAbsPath);
        if (!targetStat.isFile()) {
          throw new Error(`目标路径不是文件: ${newFilePath}`);
        }
        fs.unlinkSync(newAbsPath);
      }

      fs.mkdirSync(path.dirname(newAbsPath), { recursive: true });
      fs.renameSync(absPath, newAbsPath);
      const validation = await this._getWorkspaceDiagnostics(newFilePath);
      return { action, filePath, newFilePath, validation };
    }

    const originalContent = fs.readFileSync(absPath, 'utf8');
    let nextContent = originalContent;

    if (action === 'write') {
      if (typeof change.content !== 'string') {
        throw new Error('write 操作需要 content');
      }
      nextContent = change.content;
    } else if (action === 'append') {
      if (typeof change.content !== 'string') {
        throw new Error('append 操作需要 content');
      }
      nextContent = originalContent + change.content;
    } else if (action === 'prepend') {
      if (typeof change.content !== 'string') {
        throw new Error('prepend 操作需要 content');
      }
      nextContent = change.content + originalContent;
    } else if (action === 'replace_lines') {
      if (typeof change.content !== 'string') {
        throw new Error('replace_lines 操作需要 content');
      }
      nextContent = this._applyLineRangeChange(originalContent, change, filePath, action, { mode: 'replace' });
    } else if (action === 'delete_lines') {
      nextContent = this._applyLineRangeChange(originalContent, change, filePath, action, { mode: 'delete' });
    } else if (action === 'insert_at_line') {
      if (typeof change.content !== 'string') {
        throw new Error('insert_at_line 操作需要 content');
      }
      nextContent = this._applyLineInsertChange(originalContent, change, filePath, action);
    } else if (action === 'regex_replace') {
      if (typeof change.replace !== 'string') {
        throw new Error('regex_replace 操作需要 pattern 和 replace');
      }
      nextContent = this._applyRegexReplaceChange(originalContent, change, filePath, action);
    } else if (action === 'replace') {
      if (typeof change.replace !== 'string') {
        throw new Error('replace 操作需要 search 和 replace');
      }
      const { search } = this._resolveSearchChange(change, originalContent, filePath, action);
      nextContent = change.all
        ? originalContent.split(search).join(change.replace)
        : originalContent.replace(search, change.replace);
    } else if (action === 'insert_before') {
      if (typeof change.content !== 'string') {
        throw new Error('insert_before 操作需要 search 和 content');
      }
      const { search } = this._resolveSearchChange(change, originalContent, filePath, action);
      nextContent = change.all
        ? originalContent.split(search).join(change.content + search)
        : originalContent.replace(search, change.content + search);
    } else if (action === 'insert_after') {
      if (typeof change.content !== 'string') {
        throw new Error('insert_after 操作需要 search 和 content');
      }
      const { search } = this._resolveSearchChange(change, originalContent, filePath, action);
      nextContent = change.all
        ? originalContent.split(search).join(search + change.content)
        : originalContent.replace(search, search + change.content);
    } else {
      throw new Error(`不支持的 change.action: ${action}`);
    }

    if (previewMode) {
      const preview = await this._showDiffPreview(originalContent, nextContent, filePath);
      if (!preview.success) {
        throw new Error(preview.error || '预览失败');
      }
      return { action, filePath, preview: true };
    }

    await this._writeWorkspaceFile(filePath, nextContent);
    const validation = await this._getWorkspaceDiagnostics(filePath);
    return { action, filePath, validation };
  }

  _applyLineRangeChange(originalContent, change, filePath, action, options = {}) {
    const { lines, lineEnding, hadTrailingNewline } = this._splitContentForLineEditing(originalContent);
    const { startIndex, deleteCount } = this._resolveLineRangeChange(change, lines, filePath, action);

    if (options.mode === 'delete') {
      lines.splice(startIndex, deleteCount);
    } else {
      const replacementLines = this._normalizeLineEditContent(change.content);
      lines.splice(startIndex, deleteCount, ...replacementLines);
    }

    return this._joinEditedLines(lines, lineEnding, hadTrailingNewline);
  }

  _applyLineInsertChange(originalContent, change, filePath, action) {
    const { lines, lineEnding, hadTrailingNewline } = this._splitContentForLineEditing(originalContent);
    const lineNumber = Number(change.line ?? change.startLine);

    if (!Number.isInteger(lineNumber) || lineNumber < 1) {
      throw new Error(`${action} 操作需要合法的 line`);
    }

    if (lineNumber > lines.length + 1) {
      throw new Error(`line=${lineNumber} 超出文件范围，当前最多可插入到第 ${lines.length + 1} 行`);
    }

    const insertLines = this._normalizeLineEditContent(change.content);
    lines.splice(lineNumber - 1, 0, ...insertLines);
    return this._joinEditedLines(lines, lineEnding, hadTrailingNewline);
  }

  _applyRegexReplaceChange(originalContent, change, filePath, action) {
    const { count, firstRegex, globalRegex } = this._resolveRegexChange(change, originalContent, filePath, action);
    const useAll = !!change.all;

    if (!useAll && count > 1) {
      throw new Error(`正则匹配到 ${count} 处，请设置 all:true 或补充更精确的 pattern/flags`);
    }

    return useAll
      ? originalContent.replace(globalRegex, change.replace)
      : originalContent.replace(firstRegex, change.replace);
  }

  _resolveSearchChange(change, originalContent, filePath, action) {
    if (typeof change.search !== 'string' || change.search.length === 0) {
      throw new Error(`${action} 操作需要非空 search`);
    }

    const occurrences = originalContent.split(change.search).length - 1;
    if (occurrences === 0) {
      throw new Error(`未找到待处理内容: ${filePath}`);
    }

    const expectedMatches = Number(change.expectedMatches);
    if (Number.isFinite(expectedMatches) && expectedMatches >= 0 && occurrences !== expectedMatches) {
      throw new Error(`匹配数量为 ${occurrences}，与 expectedMatches=${expectedMatches} 不一致`);
    }

    if (!change.all && occurrences > 1) {
      throw new Error(`待处理内容匹配到 ${occurrences} 处，请提供更精确的 search`);
    }

    return {
      search: change.search,
      occurrences
    };
  }

  _resolveLineRangeChange(change, lines, filePath, action) {
    const startLine = Number(change.startLine ?? change.line);
    const endLine = Number(change.endLine ?? change.startLine ?? change.line);

    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error(`${action} 操作需要合法的 startLine/endLine`);
    }

    if (endLine > lines.length) {
      throw new Error(`行范围超出文件范围: ${filePath} 共有 ${lines.length} 行`);
    }

    return {
      startIndex: startLine - 1,
      deleteCount: endLine - startLine + 1
    };
  }

  _resolveRegexChange(change, originalContent, filePath, action) {
    const pattern = String(change.pattern || '');
    const flags = String(change.flags || '');

    if (!pattern) {
      throw new Error(`${action} 操作需要非空 pattern`);
    }

    if (!/^[gimsuy]*$/.test(flags)) {
      throw new Error(`${action} flags 仅支持 gimsuy`);
    }

    if (new Set(flags.split('')).size !== flags.length) {
      throw new Error(`${action} flags 不能重复`);
    }

    let firstRegex;
    let globalRegex;
    try {
      firstRegex = new RegExp(pattern, flags.replace(/g/g, ''));
      globalRegex = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
    } catch (err) {
      throw new Error(`无效的正则表达式: ${err?.message || '未知错误'}`);
    }

    const matches = Array.from(originalContent.matchAll(globalRegex));
    const count = matches.length;
    if (count === 0) {
      throw new Error(`未找到待处理内容: ${filePath}`);
    }

    const expectedMatches = Number(change.expectedMatches);
    if (Number.isFinite(expectedMatches) && expectedMatches >= 0 && count !== expectedMatches) {
      throw new Error(`匹配数量为 ${count}，与 expectedMatches=${expectedMatches} 不一致`);
    }

    return { count, firstRegex, globalRegex };
  }

  _splitContentForLineEditing(content) {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailingNewline = /\r?\n$/.test(content);
    const lines = content.length ? content.split(/\r?\n/) : [''];

    if (hadTrailingNewline) {
      lines.pop();
    }

    return {
      lines,
      lineEnding,
      hadTrailingNewline
    };
  }

  _normalizeLineEditContent(content) {
    const lines = String(content).split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  _joinEditedLines(lines, lineEnding, hadTrailingNewline) {
    if (lines.length === 0) {
      return '';
    }

    return lines.join(lineEnding) + (hadTrailingNewline ? lineEnding : '');
  }

  async _writeWorkspaceFile(filePath, content) {
    const absPath = this._validateFilePath(filePath);
    await this._writeTextFile(absPath, content, filePath);
  }

  _getOpenDocumentByPath(absPath) {
    return vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === absPath);
  }

  async _writeTextFile(absPath, content, displayPath) {
    const uri = vscode.Uri.file(absPath);

    const openDoc = this._getOpenDocumentByPath(absPath);
    if (openDoc?.isDirty) {
      throw new Error(`文件有未保存修改，已阻止覆盖: ${displayPath}`);
    }

    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf8');
      return;
    }

    const doc = openDoc || await vscode.workspace.openTextDocument(uri);
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, content);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`无法写入文件: ${displayPath}`);
    }

    await doc.save();
  }

  async _getWorkspaceDiagnostics(filePath) {
    let entries = [];

    if (filePath) {
      const absPath = this._validateFilePath(filePath);
      const uri = vscode.Uri.file(absPath);
      await vscode.workspace.openTextDocument(uri);
      entries = this._collectDiagnosticsForUri(uri);
      return {
        filePath: this._toRelativePath(absPath),
        count: entries.length,
        diagnostics: entries.slice(0, 50)
      };
    }

    const all = vscode.languages.getDiagnostics();
    entries = all.flatMap(([uri, diagnostics]) => {
      try {
        const rel = this._toRelativePath(uri.fsPath);
        return diagnostics.map(diag => this._formatDiagnostic(rel, diag));
      } catch {
        return [];
      }
    });

    return { count: entries.length, diagnostics: entries.slice(0, 100) };
  }

  _collectDiagnosticsForUri(uri) {
    return vscode.languages.getDiagnostics(uri).map(diag => this._formatDiagnostic(this._toRelativePath(uri.fsPath), diag));
  }

  _formatDiagnostic(filePath, diagnostic) {
    const severityMap = {
      [vscode.DiagnosticSeverity.Error]: 'error',
      [vscode.DiagnosticSeverity.Warning]: 'warning',
      [vscode.DiagnosticSeverity.Information]: 'information',
      [vscode.DiagnosticSeverity.Hint]: 'hint'
    };

    return {
      filePath,
      severity: severityMap[diagnostic.severity] || 'unknown',
      message: diagnostic.message,
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      source: diagnostic.source || ''
    };
  }

  _baiduSearch(query, apiKey) {
    return new Promise(resolve => {
      const body = JSON.stringify({ query, response_format: { type: 'json_object' } });
      const req = https.request({
        hostname: 'qianfan.baidubce.com',
        path: '/v2/app/conversation/runs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 30000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            const text = json.answer || json.result || JSON.stringify(json);
            resolve({ text });
          } catch (e) { resolve({ error: e.message }); }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时' }); });
      req.write(body);
      req.end();
    });
  }

  _bilibiliSearch(keyword, searchType = 'video') {
    const encoded = encodeURIComponent(keyword);
    const fallback = `[手动搜索](https://search.bilibili.com/all?keyword=${encoded}&order=pubdate)`;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    const doSearch = (cookie) => new Promise(resolve => {
      const headers = {
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Origin': 'https://www.bilibili.com'
      };
      if (cookie) headers['Cookie'] = cookie;

      const req = https.get({
        hostname: 'api.bilibili.com',
        path: `/x/web-interface/search/type?search_type=${searchType}&keyword=${encoded}&order=pubdate&page=1`,
        headers,
        timeout: 10000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            const json = JSON.parse(raw);
            if (json.code !== 0) {
              resolve(`⚠️ B站搜索失败（${json.code}）：${json.message || '未知错误'}\n\n${fallback}`);
              return;
            }
            const results = json.data?.result || [];
            if (!results.length) {
              resolve(`未找到 **${keyword}** 的相关视频\n\n${fallback}`);
              return;
            }
            const stripHtml = s => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            let out = `📺 **${keyword}** 最新视频（B站）：\n\n`;
            results.slice(0, 8).forEach((v, i) => {
              const title = stripHtml(v.title);
              const url = `https://www.bilibili.com/video/${v.bvid}`;
              const date = v.pubdate ? new Date(v.pubdate * 1000).toLocaleDateString('zh-CN') : '';
              const views = v.play > 10000 ? (v.play / 10000).toFixed(1) + '万' : String(v.play || '-');
              out += `${i + 1}. **[${title}](${url})**\n`;
              out += `   👤 ${v.author} · 📅 ${date} · ▶️ ${views}次\n\n`;
            });
            out += `---\n[查看更多结果](https://search.bilibili.com/all?keyword=${encoded}&order=pubdate)`;
            resolve(out);
          } catch (e) {
            resolve(`⚠️ B站API被风控拦截，请直接访问：\n\n${fallback}`);
          }
        });
      });
      req.on('error', e => resolve(`⚠️ 连接B站失败：${e.message}`));
      req.on('timeout', () => { req.destroy(); resolve('⚠️ 请求超时'); });
    });

    // 先获取 buvid3/buvid4 cookie，再带 cookie 搜索
    return new Promise(resolve => {
      const req = https.get({
        hostname: 'api.bilibili.com',
        path: '/x/frontend/finger/spi',
        headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com' },
        timeout: 8000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', async () => {
          let cookie = '';
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (json.code === 0 && json.data) {
              const b3 = json.data.b_3 || '';
              const b4 = json.data.b_4 || '';
              if (b3) cookie = `buvid3=${b3}; buvid4=${b4}`;
            }
          } catch (e) { /* ignore, search without cookie */ }
          resolve(await doSearch(cookie));
        });
      });
      req.on('error', async () => resolve(await doSearch('')));
      req.on('timeout', async () => { req.destroy(); resolve(await doSearch('')); });
    });
  }

  _prismfySearch(query, apiKey) {
    return new Promise(resolve => {
      const encoded = encodeURIComponent(query);
      const req = https.request({
        hostname: 'api.prismfy.io',
        path: `/search?q=${encoded}&key=${encodeURIComponent(apiKey)}`,
        method: 'GET',
        timeout: 30000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ json });
          } catch (e) { resolve({ error: e.message }); }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时' }); });
      req.end();
    });
  }

  _execSkill(cmd) {
    return new Promise(resolve => {
      exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ stdout: stdout || '', stderr: stderr || '', error: err ? err.message : null });
      });
    });
  }

  _generateImage(prompt, resolution, apiKey) {
    return new Promise(resolve => {
      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { imageSize: resolution }
        }
      });
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${encodeURIComponent(apiKey)}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 60000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode === 400 || res.statusCode === 401 || res.statusCode === 403) {
              resolve({ error: json.error?.message || `HTTP ${res.statusCode}`, prompt });
              return;
            }
            const parts = json.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                resolve({ imageData: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png', prompt });
                return;
              }
            }
            resolve({ error: '未返回图像数据，请稍后重试', prompt });
          } catch (e) { resolve({ error: e.message, prompt }); }
        });
      });
      req.on('error', e => resolve({ error: e.message, prompt }));
      req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时（60s），请重试', prompt }); });
      req.write(body);
      req.end();
    });
  }

  _browseUrl(url) {
    return new Promise(resolve => {
      exec(`agent-browser open "${url}" && agent-browser wait --load load && agent-browser snapshot -i --json`, { timeout: 15000 }, (err, stdout) => {
        if (err) {
          const lib = url.startsWith('https') ? https : http;
          const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              const html = Buffer.concat(chunks).toString('utf8');
              // 提取纯文本
              const text = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s{2,}/g, '\n')
                .trim()
                .slice(0, 3000);
              resolve({ result: `🌐 **${url}**\n\n${text}\n\n---\n*内容已截取前3000字*` });
            });
          });
          req.on('error', e => resolve({ error: `无法访问页面：${e.message}` }));
          req.on('timeout', () => { req.destroy(); resolve({ error: '页面加载超时' }); });
        } else {
          // agent-browser 成功，解析 snapshot
          try {
            const json = JSON.parse(stdout);
            const snapshot = json.data?.snapshot || JSON.stringify(json).slice(0, 2000);
            resolve({ result: `🌐 **${url}**\n\n\`\`\`\n${snapshot.slice(0, 2000)}\n\`\`\`` });
          } catch {
            resolve({ result: `🌐 **${url}**\n\n${stdout.slice(0, 2000)}` });
          }
        }
      });
    });
  }

  _matonApi(args, apiKey) {
    return new Promise(resolve => {
      // args 格式：[METHOD] /service/path [JSON_body]
      // 例：GET /google-sheets/v4/spreadsheets/xxx/values/A1:B2
      //     POST /slack/api/chat.postMessage {"channel":"C123","text":"hi"}
      const parts = args.match(/^(GET|POST|PUT|PATCH|DELETE)?\s*(\/\S+)\s*([\s\S]*)$/i);
      if (!parts) { resolve({ error: '格式错误。示例：`GET /slack/api/conversations.list` 或 `POST /slack/api/chat.postMessage {"channel":"C123","text":"hi"}`' }); return; }
      const method = (parts[1] || 'GET').toUpperCase();
      const path = parts[2];
      const bodyStr = parts[3].trim();
      const bodyBuf = bodyStr ? Buffer.from(bodyStr) : null;
      const options = {
        hostname: 'gateway.maton.ai',
        path,
        method,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000
      };
      if (bodyBuf) options.headers['Content-Length'] = bodyBuf.length;
      const req = https.request(options, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ result: JSON.stringify(json, null, 2).slice(0, 4000) });
          } catch { resolve({ result: Buffer.concat(chunks).toString().slice(0, 2000) }); }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时' }); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  _admapixSearch(keyword, apiKey) {
    return new Promise(resolve => {
      const body = JSON.stringify({
        content_type: 'creative', keyword, page: 1, page_size: 20,
        sort_field: '15', sort_rule: 'desc', generate_page: true
      });
      const req = https.request({
        hostname: 'api.admapix.com',
        path: '/api/data/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode === 401 || res.statusCode === 403) {
              resolve('❌ API Key 无效，请重新配置：`/admapix-key 你的key`');
              return;
            }
            const list = json.list || [];
            const stripHtml = s => (s || '').replace(/<[^>]+>/g, '');
            let out = `🎯 搜索 **${keyword}** 的广告素材结果：\n\n`;
            if (json.page_url) {
              out += `👉 [查看完整素材页](https://api.admapix.com${json.page_url})\n\n`;
            }
            if (list.length) {
              const top = list.slice(0, 5);
              top.forEach((item, i) => {
                const appName = stripHtml(item.appList?.[0]?.name || '');
                const imp = item.impression ? (item.impression > 1e8 ? (item.impression / 1e8).toFixed(1) + '亿' : item.impression > 1e4 ? (item.impression / 1e4).toFixed(0) + '万' : item.impression) : '-';
                out += `${i + 1}. **${stripHtml(item.title || item.describe || appName || '无标题')}**\n`;
                out += `   📱 ${appName || '未知'} · 曝光 ${imp} · 投放 ${item.findCntSum || '-'} 天\n`;
                if (item.videoUrl?.[0]) out += `   [▶️ 播放视频](${item.videoUrl[0]})\n`;
                else if (item.imageUrl?.[0]) out += `   [🖼 查看图片](${item.imageUrl[0]})\n`;
                out += '\n';
              });
            } else {
              out += '未找到相关素材，请换个关键词试试。\n';
            }
            out += '💡 试试：`/广告分析 ' + keyword + '` 获取深度策略分析';
            resolve(out);
          } catch { resolve('⚠️ 解析响应失败，请稍后重试。'); }
        });
      });
      req.on('error', () => resolve('⚠️ 连接 AdMapix 失败，请检查网络。'));
      req.on('timeout', () => { req.destroy(); resolve('⚠️ 请求超时，请重试。'); });
      req.write(body);
      req.end();
    });
  }

  _admapixDeepResearch(query, apiKey) {
    return new Promise(resolve => {
      // Step 1: 提交深度研究任务
      const submitBody = JSON.stringify({ project: 'admapix', query, api_key: apiKey });
      const submitReq = https.request({
        hostname: 'deepresearch.admapix.com',
        path: '/research',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-local-token-2026',
          'Content-Length': Buffer.byteLength(submitBody)
        },
        timeout: 15000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (json.error?.code === 'api_key_required') {
              resolve('❌ API Key 无效，请重新配置：`/admapix-key 你的key`'); return;
            }
            const taskId = json.task_id;
            if (!taskId) { resolve('⚠️ 提交分析任务失败，请重试。'); return; }
            // Step 2: 轮询结果
            this._admapixPoll(taskId, resolve);
          } catch { resolve('⚠️ 提交失败，请重试。'); }
        });
      });
      submitReq.on('error', () => resolve('⚠️ 连接深度分析服务失败，请检查网络。'));
      submitReq.on('timeout', () => { submitReq.destroy(); resolve('⚠️ 提交超时，请重试。'); });
      submitReq.write(submitBody);
      submitReq.end();
    });
  }

  _admapixPoll(taskId, resolve, attempts = 0) {
    if (attempts > 30) { resolve('⚠️ 分析超时（超过 7.5 分钟），请稍后重试。'); return; }
    const req = https.get({
      hostname: 'deepresearch.admapix.com',
      path: `/research/${taskId}`,
      headers: { 'Authorization': 'Bearer test-local-token-2026' },
      timeout: 10000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (json.status === 'completed') {
            const summary = json.output?.summary || '无摘要';
            const reportUrl = json.output?.files?.[0]?.url || '';
            let out = '📊 **深度分析完成！**\n\n**核心发现：**\n' + summary + '\n\n';
            if (reportUrl) out += `👉 [查看完整报告](${reportUrl})\n`;
            resolve(out);
          } else if (json.status === 'failed') {
            resolve(`❌ 分析失败：${json.error?.message || '未知错误'}`);
          } else {
            setTimeout(() => this._admapixPoll(taskId, resolve, attempts + 1), 15000);
          }
        } catch { setTimeout(() => this._admapixPoll(taskId, resolve, attempts + 1), 15000); }
      });
    });
    req.on('error', () => setTimeout(() => this._admapixPoll(taskId, resolve, attempts + 1), 15000));
    req.on('timeout', () => { req.destroy(); setTimeout(() => this._admapixPoll(taskId, resolve, attempts + 1), 15000); });
  }

  _webSearch(query) {
    return new Promise(resolve => {
      const encoded = encodeURIComponent(query);
      const fallback = (reason) => resolve(
        `⚠️ ${reason || '搜索失败'}\n\n` +
        `**建议改用内置搜索：**\n` +
        `- 输入 \`/百度 ${query}\` 使用百度搜索\n` +
        `- 输入 \`/prismfy ${query}\` 使用多引擎搜索\n\n` +
        `或手动访问：[百度](https://www.baidu.com/s?wd=${encoded})`
      );

      // 使用 DuckDuckGo HTML 搜索（返回真实结果，非 Instant Answer API）
      const options = {
        hostname: 'html.duckduckgo.com',
        path: `/html/?q=${encoded}&kl=cn-zh`,
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        },
        timeout: 10000
      };

      const req = https.request(options, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const html = Buffer.concat(chunks).toString('utf8');
            const results = [];

            // 提取搜索结果条目
            const resultBlockRe = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
            let m;
            while ((m = resultBlockRe.exec(html)) !== null && results.length < 6) {
              const url = m[1].startsWith('/') ? `https://duckduckgo.com${m[1]}` : m[1];
              const title = m[2].replace(/<[^>]+>/g, '').trim();
              const snippet = m[3].replace(/<[^>]+>/g, '').trim();
              if (title && url) results.push({ title, url, snippet });
            }

            if (results.length === 0) { fallback('未找到结果，可能是网络受限'); return; }

            let out = `搜索 **${query}** 的结果：\n\n`;
            results.forEach((r, i) => {
              out += `${i + 1}. **[${r.title}](${r.url})**\n`;
              if (r.snippet) out += `   ${r.snippet}\n`;
              out += '\n';
            });
            out += `---\n*via DuckDuckGo · [更多结果](https://duckduckgo.com/?q=${encoded})*`;
            resolve(out);
          } catch { fallback('解析搜索结果失败'); }
        });
      });
      req.on('error', () => fallback('网络受限，无法访问搜索引擎'));
      req.on('timeout', () => { req.destroy(); fallback('请求超时，网络可能受限'); });
      req.write(`q=${encoded}&kl=cn-zh`);
      req.end();
    });
  }

  async _applyCodeToEditor(code, filePath = null, options = {}) {
    const { isNewFile = false, previewMode = false } = options;

    try {
      // ── 输入验证 ──
      if (!code) {
        const error = '代码不能为空';
        this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error });
        return { success: false, error };
      }

      if (code.length > 10 * 1024 * 1024) {  // 10MB 限制
        const error = '代码过大（>10MB），无法写入';
        this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error });
        return { success: false, error };
      }

      // ── 处理新建文件 ──
      if (isNewFile && filePath) {
        return await this._createNewFile(code, filePath);
      }

      // ── 处理 Diff 预览 ──
      if (previewMode && filePath) {
        try {
          const originalContent = await this._readFileContent(filePath);
          const result = await this._showDiffPreview(originalContent, code, filePath);
          if (!result.success) {
            this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error: result.error });
          }
          return result;
        } catch (err) {
          const error = `预览失败: ${err.message}`;
          this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error });
          return { success: false, error };
        }
      }

      // ── 获取编辑器 ──
      let editor;
      if (filePath) {
        try {
          const absPath = this._validateFilePath(filePath);
          const fileUri = vscode.Uri.file(absPath);
          const doc = await vscode.workspace.openTextDocument(fileUri);
          editor = await vscode.window.showTextDocument(doc);
        } catch (err) {
          const error = `无法打开文件 ${filePath}: ${err.message}`;
          this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error, filePath });
          return { success: false, error };
        }
      } else {
        editor = this._lastEditor || vscode.window.activeTextEditor;
      }

      if (!editor) {
        const error = '没有打开的文件，请先在编辑器中打开一个文件';
        vscode.window.showWarningMessage(error);
        this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error });
        return { success: false, error };
      }

      // ── 执行编辑 ──
      const success = await editor.edit(editBuilder => {
        if (!editor.selection.isEmpty) {
          // 替换选中部分
          editBuilder.replace(editor.selection, code);
        } else {
          // 在光标位置插入
          editBuilder.insert(editor.selection.active, code);
        }
      });

      if (!success) {
        const error = '代码写入失败，请重试';
        this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error });
        return { success: false, error };
      }

      // ── 成功响应 ──
      const actualFilePath = filePath || editor.document.fileName;
      this._view?.webview.postMessage({
        type: 'applyCodeResult',
        success: true,
        filePath: actualFilePath,
        lineCount: editor.document.lineCount
      });

      // ── 自动验证 Phase A ──
      const _ext = (actualFilePath || '').split('.').pop()?.toLowerCase();
      const _jsExts = ['js', 'jsx', 'mjs', 'cjs'];
      if (_jsExts.includes(_ext)) {
        const validResult = await this._syntaxCheckNode(code);
        this._view?.webview.postMessage({
          type: 'validationResult',
          lang: 'javascript',
          filePath: actualFilePath,
          success: validResult.success,
          message: validResult.message
        });
      }

      return { success: true };
    } catch (err) {
      const errorMsg = err?.message || '未知错误';
      console.error('[applyCodeToEditor]', errorMsg, err);
      this._view?.webview.postMessage({
        type: 'applyCodeResult',
        success: false,
        error: `系统错误: ${errorMsg}`
      });
      return { success: false, error: errorMsg };
    }
  }

  _validateFilePath(filePath) {
    const workspaceDir = this._getWorkspaceRoot();
    const absPath = path.resolve(workspaceDir, filePath);
    const normalized = path.normalize(absPath);
    const relative = path.relative(workspaceDir, normalized);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('文件路径超出工作区范围');
    }

    for (const segment of relative.split(path.sep)) {
      if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
        throw new Error(`不能修改 ${segment} 目录下的文件 (安全保护)`);
      }
    }

    return normalized;
  }

  async _createNewFile(code, filePath) {
    try {
      // 验证路径
      const absPath = this._validateFilePath(filePath);

      // 检查文件是否已存在
      if (fs.existsSync(absPath)) {
        const error = `文件已存在: ${filePath}`;
        this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error, filePath });
        return { success: false, error };
      }

      // 创建父目录
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 写入文件
      fs.writeFileSync(absPath, code, 'utf-8');

      // 在编辑器中打开文件
      const uri = vscode.Uri.file(absPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      // 成功响应
      this._view?.webview.postMessage({
        type: 'applyCodeResult',
        success: true,
        filePath: absPath,
        lineCount: code.split('\n').length
      });

      return { success: true, filePath: absPath };
    } catch (err) {
      const errorMsg = err?.message || '未知错误';
      console.error('[createNewFile]', errorMsg, err);
      this._view?.webview.postMessage({
        type: 'applyCodeResult',
        success: false,
        error: `创建文件失败: ${errorMsg}`
      });
      return { success: false, error: errorMsg };
    }
  }

  async _readFileContent(filePath) {
    try {
      const absPath = this._validateFilePath(filePath);
      const fs = require('fs');

      if (!fs.existsSync(absPath)) {
        throw new Error('文件不存在');
      }

      return fs.readFileSync(absPath, 'utf-8');
    } catch (err) {
      console.error('[readFileContent]', err);
      throw err;
    }
  }

  async _showDiffPreview(originalContent, newContent, filePath) {
    try {
      // 创建临时文件存储原内容
      const tempDir = path.join(require('os').tmpdir(), 'vsc-diff-preview');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const timestamp = Date.now();
      const originalPath = path.join(tempDir, `original-${timestamp}.txt`);
      fs.writeFileSync(originalPath, originalContent, 'utf-8');

      const newPath = path.join(tempDir, `new-${timestamp}.txt`);
      fs.writeFileSync(newPath, newContent, 'utf-8');

      // 打开 diff 编辑器
      const fileName = path.basename(filePath);
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(originalPath),
        vscode.Uri.file(newPath),
        `对比: ${fileName}`
      );

      return { success: true };
    } catch (err) {
      const errorMsg = err?.message || '未知错误';
      console.error('[showDiffPreview]', errorMsg, err);
      return { success: false, error: errorMsg };
    }
  }

  async _applyCodeBatch(changes, previewMode = false) {
    try {
      if (!Array.isArray(changes) || changes.length === 0) {
        const error = '修改列表不能为空';
        this._view?.webview.postMessage({ type: 'applyCodeBatchResult', success: false, error });
        return { success: false, error };
      }

      const results = [];
      let successCount = 0;

      for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        const { code, filePath, isNewFile = false } = change;

        if (!code || !filePath) {
          results.push({ filePath, success: false, error: '代码或文件路径缺失' });
          continue;
        }

        try {
          const options = { isNewFile, previewMode: false };  // 批量操作不支持预览
          const result = await this._applyCodeToEditor(code, filePath, options);

          if (result.success) {
            results.push({ filePath, success: true });
            successCount++;
          } else {
            results.push({ filePath, success: false, error: result.error });
          }
        } catch (err) {
          results.push({ filePath, success: false, error: err.message });
        }
      }

      const allSuccess = successCount === changes.length;

      // 返回结果给 webview
      this._view?.webview.postMessage({
        type: 'applyCodeBatchResult',
        success: allSuccess,
        results,
        summary: `成功 ${successCount}/${changes.length} 个文件`
      });

      return { success: allSuccess, results };
    } catch (err) {
      const errorMsg = err?.message || '未知错误';
      console.error('[applyCodeBatch]', errorMsg, err);
      this._view?.webview.postMessage({
        type: 'applyCodeBatchResult',
        success: false,
        error: `批量修改失败: ${errorMsg}`
      });
      return { success: false, error: errorMsg };
    }
  }

  async _acceptCode(code, lang) {
    try {
      // ── 选择验检工具 ──
      let result;
      switch (lang?.toLowerCase()) {
        case 'javascript':
        case 'js':
        case 'typescript':
        case 'ts':
          result = await this._syntaxCheckNode(code);
          break;
        case 'python':
        case 'py':
          result = await this._syntaxCheckPython(code);
          break;
        default:
          result = { success: false, message: `暂不支持 ${lang} 语言检查` };
      }

      // ── 返回结果给 webview ──
      this._view?.webview.postMessage({
        type: 'acceptCodeResult',
        lang,
        ...result
      });

      return result;
    } catch (err) {
      console.error('[acceptCode]', err);
      this._view?.webview.postMessage({
        type: 'acceptCodeResult',
        success: false,
        message: `检查出错: ${err.message}`
      });
    }
  }

  async _syntaxCheckNode(code) {
    try {
      // 使用 Node.js 的 Function 构造函数检查语法
      // 这样不需要调用外部命令，速度快且安全
      new Function(code);
      return { success: true, message: '语法正确' };
    } catch (err) {
      // 提取错误信息
      const match = err.toString().match(/SyntaxError: (.*?)(?:\n|$)/);
      const errMsg = match ? match[1] : err.message;
      return { success: false, message: errMsg };
    }
  }

  async _syntaxCheckPython(code) {
    // 可选：集成 Python 检查（需要系统有 python3）
    // 暂时返回不支持
    return { success: false, message: 'Python 检查暂未实现' };
  }

  sendCodeContext(label, code, lang) {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({ type: EVENT_TYPES.CODE_CONTEXT, label, code, lang });
    }
  }

  _sendEditorContext() {
    const ctx = getEditorContext(this._lastEditor || vscode.window.activeTextEditor);
    if (ctx.error) {
      this._view?.webview.postMessage({ type: EVENT_TYPES.EDITOR_CONTEXT, error: ctx.error });
      return;
    }
    if (ctx.selectedText) {
      this._view?.webview.postMessage({ type: EVENT_TYPES.CODE_CONTEXT, label: `${ctx.fileName} 选中内容`, code: ctx.selectedText, lang: ctx.lang });
    } else {
      this._view?.webview.postMessage({ type: EVENT_TYPES.EDITOR_CONTEXT, error: '请先在编辑器中选中代码，再点击此按钮' });
    }
  }

  _sendFileContext() {
    const ctx = getEditorContext(this._lastEditor || vscode.window.activeTextEditor);
    if (ctx.error) {
      this._view?.webview.postMessage({ type: EVENT_TYPES.EDITOR_CONTEXT, error: ctx.error });
      return;
    }
    this._view?.webview.postMessage({ type: EVENT_TYPES.CODE_CONTEXT, label: `当前文件: ${ctx.fileName}`, code: ctx.document.getText(), lang: ctx.lang });
  }

  _getHtml(webview) {
    if (this._cachedHtml) return this._cachedHtml;
    const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'webview.html');
    try {
      this._cachedHtml = fs.readFileSync(htmlPath, 'utf8');
      return this._cachedHtml;
    } catch (error) {
      vscode.window.showErrorMessage(`无法读取视图HTML文件：${error.message}`);
      return '';
    }
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  __test__: {
    ChatViewProvider,
    getEditorContext,
    escapeRegExp
  }
};
