@echo off
setlocal
cd /d "%~dp0"
title Aplicar cambios de Claude (Funnel, descargas, propuesta final)
where git >nul 2>&1 || (echo ERROR: Git no esta instalado. & pause & exit /b 1)
if not exist "cambios_claude.patch" (echo No encuentro cambios_claude.patch en esta carpeta. & pause & exit /b 1)

echo 1) Guardando cambios locales sin subir (git stash, por si acaso)...
git stash push -u -m "antes-de-cambios-claude" >nul 2>&1

echo 2) Trayendo lo ultimo de GitHub (main)...
git switch main >nul 2>&1
git pull --ff-only origin main
if errorlevel 1 (echo No se pudo actualizar main. Revisa tu conexion o avisale a Claude. & pause & exit /b 1)

echo 3) Aplicando los cambios...
git apply --cached --whitespace=nowarn cambios_claude.patch
if errorlevel 1 (echo El parche no se pudo aplicar. No se cambio nada. Avisale a Claude. & pause & exit /b 1)
git checkout -- Servicio_Web
del cambios_claude.patch

echo.
echo ================================================
echo LISTO. Ahora corre SUBIR_CAMBIOS_PR.bat para mandar el Pull Request.
echo (Si tenias cambios sin subir quedaron guardados: git stash list)
echo ================================================
pause
(goto) 2>nul & del "%~f0"
