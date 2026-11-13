@echo off
setlocal
cd /d "%~dp0"

title Compilar Venta de Cartera v9

echo ================================================
echo      VENTA DE CARTERA v9 - COMPILAR EXE
echo ================================================
echo.

where py >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python no esta instalado.
    echo Instala Python 3.13 para Windows y vuelve a ejecutar.
    pause
    exit /b 1
)

echo Instalando dependencias...
py -m pip install --upgrade pip
py -m pip install --upgrade pandas pyinstaller

echo.
echo Limpiando compilaciones anteriores...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist Venta_Cartera.spec del /q Venta_Cartera.spec

echo.
echo Compilando...
py -m PyInstaller --noconfirm --clean --onefile --windowed --name "Venta_Cartera" venta_cartera.py

if errorlevel 1 (
    echo.
    echo ERROR DURANTE LA COMPILACION.
    pause
    exit /b 1
)

echo.
echo Actualizando carpeta para distribuir...
if not exist "Venta_Cartera_Instalable" mkdir "Venta_Cartera_Instalable"

REM Solo se reemplaza el EXE. Las bases, la bitacora y las propuestas
REM registradas que ya existan en la carpeta NO se tocan.
copy /y "dist\Venta_Cartera.exe" "Venta_Cartera_Instalable\Venta_Cartera.exe" >nul

if not exist "Venta_Cartera_Instalable\Base JyP.csv" (
    copy /y "Base JyP.csv" "Venta_Cartera_Instalable\Base JyP.csv" >nul
    echo Se copio Base JyP.csv
) else (
    echo Base JyP.csv ya existe en Instalable: se conserva.
)

if not exist "Venta_Cartera_Instalable\Base Grupal.csv" (
    copy /y "Base Grupal.csv" "Venta_Cartera_Instalable\Base Grupal.csv" >nul
    echo Se copio Base Grupal.csv
) else (
    echo Base Grupal.csv ya existe en Instalable: se conserva.
)

if not exist "Venta_Cartera_Instalable\Apartados" mkdir "Venta_Cartera_Instalable\Apartados"
if not exist "Venta_Cartera_Instalable\Liberaciones" mkdir "Venta_Cartera_Instalable\Liberaciones"
if not exist "Venta_Cartera_Instalable\Propuestas_Registradas" mkdir "Venta_Cartera_Instalable\Propuestas_Registradas"

echo.
echo ================================================
echo EXE LISTO
echo ================================================
echo.
echo %CD%\Venta_Cartera_Instalable\Venta_Cartera.exe
echo.
echo Comparte la carpeta Venta_Cartera_Instalable por OneDrive.
echo Ver INSTRUCCIONES_COMPARTIR.txt
echo.
pause
endlocal
