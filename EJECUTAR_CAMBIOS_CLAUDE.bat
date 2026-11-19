@echo off
setlocal
cd /d "%~dp0"
set "LOG=%~dp0log_cambios_claude.txt"
set "RAMA=cambios-20261118-1208"
echo ==== %date% %time% ==== > "%LOG%"
if not exist "cambios_claude.patch" (echo ERROR: falta cambios_claude.patch >>"%LOG%" & goto fin)
copy /y "cambios_claude.patch" "%TEMP%\cambios_claude.patch" >nul
echo 1) stash >>"%LOG%"
git stash push -m "antes-de-dashboard-claude" >>"%LOG%" 2>&1
echo 2) rama %RAMA% al dia >>"%LOG%"
git fetch origin %RAMA% >>"%LOG%" 2>&1 || (echo ERROR: fetch fallo >>"%LOG%" & goto fin)
git switch %RAMA% >>"%LOG%" 2>&1 || git switch -c %RAMA% origin/%RAMA% >>"%LOG%" 2>&1 || (echo ERROR: no pude cambiar a la rama >>"%LOG%" & goto fin)
git reset -q --hard origin/%RAMA% >>"%LOG%" 2>&1
echo 3) aplicar parche >>"%LOG%"
git apply --whitespace=nowarn "%TEMP%\cambios_claude.patch" >>"%LOG%" 2>&1 || (echo ERROR: el parche no aplico >>"%LOG%" & goto fin)
if not exist "Servicio_Web\supabase\modulos\37_dashboard.sql" (echo ERROR: no se ven los archivos nuevos >>"%LOG%" & goto fin)
git add -A -- Servicio_Web >>"%LOG%" 2>&1
git commit -m "Dashboard de venta de cartera en vivo; cada vendedor ve solo su resultado" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" >>"%LOG%" 2>&1 || (echo ERROR: commit fallo >>"%LOG%" & goto fin)
echo 4) push >>"%LOG%"
git push origin %RAMA% >>"%LOG%" 2>&1 || (echo ERROR: push fallo >>"%LOG%" & goto fin)
git switch main >>"%LOG%" 2>&1
git merge --ff-only %RAMA% >>"%LOG%" 2>&1
del "cambios_claude.patch" "%TEMP%\cambios_claude.patch" >nul 2>&1
echo LISTO >>"%LOG%"
:fin
echo ==== fin %time% ==== >>"%LOG%"
endlocal
