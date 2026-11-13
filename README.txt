VENTA DE CARTERA - v1.2

Incluye:
- Usuario Windows automático.
- JyP.
- Grupal.
- Dual: JyP + Grupal en una misma propuesta.
- Estado con selección múltiple.
- Municipios dinámicos según Estados seleccionados.
- Sólo grupos completamente disponibles pueden apartarse.
- Capital objetivo con rango de $1,000 abajo y $2,000 arriba.
- Validación final local antes de exportar.
- CSV en Latin-1 para Funnel.

ARCHIVOS:
- venta_cartera.py
- Base JyP.csv
- Base Grupal.csv
- ejecutar_app.bat

REQUISITOS:
- Windows
- Python 3.10 o superior recomendado
- pandas

INSTALACIÓN:
1. Instala Python.
2. Abre CMD en esta carpeta.
3. Ejecuta:
   pip install pandas
4. Ejecuta:
   python venta_cartera.py

O usa:
   ejecutar_app.bat

IMPORTANTE:
Esta versión es el prototipo local. La actualización/apartado central en SharePoint
todavía no está conectado. La siguiente fase puede usar Microsoft Graph/SharePoint
para que todos los usuarios consulten y aparten contra la misma fuente central.

CORRECCIÓN v1.2:
- Corregido el error que limpiaba los resultados inmediatamente después de aplicar filtros.
- Ahora JyP, Grupal y Dual muestran correctamente los registros filtrados.


CORRECCIÓN v2:
- Corregido el KeyError 'vGroupId' al validar/apartar JyP.
- JyP se valida únicamente por vReference.
- Grupal se valida por vGroupId.
- Dual puede contener ambos tipos sin mezclar columnas.


VERSION 3:
- Casilla visual ☐/☑ por registro.
- Botón Seleccionar todos.
- Los grupos bloqueados aparecen con — y no se pueden seleccionar.


VERSION 4 - CORRECCIÓN:
- Corregido KeyError: 'vGroupId' cuando la selección contiene únicamente JyP.
- La validación ahora revisa vGroupId solo cuando existe una selección Grupal.
- También se hizo robusta la validación de vReference para selecciones únicamente Grupales.


VERSION 5 - ETIQUETADO DE APARTADOS:
- Al confirmar y generar la propuesta, se actualiza Estatus en las bases.
- JyP seleccionado: Estatus = Propuesta/Venta.
- Grupal seleccionado: TODOS los integrantes del grupo quedan como Propuesta/Venta.
- Se hace una revalidación final antes de modificar los CSV.
- Se recargan las bases y los registros apartados dejan de aparecer como disponibles.
