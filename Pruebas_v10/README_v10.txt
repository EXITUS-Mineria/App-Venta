VENTA DE CARTERA v10 - SUPABASE
================================

Con el archivo conexion_supabase.ini junto a la app, TODO vive en Supabase:
  venta.bases        Base JyP y Base Grupal (comprimidas, con versión)
  venta.apartados    cada crédito / integrante apartado
  venta.liberaciones propuestas liberadas
Sin ese archivo la app sigue funcionando con la carpeta (igual que v9).

VENTAJAS
- Apartar es una sola transacción con candado en la base de datos:
  dos vendedores ya NO pueden apartar el mismo crédito o grupo.
- Ya no depende de que OneDrive sincronice.
- Las bases se descargan una vez por versión y quedan en caché en cada equipo
  (%LOCALAPPDATA%\VentaCartera\cache); abrir la app tarda segundos.

ESTA ES UNA VERSIÓN DE PRUEBA (carpeta Pruebas_v10)
- La app productiva (carpeta de arriba) NO cambia: sigue en v9 con carpetas.
- El configurador toma las bases y apartados de la carpeta productiva sólo para leerlos.
- Lo que apartes o liberes aquí queda SOLO en Supabase; no afecta a los vendedores.
- Para probar: PROBAR_APP_V10.bat (necesita Python en tu equipo).
- Para salir a producción: vuelve a correr CONFIGURAR_SUPABASE.bat y responde 's' a
  borrar los apartados de prueba; así se copian los apartados reales del momento.

CONFIGURAR (Daniel, una sola vez)
1. Doble clic en CONFIGURAR_SUPABASE.bat (en Pruebas_v10).
2. Host: primero prueba el que propone (db.vwlfxkaxiduvolbvdmmg.supabase.co).
   Si falla: en Supabase > botón Connect > "Session pooler", copia el host
   (aws-…pooler.supabase.com), puerto 5432, y vuelve a correr el .bat.
3. Escribe la contraseña de postgres (no se guarda).
4. El script crea las tablas, el usuario limitado venta_app, sube las bases,
   pasa los apartados/liberaciones de las carpetas y escribe conexion_supabase.ini.
5. Abre PROBAR_APP_V10.bat: en el encabezado debe decir '☁ Supabase'.

USUARIO venta_app (el que usa el EXE)
- Sólo puede: leer bases, leer y registrar apartados y liberaciones.
- No puede borrar, modificar ni subir bases.

CADA MES (administrador)
- App > Bitácora > "☁ Subir bases": eliges Base JyP / Base Grupal y escribes la
  contraseña de postgres. Todos reciben la nueva versión al abrir o con Recargar bases.

SEGURIDAD
- La contraseña de postgres se compartió en un chat: cámbiala en Supabase
  (Project Settings > Database > Reset database password) después de configurar.
  La app no la usa; sólo se pide al subir bases.
