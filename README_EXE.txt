VENTA DE CARTERA - KIT PARA EXE

La app esta preparada para ejecutarse como:
    Venta_Cartera.exe

Los CSV NO se meten dentro del EXE.
Deben estar en la misma carpeta:

    Venta_Cartera_Instalable\
        Venta_Cartera.exe
        Base JyP.csv
        Base Grupal.csv

El EXE busca las bases en la carpeta donde esta el EXE,
incluso cuando se genera como PyInstaller --onefile.

Para crear el EXE en Windows:
    1. Tener Python 3.13 instalado.
    2. Ejecutar COMPILAR_EXE.bat.
    3. Tomar la carpeta Venta_Cartera_Instalable.

Para que todos trabajen sobre las MISMAS bases:
    - Coloca la carpeta en una carpeta compartida de red.
    - Ejemplo:
        \\SERVIDOR\VentaCartera\
    - Todos deben tener lectura y escritura.
    - NO hagas una copia independiente de los CSV por usuario.

De esta manera:
    Usuario A aparta -> Estatus = Propuesta/Venta
    Usuario B abre/actualiza -> ya no ve ese registro como Disponible.

Nota:
    El EXE de Windows no puede compilarse directamente en este entorno
    Linux. Por eso este kit incluye el codigo y un compilador .bat que
    genera el EXE nativo de Windows en una sola ejecución.


VERSION 4 - DIAS PROMEDIO DE MORA:
- Usa la columna iDays cuando existe en las bases.
- Muestra iDays en JyP.
- Muestra Dias Promedio Mora por grupo en Grupal.
- Muestra mora en Dual.
- La selección muestra el promedio de iDays seleccionado.
- El CSV de propuesta incluye DiasPromedioMoraPropuesta.
- Si iDays no existe o está vacío, muestra N/D.


VERSION 5 - BOTON APARTAR VISIBLE:
- La barra de acciones queda fija al fondo de la ventana.
- Validar y apartar siempre queda visible.
- Se mantiene la tabla expandible arriba de la barra.


VERSION 6 - BOTONES SUPERIORES:
- Seleccionar todos, Limpiar selección y Validar y apartar quedan junto a Aplicar filtros.
- Se eliminó la barra inferior de botones.
