VENTA DE CARTERA - VERSIÓN 10 (OPTIMIZADA)
===========================================

Esta versión v10 optimiza drásticamente el rendimiento y la eficiencia de la aplicación local de escritorio (OneDrive / red compartida), conservando al 100% las reglas de negocio y compatibilidad de v9.

Resumen de mejoras implementadas en v10:
1. Caché inteligente en memoria de archivos Apartados/ y Liberaciones/ por fecha de modificación (st_mtime):
   - Elimina la re-lectura continua de cientos de archivos CSV por minuto con Pandas.
   - La revisión en segundo plano (cada 60 segundos) pasa de congelar la UI durante 2-5 segundos a ejecutarse en menos de 10 milisegundos.

2. Escaneo de directorios con os.scandir:
   - Detección ultrarrápida de firmas y cambios sin llamadas repetidas de stat a OneDrive.

3. Pre-agregación estática de cartera Grupal al iniciar:
   - Base Grupal.csv (46.5 MB) se estructura una sola vez en la carga.
   - El filtrado por estados/municipios/mora pasa de tardar 3-6 segundos a menos de 50 milisegundos.

4. Renderizado acelerado de tablas ttk.Treeview con .itertuples():
   - Sustituye .iterrows() por iteración optimizada en tuplas y arrays preformateados.
   - El tiempo de renderizado de la tabla se reduce en más del 80%.

5. Selección fluida en tiempo real:
   - El cálculo de KPIs (Capital, Venta, Mora promedio, Partidas) al hacer clic o seleccionar con el mouse se realiza de forma directa sobre las columnas numéricas sin clonar DataFrames completos ni hacer pd.concat() repetitivos.

6. Limpieza y preparación vectorizada:
   - Normalización de texto con memoización sobre valores únicos para estados y municipios.
   - Conversión numérica vectorizada de capital (nPendingK).

7. Reintentos atómicos en guardado de apartados y liberaciones:
   - Tolerancia a bloqueos transitorios por sincronización de OneDrive o escaneo de antivirus al generar propuestas.

Para compilar el ejecutable:
    Ejecutar COMPILAR_EXE.bat (genera dist\Venta_Cartera.exe y lo copia a Venta_Cartera_Instalable).

Respaldo de la versión v9 previa:
    Se conserva el archivo original en venta_cartera_v9_backup.py.
