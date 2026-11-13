@echo off
cd /d "%~dp0"
title Venta de Cartera Web - Carga a Supabase
py -m pip install --quiet --upgrade pandas psycopg2-binary
py cargar_supabase.py
