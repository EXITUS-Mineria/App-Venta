VENTA DE CARTERA - v8

Se conserva todo el funcionamiento de v1 a v6: tipos de venta JyP, Grupal y Dual,
filtros Estado/Municipio, solo grupos 100% disponibles, rango -$1,000 / +$2,000,
validación final, CSV Latin-1 para Funnel y Estatus = Propuesta/Venta en las bases.

NUEVO EN v8 (front)
- Tema Ejecutivo Exitus Credit: mismo JSON de los dashboards (Segoe UI, tinta #1F2430,
  rojo #B01217, fondo #F3F4F6, tarjetas blancas con borde #D9DDE3, encabezados de
  tabla oscuros, selección #FCEAEC).
- KPIs: Disponibles en filtro, Capital seleccionado (verde en rango, amarillo cuánto
  falta, rojo cuánto excede), Valor de venta, Mora promedio y Partidas.
- Filtro Días de mora (De / a). En Grupal se usa el promedio del grupo.
- Búsqueda de municipios: escribe y la lista se filtra; lo elegido se conserva al buscar.
- Buscar vReference / Grupo: una o varias separadas por coma, espacio o pegadas de
  Excel. Una sola busca por "contiene"; varias buscan exactas. En Grupal encuentra el
  grupo por vGroupId o por la vReference de cualquier integrante. Con búsqueda no es
  obligatorio elegir Estado.
- Botón Limpiar filtros.
- Sugerir propuesta ahora intercambia una partida si con la primera pasada no llega al rango.

NUEVO EN v7
1. Sugerir propuesta
   - Después de Aplicar filtros, elige la prioridad (mayor/menor mora, mayor/menor
     capital) y presiona "Sugerir propuesta".
   - La app marca las casillas hasta caer dentro del rango del capital objetivo.
   - Puedes ajustar a mano y luego usar "Validar y apartar".

2. Bloqueo multiusuario
   - Mientras un usuario aparta o libera, se crea ~VentaCartera.lock junto a las bases.
   - Si otro usuario intenta apartar al mismo tiempo, espera hasta 20 s; si sigue
     ocupado, recibe un aviso con quién está apartando. Nadie sobrescribe a nadie.
   - Si la app se cierra de golpe, el bloqueo caduca solo a los 5 minutos.

3. Orden seguro al apartar
   - Antes: se generaba el CSV y después se etiquetaban las bases (si fallaba el
     etiquetado quedaba una propuesta sin apartar).
   - Ahora: bloqueo -> revalidación -> etiquetado -> CSV de Funnel -> bitácora.
     Si falla el CSV, el etiquetado se revierte solo.
   - Las bases se reescriben sin alterar el texto de las demás celdas.
   - Solo se reescribe la base que cambió (JyP o Grupal).

4. Bitácora / Liberar
   - Bitacora_Propuestas.csv: quién, cuándo, capital, venta, mora y estatus de cada
     propuesta.
   - Propuestas_Registradas\: copia de cada propuesta, aunque el usuario la guarde
     en otra carpeta.
   - "Liberar seleccionada" regresa a Disponible los registros de una propuesta
     cancelada (solo los que siguen en Propuesta/Venta) y registra quién, cuándo y por qué.
   - "Liberar desde archivo CSV…" sirve para propuestas hechas con versiones anteriores.

5. Diagnóstico y recarga
   - Al abrir, la app avisa si una base no tiene registros Disponible, tiene Estatus
     vacíos o filas repetidas.
   - Botón "Recargar bases" (arriba a la derecha) para ver lo que otros apartaron
     sin cerrar la app.
   - Si Base Grupal no trae iDays, la mora se toma de Diasatraso_hoy.

COMPILAR
   - Ejecuta COMPILAR_EXE.bat. Ahora solo reemplaza el EXE en Venta_Cartera_Instalable;
     ya no borra las bases, la bitácora ni las propuestas registradas que estén ahí.
