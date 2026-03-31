const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const EVENT_TYPES = {
  CHAT: 'chat',
  GET_EDITOR: 'getEditor',
  GET_FILE: 'getFile',
  SHOW_INFO: 'showInfo',
  SHOW_ERROR: 'showError',
  CODE_CONTEXT: 'codeContext',
  EDITOR_CONTEXT: 'editorContext'
};

let chatViewProvider;

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

    // 记录最后一个活跃的文本编辑器（点击 webview 时不会丢失）
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
          this._lastEditor = editor;
          if (this._view?.visible) this._pushAutoContext(editor);
        }
      })
    );
    // 选区变化时自动推送上下文
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (this._view?.visible) this._pushAutoContext(e.textEditor);
      })
    );
    // 初始化时捕获当前编辑器
    if (vscode.window.activeTextEditor) {
      this._lastEditor = vscode.window.activeTextEditor;
    }
  }

  _pushAutoContext(ed) {
    if (!this._view?.webview) return;
    const editor = ed || this._lastEditor || vscode.window.activeTextEditor;
    if (!editor) {
      this._view.webview.postMessage({ type: 'autoContext', clear: true });
      return;
    }
    const fileName = path.basename(editor.document.fileName);
    const lang = editor.document.languageId;
    const selection = editor.selection;
    if (!selection.isEmpty) {
      const code = editor.document.getText(selection);
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const label = startLine === endLine ? `${fileName}:${startLine}` : `${fileName}:${startLine}-${endLine}`;
      this._view.webview.postMessage({ type: 'autoContext', label, code, lang });
    } else {
      const code = editor.document.getText();
      this._view.webview.postMessage({ type: 'autoContext', label: fileName, code, lang });
    }
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._pushAutoContext();
    });

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case EVENT_TYPES.CHAT:
          await this._handleChat(msg);
          break;
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
      }
    });
  }

  sendCodeContext(label, code, lang) {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({ type: EVENT_TYPES.CODE_CONTEXT, label, code, lang });
    }
  }

  _getEditorContext() {
    const editor = this._lastEditor || vscode.window.activeTextEditor;
    if (!editor) {
      return { error: '没有打开的文件，请先在编辑器中打开文件' };
    }
    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    const fileName = path.basename(editor.document.fileName);
    const lang = editor.document.languageId;
    return { editor, selection, selectedText, fileName, lang };
  }

  _sendEditorContext() {
    const context = this._getEditorContext();
    if (context.error) {
      this._view?.webview.postMessage({ type: EVENT_TYPES.EDITOR_CONTEXT, error: context.error });
      return;
    }
    if (context.selectedText) {
      this._view?.webview.postMessage({ type: EVENT_TYPES.CODE_CONTEXT, label: `${context.fileName} 选中内容`, code: context.selectedText, lang: context.lang });
    } else {
      this._view?.webview.postMessage({ type: EVENT_TYPES.EDITOR_CONTEXT, error: '请先在编辑器中选中代码，再点击此按钮' });
    }
  }

  _sendFileContext() {
    const context = this._getEditorContext();
    if (context.error) {
      this._view?.webview.postMessage({ type: EVENT_TYPES.EDITOR_CONTEXT, error: context.error });
      return;
    }
    this._view?.webview.postMessage({ type: EVENT_TYPES.CODE_CONTEXT, label: `当前文件: ${context.fileName}`, code: context.editor.document.getText(), lang: context.lang });
  }

  async _handleChat(msg) {
    // Chat is handled entirely in the webview via fetch()
    // This handler is kept for any future server-side needs
  }

  _getHtml(webview) {
    const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'webview.html');
    try {
      let html = fs.readFileSync(htmlPath, 'utf8');
      return html;
    } catch (error) {
      vscode.window.showErrorMessage(`无法读取视图HTML文件：${error.message}`);
      return '';
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
