@echo off
setlocal
cd /d "%~dp0"
title Venta de Cartera - Subir a GitHub (EXITUS-Mineria/App-Venta)
set "REMOTO=https://github.com/EXITUS-Mineria/App-Venta.git"

where git >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git no esta instalado. Instalalo desde https://git-scm.com/download/win
    pause & exit /b 1
)

REM 1) Crear el repositorio si no existe (historia fuera de OneDrive)
if not exist ".git" (
    if not exist "%USERPROFILE%\repos" mkdir "%USERPROFILE%\repos"
    git init --separate-git-dir "%USERPROFILE%\repos\venta_cartera.git" -b main
)
git config user.name >nul 2>&1 || git config user.name "%USERNAME%"
git config user.email >nul 2>&1 || git config user.email "%USERNAME%@exitus.com"
git config core.autocrlf true

REM 1b) Servidor MCP de Supabase para Claude Code (alcance de proyecto)
if not exist ".mcp.json" if exist "mcp_supabase.json" copy /y "mcp_supabase.json" ".mcp.json" >nul

REM 2) Agent Skills de Supabase (opcional, requiere Node.js)
where npx >nul 2>&1
if not errorlevel 1 (
    if not exist ".agents\skills\supabase" (
        echo Instalando Agent Skills de Supabase...
        call npx -y skills add supabase/agent-skills --yes
    )
) else (
    echo Aviso: Node.js no esta instalado; se omiten las Agent Skills de Supabase.
)

REM 3) Confirmar cambios (sin datos: .gitignore excluye CSV, Apartados, credenciales)
git add -A
git diff --cached --quiet || git commit -m "Venta de Cartera: v9 productiva, Pruebas_v10, Servicio_Web modular, MCP Supabase"
git tag v9-productiva >nul 2>&1

REM 4) Conectar con GitHub
git remote get-url origin >nul 2>&1 || git remote add origin %REMOTO%
git remote set-url origin %REMOTO%

REM Si GitHub ya tiene contenido (README, etc.), se une a la historia local
git ls-remote --exit-code --heads origin main >nul 2>&1
if not errorlevel 1 (
    git pull --no-rebase --allow-unrelated-histories --no-edit origin main
    if errorlevel 1 (
        echo.
        echo Hay archivos en conflicto con lo que ya existe en GitHub. Revisa "git status".
        pause & exit /b 1
    )
)

echo.
echo Subiendo... si aparece una ventana de GitHub, inicia sesion con tu cuenta.
git push -u origin main --tags
if errorlevel 1 (
    echo.
    echo No se pudo subir. Verifica que tu cuenta de GitHub tenga permiso de escritura
    echo en EXITUS-Mineria/App-Venta.
    pause & exit /b 1
)

echo.
echo ================================================
echo LISTO: codigo en %REMOTO%
echo Siguiente: abre una terminal en esta carpeta y ejecuta
echo     claude /mcp
echo   elige "supabase" ^> Authenticate e inicia sesion en Supabase.
echo ================================================
pause
endlocal
