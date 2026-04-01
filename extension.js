const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');

const EVENT_TYPES = {
  GET_EDITOR: 'getEditor',
  GET_FILE: 'getFile',
  SHOW_INFO: 'showInfo',
  SHOW_ERROR: 'showError',
  CODE_CONTEXT: 'codeContext',
  EDITOR_CONTEXT: 'editorContext'
};

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
    this._view = null;
    this._lastEditor = null;
    this._autoCtxTimer = null;
    this._cachedHtml = null;

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
          this._context.globalState.update('sf_api_key', msg.key);
          break;
        }
        case 'requestApiKey': {
          const key = this._context.globalState.get('sf_api_key', '');
          this._view?.webview.postMessage({ type: 'loadApiKey', key });
          break;
        }
        case 'applyCode': {
          this._applyCodeToEditor(msg.code);
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

  _applyCodeToEditor(code) {
    const editor = this._lastEditor || vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('没有打开的文件，请先在编辑器中打开一个文件');
      this._view?.webview.postMessage({ type: 'applyCodeResult', success: false, error: '没有打开的文件' });
      return;
    }
    editor.edit(editBuilder => {
      if (!editor.selection.isEmpty) {
        editBuilder.replace(editor.selection, code);
      } else {
        editBuilder.insert(editor.selection.active, code);
      }
    }).then(success => {
      if (success) {
        this._view?.webview.postMessage({ type: 'applyCodeResult', success: true });
      }
    });
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

module.exports = { activate, deactivate };
