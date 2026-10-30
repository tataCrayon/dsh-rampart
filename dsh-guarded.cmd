# 用启动壳启动 DeepSeek Harness（整棵 Electron 进程树带内存硬顶）。
#
# 为什么用 .cmd 而不是 .ps1：双击可直接跑，不需要改执行策略。
# 真正逻辑在 scripts/launch.mjs（与插件共用同一套 Win32 绑定）。
@echo off
setlocal
set "HERE=%~dp0"
node "%HERE%scripts\launch.mjs" %*
endlocal
exit /b %ERRORLEVEL%
