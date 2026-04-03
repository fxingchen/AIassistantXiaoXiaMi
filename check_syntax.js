const fs = require('fs');

const html = fs.readFileSync('media/webview.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

if (scriptMatch) {
  const script = scriptMatch[1];
  const lines = script.split('\n');
  
  console.log('Total lines:', lines.length);
  
  // 逐行编译找出错误位置
  let code = '';
  for (let i = 0; i < lines.length; i++) {
    code += lines[i] + '\n';
    try {
      new Function(code);
    } catch (e) {
      // 检查上一行是否正常
      if (i > 0) {
        try {
          new Function(code.slice(0, -lines[i].length - 1));
          console.log('Error at line', i + 1, ':', lines[i].substring(0, 100));
          console.log('Error:', e.message);
          break;
        } catch (e2) {
          // 继续累积
        }
      }
    }
  }
}
