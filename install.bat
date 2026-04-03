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
for /d %%D in ("%USERPROFILE%\.vscode\extensions\xingkong.claude-chat-*") do rmdir /s /q "%%~fD" 2>nul

for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "Get-ChildItem -LiteralPath '%~dp0' -Filter 'claude-chat-*.vsix' ^| Sort-Object Name -Descending ^| Select-Object -First 1 -ExpandProperty FullName"`) do set "VSIX_PATH=%%F"

if not defined VSIX_PATH (
	echo 未找到可安装的 VSIX 包，请先打包。
	pause
	exit /b 1
)

echo [3/4] 安装新版本...
code --install-extension "%VSIX_PATH%" --force

echo [4/4] 启动 VS Code...
timeout /t 1 /nobreak >nul
start code

echo.
echo ✓ 安装完成！
echo.
echo 猫咪头像会眨眼睛哦~ 每3秒眨一次 😸
echo.
pause
