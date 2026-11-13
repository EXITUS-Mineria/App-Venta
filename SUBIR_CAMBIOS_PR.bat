@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Venta de Cartera - Subir cambios por Pull Request
set "REPO=EXITUS-Mineria/App-Venta"

where git >nul 2>&1 || (echo ERROR: Git no esta instalado. & pause & exit /b 1)
if not exist ".mcp.json" if exist "mcp_supabase.json" copy /y "mcp_supabase.json" ".mcp.json" >nul

REM ---- nombre de la rama: cambios-AAAAMMDD-HHMM ----
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "FECHA=%%i"
set "RAMA=cambios-%FECHA%"
set /p "MSG=Describe los cambios (Enter = 'Actualizacion Venta de Cartera'): "
if "%MSG%"=="" set "MSG=Actualizacion Venta de Cartera"

echo.
echo 1) Trayendo lo ultimo de main...
git fetch origin main
if errorlevel 1 (echo No se pudo conectar con GitHub. & pause & exit /b 1)

echo 2) Creando la rama %RAMA% ...
git switch -c %RAMA%
if errorlevel 1 (echo No se pudo crear la rama. & pause & exit /b 1)

echo 3) Guardando cambios (sin datos ni credenciales: .gitignore)...
git add -A
git diff --cached --quiet && (echo No hay cambios nuevos para subir. & git switch - & git branch -D %RAMA% & pause & exit /b 0)
git commit -m "%MSG%"

echo 4) Integrando main por si alguien subio cambios...
git merge --no-edit origin/main
if errorlevel 1 (
    echo.
    echo Hay conflictos con main. Resuelvelos ^(git status^) y vuelve a correr este archivo.
    pause & exit /b 1
)

echo 5) Subiendo la rama a GitHub...
git push -u origin %RAMA%
if errorlevel 1 (echo No se pudo subir la rama. Revisa tu permiso en %REPO%. & pause & exit /b 1)

echo 6) Abriendo el Pull Request...
where gh >nul 2>&1
if not errorlevel 1 (
    gh pr create --repo %REPO% --base main --head %RAMA% --title "%MSG%" --body "Cambios de Venta de Cartera (rama %RAMA%)." && gh pr view --repo %REPO% %RAMA% --web
) else (
    start "" "https://github.com/%REPO%/compare/main...%RAMA%?expand=1"
    echo Se abrio GitHub en el navegador: da clic en "Create pull request".
)

echo.
echo 7) Regresando a main (tu carpeta queda igual)...
git switch main
git merge --ff-only %RAMA% >nul 2>&1
echo.
echo ================================================
echo LISTO. Cuando aprueben y hagan Merge del Pull Request,
echo la siguiente vez este archivo trae los cambios de main solo.
echo ================================================
pause
endlocal
