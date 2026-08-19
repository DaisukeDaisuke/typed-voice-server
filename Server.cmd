@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0" || goto :fail

where.exe node.exe >nul 2>&1 || (
  echo -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  echo ^|  Node.js がインストールされていません！                              ^|
  echo ^|  winget install -e --id OpenJS.NodeJS.LTS                            ^|
  echo -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  goto :fail
)

node "%~dp0docker.mjs" || goto :preflight_fail

echo.
node "%~dp0server-main.mjs" %* || goto :server_fail

endlocal
exit /b 0

:preflight_fail
echo.
echo 起動条件を満たしていないため、サーバーを開始しません。
goto :fail

:server_fail
echo.
echo サーバーがエラーで終了しました。
goto :fail

:fail
echo.
pause
endlocal
exit /b 1
