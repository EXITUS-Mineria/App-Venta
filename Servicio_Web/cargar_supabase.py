# -*- coding: utf-8 -*-
"""
Venta de Cartera · Servicio Web · Carga a Supabase (lo corre el administrador)

Hace, en este orden (cada paso es opcional y se pregunta):
 1. Aplica el SQL del núcleo y de todos los módulos (supabase/00_nucleo.sql + supabase/modulos/*.sql).
 2. Sube Base JyP.csv y Base Grupal.csv (reemplaza la cartera; los apartados se conservan).
 3. Migra las propuestas de la app de escritorio (carpetas Apartados/ y Liberaciones/).
 4. Da rol de administrador a un correo.

Uso:
    py cargar_supabase.py                          (pregunta todo)
    py cargar_supabase.py --carpeta "C:\\...\\Venta_Cartera_EXE_Kit_v2" --solo-bases

Conexión: host del "Session pooler" de Supabase (Connect > Session pooler), puerto 5432,
usuario postgres.<proyecto> y la contraseña de la base de datos. No se guarda en ningún lado.
"""

import argparse
import csv
import getpass
import glob
import io
import json
import os
import sys
from datetime import datetime

import pandas as pd

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    print("Falta psycopg2:  py -m pip install psycopg2-binary pandas")
    sys.exit(1)

AQUI = os.path.dirname(os.path.abspath(__file__))
PROYECTO = "vwlfxkaxiduvolbvdmmg"

COLS_COLONIA = {"COLONIA", "VCOLONIA", "COLONIACLIENTE", "VCOLONY", "ASENTAMIENTO", "VASENTAMIENTO"}
COLS_MORA = ("iDays", "Diasatraso_hoy", "dias hoy")


# ------------------------------------------------------------------ utilidades
def preguntar(texto, defecto=""):
    r = input(f"{texto}" + (f" [{defecto}]" if defecto else "") + ": ").strip()
    return r or defecto


def si(texto, defecto="s"):
    return preguntar(texto + " (s/n)", defecto).lower().startswith("s")


def leer_csv(ruta):
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(ruta, dtype=str, keep_default_na=False, encoding=enc, low_memory=False)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"No se pudo leer {ruta}")


def num(v):
    try:
        return float(str(v).replace("$", "").replace(",", "").strip())
    except ValueError:
        return None


def columna(df, *nombres):
    for n in nombres:
        if n in df.columns:
            return n
    return None


def preparar(df, grupal):
    req = ["vReference", "Estado", "Municipio", "nPendingK", "Estatus"] + (["vGroupId"] if grupal else [])
    falt = [c for c in req if c not in df.columns]
    if falt:
        raise ValueError("Faltan columnas: " + ", ".join(falt))
    c_col = next((c for c in df.columns if c.upper().replace(" ", "").replace("_", "") in COLS_COLONIA), None)
    c_mora = columna(df, *COLS_MORA)
    out = pd.DataFrame({
        "vreference": df["vReference"].str.strip(),
        "estado": df["Estado"].str.strip(),
        "municipio": df["Municipio"].str.strip(),
        "colonia": df[c_col].str.strip() if c_col else "",
        "dias": df[c_mora].map(num) if c_mora else None,
        "npendingk": df["nPendingK"].map(num).fillna(0.0),
        "estatus_base": df["Estatus"].str.strip(),
    })
    if grupal:
        out.insert(0, "vgroupid", df["vGroupId"].str.strip())
    out["datos"] = [json.dumps(r, ensure_ascii=False) for r in df.to_dict(orient="records")]
    return out


def copiar(cur, tabla, df, columnas):
    buf = io.StringIO()
    w = csv.writer(buf)
    for fila in df[columnas].itertuples(index=False, name=None):
        w.writerow(["" if (v is None or (isinstance(v, float) and pd.isna(v))) else v for v in fila])
    buf.seek(0)
    cur.copy_expert(
        f"copy public.{tabla} ({', '.join(columnas)}) from stdin with (format csv, null '')", buf)


# ------------------------------------------------------------------ pasos
def aplicar_sql(con):
    archivos = [os.path.join(AQUI, "supabase", "00_nucleo.sql")] + sorted(
        glob.glob(os.path.join(AQUI, "supabase", "modulos", "*.sql")))
    cur = con.cursor()
    for ruta in archivos:
        cur.execute(open(ruta, encoding="utf-8").read())
        print("   ✔", os.path.relpath(ruta, AQUI))
    con.commit()


def cargar_bases(con, carpeta, usuario):
    """Sube Base JyP.csv / Base Grupal.csv a las tablas BASE_JYP / BASE_GRUPAL (una sola copia)
    y arma la cartera de búsqueda con public.cargar_cartera_desde_tablas()."""
    cur = con.cursor()
    requeridas = {
        "JyP": ["vReference", "Estado", "Municipio", "iDays", "nPendingK", "Estatus"],
        "Grupal": ["vGroupId", "vReference", "iCredId", "Estado", "Municipio", "Diasatraso_hoy", "dias hoy", "nPendingK", "Estatus"],
    }
    subidas = 0
    for cartera in ("JyP", "Grupal"):
        ruta = os.path.join(carpeta, f"Base {cartera}.csv")
        if not os.path.exists(ruta):
            print(f"   ! No encontré {ruta}; se conserva BASE_{cartera.upper()} actual.")
            continue
        df = leer_csv(ruta)
        faltan = [c for c in ("vReference", "Estado", "Municipio", "nPendingK", "Estatus") + (("vGroupId",) if cartera == "Grupal" else ())
                  if c not in df.columns]
        if faltan:
            raise ValueError(f"{os.path.basename(ruta)}: faltan columnas {', '.join(faltan)}")
        c_mora = columna(df, *COLS_MORA)
        for c in requeridas[cartera]:
            if c not in df.columns:
                df[c] = df[c_mora] if (c_mora and c in ("iDays", "Diasatraso_hoy")) else ""
        disp = int((df["Estatus"].str.strip().str.upper() == "DISPONIBLE").sum())
        tabla = f"BASE_{cartera.upper()}"
        columnas = list(df.columns)
        cur.execute(f'drop table if exists public."{tabla}"')
        cur.execute(f'create table public."{tabla}" (' + ", ".join(f'"{c}" text' for c in columnas) + ")")
        cur.execute(f'alter table public."{tabla}" enable row level security')
        cur.execute(f'revoke all on public."{tabla}" from anon, authenticated')
        buf = io.StringIO()
        df.to_csv(buf, index=False, header=False)
        buf.seek(0)
        cur.copy_expert(f'copy public."{tabla}" (' + ", ".join(f'"{c}"' for c in columnas) + ") from stdin with (format csv)", buf)
        subidas += 1
        print(f"   ✔ {tabla}: {len(df):,} filas · {disp:,} Disponible" + ("" if disp else " · ¡NINGÚN registro Disponible!"))
    if subidas:
        cur.execute("select public.cargar_cartera_desde_tablas()")
        r = cur.fetchone()[0]
        print(f"   ✔ Cartera de búsqueda: JyP {r['jyp']:,} · Grupal {r['grupal']:,}")
    con.commit()


def migrar_apartados(con, carpeta):
    """Propuestas de la app de escritorio (v9) -> tablas web. La más antigua gana; las demás EN CONFLICTO."""
    def leer_carpeta(nombre):
        partes = []
        for ruta in sorted(glob.glob(os.path.join(carpeta, nombre, "*.csv"))):
            try:
                partes.append(leer_csv(ruta))
            except Exception:
                print("   ! no se pudo leer", os.path.basename(ruta))
        return pd.concat(partes, ignore_index=True) if partes else pd.DataFrame()

    ap = leer_carpeta("Apartados")
    lib = leer_carpeta("Liberaciones")
    if ap.empty:
        print("   No hay carpeta Apartados con propuestas.")
        return
    cur = con.cursor()
    cur.execute("select id_propuesta from public.propuestas")
    ya = {r[0] for r in cur.fetchall()}
    cur.execute("select clave, id_propuesta from public.apartados_activos")
    duenos = dict(cur.fetchall())

    liberadas = {}
    if not lib.empty:
        for _, r in lib.sort_values("FechaLiberacion").iterrows():
            liberadas.setdefault(r["IdPropuesta"], r)

    cab = ap.groupby("IdPropuesta", sort=False).first().reset_index().sort_values(["FechaPropuesta", "IdPropuesta"])
    n_nuevas = n_conf = n_lib = 0
    for _, c in cab.iterrows():
        pid = c["IdPropuesta"]
        if pid in ya:
            continue
        det = ap[ap.IdPropuesta == pid].drop_duplicates(["TipoCartera", "vReference", "vGroupId"])
        tipo = det.TipoCartera.str.strip()
        refs = [r for r in det.loc[tipo == "JyP", "vReference"].str.strip().unique() if r]
        grupos = [g for g in det.loc[tipo == "Grupal", "vGroupId"].str.strip().unique() if g]
        claves = [f"J:{r}" for r in refs] + [f"G:{g}" for g in grupos]

        fecha = str(c["FechaPropuesta"]).strip()[:19] or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        estatus, conflicto, l = "APARTADA", None, liberadas.get(pid)
        if l is not None:
            estatus = "LIBERADA"
        else:
            choques = [f"{k[2:]} ({duenos[k]})" for k in claves if k in duenos]
            if choques:
                estatus, conflicto = "EN CONFLICTO", "Ya apartados antes en: " + ", ".join(choques[:10])

        cur.execute(
            """insert into public.propuestas (id_propuesta, fecha, usuario, tipo_venta, capital_objetivo, capital,
                   centavos, valor_venta, dias_mora, estatus, conflicto, origen, liberada_en, liberada_por, motivo)
               values (%s, (%s::timestamp at time zone 'America/Mexico_City'), %s, %s, %s, %s, %s, %s, %s, %s, %s,
                       'app escritorio', %s, %s, %s)""",
            (pid, fecha, c["UsuarioWindows"], c["TipoVenta"], num(c["CapitalObjetivo"]),
             num(c["CapitalSeleccionado"]), num(c["CentavosPorPeso"]), num(c["ValorVenta"]),
             num(c["DiasPromedioMora"]), estatus, conflicto,
             (str(l["FechaLiberacion"])[:19] or None) if l is not None else None,
             l["UsuarioLibera"] if l is not None else None, l["MotivoLiberacion"] if l is not None else None))
        # detalle con la fila actual de la base (si existe)
        cur.execute(
            """insert into public.propuesta_detalle (id_propuesta, tipo_cartera, vreference, vgroupid, npendingk, datos)
               select %s, 'JyP', j.vreference, null, j.npendingk, j.datos from public.cartera_jyp j where j.vreference = any(%s)
               union all
               select %s, 'Grupal', g.vreference, g.vgroupid, g.npendingk, g.datos from public.cartera_grupal g where g.vgroupid = any(%s)""",
            (pid, refs, pid, grupos))
        if estatus != "LIBERADA":
            nuevas = [(k, pid) for k in claves if k not in duenos]
            if nuevas:
                execute_values(cur, "insert into public.apartados_activos (clave, id_propuesta) values %s", nuevas)
            for k, _ in nuevas:
                duenos[k] = pid
        n_nuevas += 1
        n_conf += estatus == "EN CONFLICTO"
        n_lib += estatus == "LIBERADA"
    con.commit()
    print(f"   ✔ {n_nuevas} propuestas migradas · {n_conf} EN CONFLICTO · {n_lib} liberadas")


def dar_admin(con, correo):
    cur = con.cursor()
    cur.execute("update public.perfiles set rol = 'admin', activo = true where lower(email) = lower(%s) returning email", (correo,))
    r = cur.fetchone()
    con.commit()
    if r:
        print(f"   ✔ {r[0]} ahora es administrador")
    else:
        print(f"   ! {correo} no existe todavía. Créalo en Supabase > Authentication > Users > Add user y repite.")


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("VC_HOST"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("VC_PORT", "5432")))
    ap.add_argument("--user", default=os.environ.get("VC_USER"))
    ap.add_argument("--password", default=os.environ.get("VC_PASS"))
    ap.add_argument("--db", default=os.environ.get("VC_DB", "postgres"))
    ap.add_argument("--sslmode", default=os.environ.get("VC_SSLMODE", "require"))
    ap.add_argument("--carpeta", default=os.environ.get("VC_CARPETA"),
                    help="Carpeta con Base JyP.csv, Base Grupal.csv y Apartados/")
    ap.add_argument("--sql", action="store_true", help="sólo aplicar SQL")
    ap.add_argument("--solo-bases", action="store_true", help="sólo subir bases")
    ap.add_argument("--migrar", action="store_true", help="migrar apartados sin preguntar")
    ap.add_argument("--admin", help="correo a convertir en administrador")
    ap.add_argument("--todo", action="store_true", help="hacer todo sin preguntar")
    a = ap.parse_args()

    print("=" * 64)
    print(" VENTA DE CARTERA · SERVICIO WEB · CARGA A SUPABASE")
    print("=" * 64)
    host = a.host or preguntar("Host (Session pooler)", "aws-0-us-east-1.pooler.supabase.com")
    user = a.user or preguntar("Usuario", f"postgres.{PROYECTO}" if "pooler" in host else "postgres")
    clave = a.password or getpass.getpass("Contraseña de la base (no se muestra): ")
    carpeta = a.carpeta or preguntar("Carpeta de las bases", os.path.dirname(AQUI))

    try:
        con = psycopg2.connect(host=host, port=a.port, dbname=a.db, user=user, password=clave,
                               sslmode=a.sslmode, connect_timeout=20, application_name="VentaCartera-Carga")
    except Exception as exc:
        print("\nERROR de conexión:", exc)
        print("Usa el host y usuario de Supabase > Connect > Session pooler (puerto 5432).")
        sys.exit(1)
    usuario = os.environ.get("USERNAME") or getpass.getuser()
    interactivo = not (a.todo or a.sql or a.solo_bases or a.migrar or a.admin)

    if a.todo or a.sql or (interactivo and si("1) ¿Aplicar/actualizar el SQL de núcleo y módulos?")):
        print("1) SQL"); aplicar_sql(con)
    if a.todo or a.solo_bases or (interactivo and si("2) ¿Subir Base JyP.csv y Base Grupal.csv?")):
        print("2) Bases"); cargar_bases(con, carpeta, usuario)
    if a.todo or a.migrar or (interactivo and si("3) ¿Migrar propuestas de la app de escritorio (Apartados/)?", "n")):
        print("3) Migración"); migrar_apartados(con, carpeta)
    correo = a.admin or (preguntar("4) Correo a hacer administrador (Enter = ninguno)") if interactivo else "")
    if correo:
        print("4) Administrador"); dar_admin(con, correo)
    con.close()
    print("\nLISTO.")


if __name__ == "__main__":
    main()
    if sys.stdin.isatty() and len(sys.argv) == 1:
        input("\nPresiona Enter para cerrar…")
