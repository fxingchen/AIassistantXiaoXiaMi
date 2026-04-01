@echo off
chcp 65001 >nul
echo.
echo ╔══════════════════════════════════════╗
echo ║   小虾米扩展安装工具                   ║
echo ║   会眨眼的猫咪头像版本 🐱              ║
echo ╚══════════════════════════════════════╝
echo.

echo [1/4] 正在关闭 VS Code...
taskkill /f /im Code.exe 2>nul
taskkill /f /im "VS Code.exe" 2>nul
timeout /t 2 /nobreak >nul

echo [2/4] 清理旧版本...
rmdir /s /q "%USERPROFILE%\.vscode\extensions\xingkong.claude-chat-0.0.2" 2>nul

echo [3/4] 安装新版本...
code --install-extension "%~dp0claude-chat-0.0.2.vsix" --force

echo [4/4] 启动 VS Code...
timeout /t 1 /nobreak >nul
start code

echo.
echo ✓ 安装完成！
echo.
echo 猫咪头像会眨眼睛哦~ 每3秒眨一次 😸
echo.
pause
