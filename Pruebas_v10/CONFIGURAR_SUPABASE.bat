@echo off
cd /d "%~dp0"
title Venta de Cartera v10 - Configurar Supabase
py -m pip install --upgrade pandas psycopg2-binary
py configurar_supabase.py
