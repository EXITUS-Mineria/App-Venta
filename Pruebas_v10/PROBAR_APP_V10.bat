@echo off
cd /d "%~dp0"
title Venta de Cartera v10 - PRUEBA
py -m pip install --quiet --upgrade pandas psycopg2-binary
py venta_cartera.py
