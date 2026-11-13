@echo off
title Venta de Cartera - pagina local
cd /d "%~dp0"
py servidor_local.py
if errorlevel 1 python servidor_local.py
pause
