# -*- coding: utf-8 -*-
"""
Venta de Cartera v10 - Configuración inicial de Supabase (se corre UNA vez).

Qué hace:
 1. Se conecta con el usuario postgres (te pide la contraseña, no la guarda).
 2. Crea el esquema "venta" con las tablas bases, apartados y liberaciones.
 3. Crea el usuario limitado "venta_app" (sólo lee bases y registra apartados).
 4. Sube Base JyP.csv y Base Grupal.csv de esta carpeta.
 5. Pasa a Supabase los apartados y liberaciones que ya existen en las
    carpetas Apartados\\ y Liberaciones\\ (no duplica si lo corres de nuevo).
 6. Prueba el usuario venta_app y escribe conexion_supabase.ini.

Uso:  doble clic en CONFIGURAR_SUPABASE.bat  (o:  py configurar_supabase.py)
"""

import os
import sys
import glob
import gzip
import getpass
import secrets
import string
import configparser

import pandas as pd

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    print("Falta psycopg2. Ejecuta:  py -m pip install psycopg2-binary")
    sys.exit(1)

APP_DIR = os.path.dirname(os.path.abspath(__file__))
# En la carpeta de pruebas no hay bases ni apartados: se toman (sólo lectura)
# de la carpeta productiva, que es la carpeta de arriba.
PRODUCTIVA = os.path.dirname(APP_DIR)


def buscar(nombre):
    """Ruta del archivo/carpeta en la carpeta de la app o, si no está, en la productiva."""
    for base in (APP_DIR, PRODUCTIVA):
        ruta = os.path.join(base, nombre)
        if os.path.exists(ruta):
            return ruta
    return os.path.join(APP_DIR, nombre)
PROYECTO = "vwlfxkaxiduvolbvdmmg"
HOST_DIRECTO = f"db.{PROYECTO}.supabase.co"

DDL = """
create schema if not exists venta;

create table if not exists venta.bases (
    id         bigserial primary key,
    nombre     text not null check (nombre in ('JyP', 'Grupal')),
    contenido  bytea not null,           -- CSV original comprimido (gzip)
    archivo    text,
    filas      integer,
    bytes      integer,
    usuario    text,
    subido     timestamptz not null default now(),
    vigente    boolean not null default true
);
create index if not exists bases_vigente on venta.bases (nombre) where vigente;

create table if not exists venta.apartados (
    id                   bigserial primary key,
    id_propuesta         text not null,
    fecha_propuesta      text,
    usuario_windows      text,
    equipo_windows       text,
    tipo_venta           text,
    tipo_cartera         text,
    vreference           text,
    vgroupid             text,
    npendingk            numeric,
    capital_objetivo     text,
    capital_seleccionado text,
    centavos_por_peso    text,
    valor_venta          text,
    dias_promedio_mora   text,
    archivo_funnel       text,
    creado               timestamptz not null default now()
);
create index if not exists apartados_propuesta on venta.apartados (id_propuesta);
create index if not exists apartados_ref on venta.apartados (vreference);
create index if not exists apartados_grupo on venta.apartados (vgroupid);

create table if not exists venta.liberaciones (
    id                bigserial primary key,
    id_propuesta      text not null,
    fecha_liberacion  text,
    usuario_libera    text,
    equipo_libera     text,
    motivo_liberacion text,
    creado            timestamptz not null default now()
);
create index if not exists liberaciones_propuesta on venta.liberaciones (id_propuesta);
"""

PERMISOS = """
revoke all on schema venta from public;
grant usage on schema venta to venta_app;
grant select on venta.bases to venta_app;
grant select, insert on venta.apartados, venta.liberaciones to venta_app;
grant usage, select on all sequences in schema venta to venta_app;
"""

COLS_AP = {
    "IdPropuesta": "id_propuesta", "FechaPropuesta": "fecha_propuesta",
    "UsuarioWindows": "usuario_windows", "EquipoWindows": "equipo_windows",
    "TipoVenta": "tipo_venta", "TipoCartera": "tipo_cartera", "vReference": "vreference",
    "vGroupId": "vgroupid", "nPendingK": "npendingk", "CapitalObjetivo": "capital_objetivo",
    "CapitalSeleccionado": "capital_seleccionado", "CentavosPorPeso": "centavos_por_peso",
    "ValorVenta": "valor_venta", "DiasPromedioMora": "dias_promedio_mora",
    "ArchivoFunnel": "archivo_funnel",
}
COLS_LIB = {
    "IdPropuesta": "id_propuesta", "FechaLiberacion": "fecha_liberacion",
    "UsuarioLibera": "usuario_libera", "EquipoLibera": "equipo_libera",
    "MotivoLiberacion": "motivo_liberacion",
}


def preguntar(texto, defecto=""):
    r = input(f"{texto} [{defecto}]: ").strip() if defecto else input(f"{texto}: ").strip()
    return r or defecto


def conectar(host, port, user, password):
    return psycopg2.connect(host=host, port=port, dbname="postgres", user=user, password=password,
                            sslmode=os.environ.get("VC_SSLMODE", "require"), connect_timeout=15,
                            application_name="VentaCartera-Config")


def leer_csvs(carpeta, columnas):
    partes = []
    for ruta in sorted(glob.glob(os.path.join(carpeta, "*.csv"))):
        for enc in ("utf-8-sig", "latin-1"):
            try:
                df = pd.read_csv(ruta, dtype=str, keep_default_na=False, encoding=enc)
                break
            except Exception:
                df = None
        if df is None:
            print(f"   ! No se pudo leer {os.path.basename(ruta)}")
            continue
        for c in columnas:
            if c not in df.columns:
                df[c] = ""
        partes.append(df[columnas])
    return pd.concat(partes, ignore_index=True) if partes else pd.DataFrame(columns=columnas)


def insertar(cur, tabla, mapa, df):
    if df.empty:
        return 0
    filas = [tuple((str(v) if str(v) != "" else None) for v in r)
             for r in df[list(mapa)].itertuples(index=False, name=None)]
    execute_values(cur, f"insert into venta.{tabla} ({', '.join(mapa.values())}) values %s", filas, page_size=1000)
    return len(filas)


def main():
    print("=" * 62)
    print(" VENTA DE CARTERA v10 · CONFIGURAR SUPABASE")
    print("=" * 62)

    host = os.environ.get("VC_HOST") or preguntar(
        "Host (si falla el directo, usa el de 'Session pooler' en Supabase > Connect)", HOST_DIRECTO)
    port = int(os.environ.get("VC_PORT") or preguntar("Puerto", "5432"))
    es_pooler = "pooler.supabase.com" in host
    sufijo = f".{PROYECTO}" if es_pooler else ""
    user_admin = os.environ.get("VC_ADMIN_USER") or f"postgres{sufijo}"
    clave_admin = os.environ.get("VC_ADMIN_PASS") or getpass.getpass("Contraseña de postgres (no se muestra): ")

    print("\n1) Conectando como postgres…")
    try:
        con = conectar(host, port, user_admin, clave_admin)
    except Exception as exc:
        print(f"\n   ERROR: {exc}")
        if not es_pooler:
            print("\n   El host directo de Supabase sólo responde por IPv6 y muchas redes de oficina no lo tienen.")
            print("   En Supabase: botón Connect > Session pooler. Copia el host (aws-…pooler.supabase.com)")
            print("   y vuelve a correr este script usando ese host y puerto 5432.")
        sys.exit(1)
    con.autocommit = False
    cur = con.cursor()
    cur.execute("select version()")
    print("   OK:", cur.fetchone()[0].split(",")[0])

    print("2) Creando esquema y tablas…")
    cur.execute(DDL)

    print("3) Usuario limitado venta_app…")
    clave_app = os.environ.get("VC_APP_PASS") or "".join(
        secrets.choice(string.ascii_letters + string.digits) for _ in range(28))
    cur.execute("select 1 from pg_roles where rolname = 'venta_app'")
    if cur.fetchone():
        cur.execute("alter role venta_app with login password %s", (clave_app,))
    else:
        cur.execute("create role venta_app with login password %s", (clave_app,))
    cur.execute(PERMISOS)
    for rol in ("anon", "authenticated"):
        cur.execute("select 1 from pg_roles where rolname = %s", (rol,))
        if cur.fetchone():
            cur.execute(f"revoke all on all tables in schema venta from {rol}")
            cur.execute(f"revoke all on schema venta from {rol}")
    con.commit()

    print("4) Subiendo bases…")
    for nombre in ("JyP", "Grupal"):
        ruta = buscar(f"Base {nombre}.csv")
        if not os.path.exists(ruta):
            print(f"   ! No encontré {os.path.basename(ruta)}; súbela después desde la app (Bitácora > Subir bases).")
            continue
        with open(ruta, "rb") as f:
            crudo = f.read()
        comp = gzip.compress(crudo, compresslevel=6)
        cur.execute("update venta.bases set vigente = false where nombre = %s and vigente", (nombre,))
        cur.execute(
            "insert into venta.bases (nombre, contenido, archivo, filas, bytes, usuario)"
            " values (%s, %s, %s, %s, %s, %s) returning id",
            (nombre, psycopg2.Binary(comp), os.path.basename(ruta), crudo.count(b"\n") - 1, len(crudo),
             os.environ.get("USERNAME") or getpass.getuser()))
        print(f"   Base {nombre}: versión {cur.fetchone()[0]} · {len(crudo)/1e6:.1f} MB → {len(comp)/1e6:.1f} MB comprimido")
        # sólo se guardan las 3 versiones más recientes de cada base
        cur.execute("delete from venta.bases where nombre = %s and id not in "
                    "(select id from venta.bases where nombre = %s order by id desc limit 3)", (nombre, nombre))
    con.commit()

    cur.execute("select (select count(*) from venta.apartados), (select count(*) from venta.liberaciones)")
    n_a, n_l = cur.fetchone()
    if n_a or n_l:
        reiniciar = os.environ.get("VC_REINICIAR") or preguntar(
            f"Supabase ya tiene {n_a:,} apartados y {n_l:,} liberaciones. ¿Borrarlos y volver a copiar "
            "los de la carpeta productiva? (s = sí, para pruebas o para salir a producción / n = conservar)", "n")
        if reiniciar.strip().lower().startswith("s"):
            cur.execute("truncate venta.apartados, venta.liberaciones restart identity")
            con.commit()
            print("   Apartados y liberaciones de Supabase borrados.")

    print("5) Pasando apartados y liberaciones de las carpetas…")
    ap = leer_csvs(buscar("Apartados"), list(COLS_AP))
    lib_extra = []
    # Propuestas hechas con EXE v7/v8 (Bitacora_Propuestas.csv + Propuestas_Registradas\<id>.csv)
    bit_v8 = buscar("Bitacora_Propuestas.csv")
    if os.path.exists(bit_v8):
        try:
            bit = pd.read_csv(bit_v8, dtype=str, keep_default_na=False, encoding="utf-8-sig")
        except Exception:
            bit = pd.DataFrame()
        extra = []
        for _, b in bit.iterrows():
            pid = str(b.get("IdPropuesta", "")).strip()
            det_ruta = os.path.join(buscar("Propuestas_Registradas"), f"{pid}.csv")
            if not pid or pid in set(ap.IdPropuesta) or not os.path.exists(det_ruta):
                continue
            det = None
            for enc in ("latin-1", "utf-8-sig"):
                try:
                    det = pd.read_csv(det_ruta, dtype=str, keep_default_na=False, encoding=enc)
                    break
                except Exception:
                    pass
            if det is None or det.empty:
                continue
            reg = pd.DataFrame({
                "TipoCartera": det.get("TipoCartera", ""), "vReference": det.get("vReference", ""),
                "vGroupId": det.get("vGroupId", ""), "nPendingK": det.get("nPendingK", ""),
            })
            for col in ("IdPropuesta", "FechaPropuesta", "UsuarioWindows", "EquipoWindows", "TipoVenta",
                        "CapitalObjetivo", "CapitalSeleccionado", "CentavosPorPeso", "ValorVenta",
                        "DiasPromedioMora", "ArchivoFunnel"):
                reg[col] = b.get(col, "")
            reg["IdPropuesta"] = pid
            extra.append(reg[list(COLS_AP)])
            if str(b.get("EstatusPropuesta", "")).upper() == "LIBERADA":
                lib_extra.append({"IdPropuesta": pid, "FechaLiberacion": b.get("FechaLiberacion", ""),
                                  "UsuarioLibera": b.get("UsuarioLibera", ""), "EquipoLibera": "",
                                  "MotivoLiberacion": b.get("MotivoLiberacion", "")})
        if extra:
            ap = pd.concat([ap] + extra, ignore_index=True)
            print(f"   + {len(extra)} propuesta(s) hechas con el EXE v7/v8 (Bitacora_Propuestas.csv)")
    lib = leer_csvs(buscar("Liberaciones"), list(COLS_LIB))
    if lib_extra:
        lib = pd.concat([lib, pd.DataFrame(lib_extra)[list(COLS_LIB)]], ignore_index=True)
    cur.execute("select distinct id_propuesta from venta.apartados")
    ya = {r[0] for r in cur.fetchall()}
    ap = ap[(ap.IdPropuesta != "") & ~ap.IdPropuesta.isin(ya)]
    # una propuesta pudo quedar repetida en dos archivos (p. ej. copia de OneDrive)
    ap = ap.drop_duplicates()
    cur.execute("select id_propuesta, fecha_liberacion from venta.liberaciones")
    ya_l = set(cur.fetchall())
    lib = lib[(lib.IdPropuesta != "")]
    lib = lib[~lib.apply(lambda r: (r.IdPropuesta, r.FechaLiberacion or None) in ya_l, axis=1)] if len(lib) else lib
    n_ap = insertar(cur, "apartados", COLS_AP, ap)
    n_lib = insertar(cur, "liberaciones", COLS_LIB, lib.drop_duplicates())
    con.commit()
    print(f"   Apartados: {n_ap:,} renglones de {ap.IdPropuesta.nunique():,} propuestas · Liberaciones: {n_lib:,}")
    print("   (Las carpetas Apartados y Liberaciones quedan como respaldo; la app v10 ya no las usa.)")

    print("6) Probando venta_app…")
    user_app = f"venta_app{sufijo}"
    try:
        c2 = conectar(host, port, user_app, clave_app)
        k = c2.cursor()
        k.execute("select nombre, id from venta.bases where vigente")
        print("   Bases visibles:", k.fetchall())
        k.execute("select count(*) from venta.apartados")
        print("   Apartados visibles:", k.fetchone()[0])
        try:
            k.execute("delete from venta.apartados where false")
            print("   ! ATENCIÓN: venta_app puede borrar (no debería).")
        except psycopg2.Error:
            print("   OK: venta_app no puede borrar ni modificar.")
        c2.close()
    except Exception as exc:
        print(f"   ERROR al entrar con venta_app: {exc}")
        print("   Si usas el pooler, a veces tarda un minuto en reconocer usuarios nuevos; vuelve a correr el script.")
        sys.exit(1)

    cp = configparser.ConfigParser()
    cp["supabase"] = {"host": host, "port": str(port), "database": "postgres",
                      "user": user_app, "password": clave_app,
                      "sslmode": os.environ.get("VC_SSLMODE", "require")}
    ruta_ini = os.path.join(APP_DIR, "conexion_supabase.ini")
    with open(ruta_ini, "w", encoding="utf-8") as f:
        f.write("; Conexión de Venta de Cartera v10 (usuario limitado venta_app).\n"
                "; Si borras este archivo la app vuelve al modo carpeta.\n")
        cp.write(f)
    print(f"\nLISTO. Se creó {ruta_ini}")
    print("Abre la app: en el encabezado debe decir '☁ Supabase'.")
    con.close()


if __name__ == "__main__":
    main()
    if not os.environ.get("VC_HOST"):
        input("\nPresiona Enter para cerrar…")
