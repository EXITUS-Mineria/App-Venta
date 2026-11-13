@echo off
setlocal
cd /d "%~dp0"
title Venta de Cartera - Crear repositorio Git

where git >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git no esta instalado. Instalalo desde https://git-scm.com/download/win
    echo y vuelve a ejecutar este archivo.
    pause
    exit /b 1
)

if exist ".git" (
    echo Este folder ya tiene repositorio Git.
    git status --short
    pause
    exit /b 0
)

REM La carpeta interna .git se guarda FUERA de OneDrive para que no se
REM sincronice a los vendedores ni se dane con la sincronizacion.
set "GITDIR=%USERPROFILE%\repos\venta_cartera.git"
if not exist "%USERPROFILE%\repos" mkdir "%USERPROFILE%\repos"

git init --separate-git-dir "%GITDIR%" -b main
git config user.name >nul 2>&1 || git config user.name "%USERNAME%"
git config user.email >nul 2>&1 || git config user.email "%USERNAME%@exitus.com"
git config core.autocrlf true

git add .
echo.
echo Archivos que entran al repositorio (sin datos de clientes ni credenciales):
git status --short
echo.
git commit -m "Venta de Cartera: v9 productiva + v10 Supabase en Pruebas_v10 + AGENTS.md"
git tag v9-productiva

echo.
echo ================================================
echo REPOSITORIO CREADO
echo   Codigo:   %CD%
echo   Historia: %GITDIR%
echo ================================================
echo Para subirlo a GitHub/Azure DevOps:
echo   git remote add origin URL_DEL_REPOSITORIO
echo   git push -u origin main --tags
pause
endlocal
