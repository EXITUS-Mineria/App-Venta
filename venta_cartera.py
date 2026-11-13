# MODO PORTABLE: los CSV deben permanecer junto a la aplicacion.
# -*- coding: utf-8 -*-
"""
Venta de Cartera - Aplicación local v9

Funciones (se conserva todo lo de v1-v6):
- Usa automáticamente el usuario de Windows.
- Carteras: JyP, Grupal o Dual.
- Filtro dinámico Estado -> Municipios.
- Selección de créditos JyP y de grupos Grupal (sólo grupos 100% disponibles).
- Capital objetivo con rango -$1,000 / +$2,000.
- Validación final antes de apartar.
- Exportación CSV en Latin-1 para Funnel.
- Estatus = Propuesta/Venta para lo apartado.

Nuevo en v9:
- Seguro para carpeta compartida de OneDrive: las bases ya no se modifican;
  cada apartado/liberación es un archivo nuevo en las carpetas Apartados / Liberaciones.
- Detección de propuestas EN CONFLICTO (gana la más antigua).
- Revisión automática cada minuto de los apartados de otros usuarios.
- Rol Administrador / Vendedor; letra más grande con A- / A+.

Nuevo en v8:
- Tema Ejecutivo Exitus Credit (mismo JSON/fuentes de los dashboards).
- KPIs de disponibles, capital (cuánto falta/excede), venta, mora y partidas.
- Filtro de rango de días de mora.
- Búsqueda de municipios y de vReference / Grupo (una o varias).

Nuevo en v7:
- Sugerir propuesta: arma automáticamente una selección dentro del rango.
- Bitácora de propuestas + liberar propuestas (regresan a Disponible).
- Copia automática de cada propuesta en "Propuestas_Registradas".
- Diagnóstico de bases al abrir y botón Recargar bases.
- Selección rápida aun con miles de grupos.
"""

import os
import sys
import time
import json
import socket
import getpass
import uuid
import bisect
import hashlib
from datetime import datetime
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk, messagebox, filedialog, simpledialog

import pandas as pd


# ============================================================
# CONFIGURACIÓN
# ============================================================

APP_VERSION = "v9"
APP_TITLE = f"Venta de Cartera {APP_VERSION}"

RANGO_ABAJO = 1000
RANGO_ARRIBA = 2000

ESTATUS_DISPONIBLE = "Disponible"
ESTATUS_APARTADO = "Propuesta/Venta"

# Bloqueo multiusuario
BLOQUEO_ESPERA_SEG = 20      # cuánto espera un usuario si otro está apartando
BLOQUEO_CADUCIDAD_SEG = 300  # un bloqueo más viejo que esto se considera abandonado

# Columnas alternas de días de mora cuando la base no trae iDays
COLUMNAS_MORA_ALTERNAS = ("Diasatraso_hoy", "dias hoy")

# Nombres aceptados para la columna de colonia en las bases (sin espacios ni "_").
COLUMNAS_COLONIA = {"COLONIA", "VCOLONIA", "COLONIACLIENTE", "VCOLONY", "ASENTAMIENTO", "VASENTAMIENTO"}

PRIORIDADES = (
    "Mayor mora primero",
    "Menor mora primero",
    "Mayor capital primero",
    "Menor capital primero",
)

if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

BASE_JYP = os.path.join(APP_DIR, "Base JyP.csv")
BASE_GRUPAL = os.path.join(APP_DIR, "Base Grupal.csv")
DIR_REGISTRADAS = os.path.join(APP_DIR, "Propuestas_Registradas")
DIR_APARTADOS = os.path.join(APP_DIR, "Apartados")
DIR_LIBERACIONES = os.path.join(APP_DIR, "Liberaciones")
ARCHIVO_ADMINS = os.path.join(APP_DIR, "administradores.txt")
BITACORA_V8 = os.path.join(APP_DIR, "Bitacora_Propuestas.csv")  # versiones 7 y 8

# Usuarios de Windows que pueden liberar propuestas de cualquier vendedor.
# Se pueden agregar más en administradores.txt (uno por renglón).
ADMINISTRADORES = {"DANIELPALMAHERNÁNDEZ", "DANIELPALMAHERNANDEZ"}

# Cada cuántos segundos revisa si otro usuario apartó o liberó algo.
REVISION_SEG = 60

COLUMNAS_APARTADO = [
    "IdPropuesta", "FechaPropuesta", "UsuarioWindows", "EquipoWindows", "TipoVenta",
    "TipoCartera", "vReference", "vGroupId", "nPendingK",
    "CapitalObjetivo", "CapitalSeleccionado", "CentavosPorPeso", "ValorVenta",
    "DiasPromedioMora", "ArchivoFunnel",
]
COLUMNAS_LIBERACION = ["IdPropuesta", "FechaLiberacion", "UsuarioLibera", "EquipoLibera", "MotivoLiberacion"]


# ============================================================
# UTILIDADES
# ============================================================

def normalizar_texto(valor):
    if pd.isna(valor):
        return ""
    return " ".join(str(valor).strip().upper().split())


def convertir_capital(valor):
    if pd.isna(valor):
        return 0.0
    texto = str(valor).strip().replace("$", "").replace(",", "")
    try:
        return float(texto)
    except Exception:
        return 0.0


def _leer_con_encodings(ruta, **kwargs):
    if not os.path.exists(ruta):
        raise FileNotFoundError(f"No se encontró el archivo:\n{ruta}")

    ultimo_error = None
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            df = pd.read_csv(ruta, encoding=encoding, low_memory=False, **kwargs)
            return df, encoding
        except Exception as exc:
            ultimo_error = exc

    raise ValueError(f"No fue posible leer {ruta}: {ultimo_error}")


def cargar_csv(ruta):
    """Lectura para análisis (tipos numéricos)."""
    df, _ = _leer_con_encodings(ruta)
    return df


def cargar_csv_crudo(ruta):
    """
    Lectura para MODIFICAR la base: todo como texto, sin convertir vacíos,
    para que al reescribir el archivo cada celda quede exactamente igual
    (por ejemplo, un CP 42184 no se convierte en 42184.0).
    """
    return _leer_con_encodings(ruta, dtype=str, keep_default_na=False)


def guardar_csv_atomico(df, ruta, encoding="latin-1", intentos=5):
    """
    Escribe a un temporal y reemplaza. Reintenta si el archivo está
    ocupado momentáneamente (OneDrive, antivirus, Excel).
    """
    # Conserva el fin de línea del archivo existente (CRLF de Windows o LF).
    fin_linea = "\r\n"
    try:
        with open(ruta, "rb") as f:
            muestra = f.read(65536)
        if b"\n" in muestra and b"\r\n" not in muestra:
            fin_linea = "\n"
    except OSError:
        pass

    temp = f"{ruta}.{uuid.uuid4().hex[:6]}.tmp"
    df.to_csv(temp, index=False, encoding=encoding, errors="replace", lineterminator=fin_linea)

    ultimo_error = None
    for _ in range(intentos):
        try:
            os.replace(temp, ruta)
            return
        except PermissionError as exc:
            ultimo_error = exc
            time.sleep(1)

    try:
        os.remove(temp)
    except Exception:
        pass
    raise PermissionError(
        f"No se pudo escribir {os.path.basename(ruta)}. "
        f"¿Está abierto en Excel? Detalle: {ultimo_error}"
    )


def preparar_base(df, es_grupal=False):
    df = df.copy()

    requeridas = ["vReference", "Estado", "Municipio", "nPendingK", "Estatus"]
    if es_grupal:
        requeridas.append("vGroupId")

    faltantes = [c for c in requeridas if c not in df.columns]
    if faltantes:
        raise ValueError(
            "Faltan columnas requeridas: " + ", ".join(faltantes)
        )

    for col in ["vReference", "Estado", "Municipio", "Estatus"]:
        df[col] = df[col].fillna("").astype(str)

    if es_grupal:
        df["vGroupId"] = df["vGroupId"].fillna("").astype(str).str.strip()

    df["vReference"] = df["vReference"].str.strip()
    df["nPendingK"] = df["nPendingK"].apply(convertir_capital)

    # Días de mora. iDays sigue siendo la columna principal; si la base
    # no la trae se usa la primera columna alterna disponible.
    origen_mora = None
    if "iDays" in df.columns:
        origen_mora = "iDays"
    else:
        for alt in COLUMNAS_MORA_ALTERNAS:
            if alt in df.columns:
                origen_mora = alt
                break

    if origen_mora:
        df["iDays"] = pd.to_numeric(
            df[origen_mora].astype(str).str.replace(",", "", regex=False),
            errors="coerce"
        )
    else:
        df["iDays"] = pd.NA

    df["_Estado"] = df["Estado"].map(normalizar_texto)
    df["_Municipio"] = df["Municipio"].map(normalizar_texto)

    # Colonia: se toma la primera columna que exista con alguno de estos nombres.
    col_colonia = next(
        (c for c in df.columns if normalizar_texto(c).replace(" ", "").replace("_", "") in COLUMNAS_COLONIA),
        None
    )
    df["_Colonia"] = (
        df[col_colonia].fillna("").astype(str).str.strip() if col_colonia else ""
    )
    df["_Estatus"] = df["Estatus"].map(normalizar_texto)

    return df


def estados_de(df):
    return sorted(
        x for x in df["_Estado"].dropna().unique().tolist()
        if x
    )


def municipios_de(df, estados):
    if not estados:
        return []
    filtrado = df[df["_Estado"].isin(estados)]
    return sorted(
        x for x in filtrado["_Municipio"].dropna().unique().tolist()
        if x
    )


def capital_mostrado(valor):
    return f"${valor:,.2f}"


def promedio_mora(df):
    """Promedio simple de iDays, ignorando valores vacíos."""
    if df is None or df.empty or "iDays" not in df.columns:
        return None
    valores = pd.to_numeric(df["iDays"], errors="coerce").dropna()
    if valores.empty:
        return None
    return float(valores.mean())


def mora_mostrada(valor):
    if valor is None or pd.isna(valor):
        return "N/D"
    return f"{valor:.1f} días"


def diagnosticar_bases(df_jyp, df_grupal):
    """Avisos de calidad de datos que afectan la venta."""
    avisos = []

    for nombre, df in (("Base JyP", df_jyp), ("Base Grupal", df_grupal)):
        total = len(df)
        disp = int((df["_Estatus"] == "DISPONIBLE").sum())
        if total and disp == 0:
            valores = df["Estatus"].value_counts().head(3)
            ejemplo = ", ".join(f"'{k}' ({v:,})" for k, v in valores.items())
            avisos.append(
                f"{nombre}: ningún registro tiene Estatus = Disponible, "
                f"por eso no aparecerá nada para vender. Valores encontrados: {ejemplo}."
            )
        vacios = int((df["_Estatus"] == "").sum())
        if vacios:
            avisos.append(f"{nombre}: {vacios:,} registros con Estatus vacío (no se pueden vender).")

    sin_colonia = [n for n, df in (("Base JyP", df_jyp), ("Base Grupal", df_grupal))
                   if not (df["_Colonia"] != "").any()]
    if sin_colonia:
        avisos.append(
            " y ".join(sin_colonia) + ": no trae columna Colonia; la tabla la mostrará vacía. "
            "Agrega una columna llamada Colonia a la base."
        )

    cols_clave = [c for c in ("vGroupId", "vReference", "iCredId") if c in df_grupal.columns]
    dup = int(df_grupal.duplicated(subset=cols_clave).sum())
    if dup:
        avisos.append(
            f"Base Grupal: {dup:,} filas repetidas ({' + '.join(cols_clave)}). "
            "Inflan el capital y los integrantes del grupo."
        )

    dup_j = int(df_jyp["vReference"].duplicated().sum())
    if dup_j:
        avisos.append(f"Base JyP: {dup_j:,} vReference repetidas.")

    return avisos


# ============================================================
# OPERACIONES
# ============================================================

def ids_de_seleccion(seleccion):
    """Devuelve (vReference JyP, vGroupId Grupal) de una selección o propuesta."""
    jyp_refs, grupos = [], []
    if seleccion is None or seleccion.empty or "TipoCartera" not in seleccion.columns:
        return jyp_refs, grupos

    tipo = seleccion["TipoCartera"].astype(str).str.strip()

    if "vReference" in seleccion.columns:
        jyp_refs = (
            seleccion.loc[tipo == "JyP", "vReference"]
            .astype(str).str.strip().replace("", pd.NA).dropna()
            .unique().tolist()
        )

    if "vGroupId" in seleccion.columns:
        grupos = (
            seleccion.loc[tipo == "Grupal", "vGroupId"]
            .astype(str).str.strip().replace("", pd.NA).dropna()
            .unique().tolist()
        )

    return jyp_refs, grupos


def sugerir_propuesta(candidatos, objetivo, minimo, maximo, prioridad):
    """
    candidatos: DataFrame con columnas iid, Capital, Mora.
    Recorre los candidatos en el orden de prioridad y va sumando mientras
    no se pase del máximo; se detiene al llegar al objetivo.
    Si quedó debajo del mínimo intenta cerrar con el candidato que mejor
    complete el faltante.
    Devuelve (lista_iids, capital_total).
    """
    c = candidatos[candidatos["Capital"] > 0].copy()
    if c.empty:
        return [], 0.0

    c["_mora"] = pd.to_numeric(c["Mora"], errors="coerce")
    if prioridad == "Mayor mora primero":
        c = c.sort_values(["_mora", "Capital"], ascending=[False, False], na_position="last")
    elif prioridad == "Menor mora primero":
        c = c.sort_values(["_mora", "Capital"], ascending=[True, False], na_position="last")
    elif prioridad == "Menor capital primero":
        c = c.sort_values("Capital", ascending=True)
    else:
        c = c.sort_values("Capital", ascending=False)

    elegidos, total = [], 0.0
    for iid, cap in zip(c["iid"], c["Capital"]):
        if total >= objetivo:
            break
        if total + cap <= maximo:
            elegidos.append(iid)
            total += cap

    if total < minimo:
        usados = set(elegidos)
        resto = c[~c["iid"].isin(usados)]
        falta_min, falta_max = minimo - total, maximo - total
        cierre = resto[(resto["Capital"] >= falta_min) & (resto["Capital"] <= falta_max)]
        if not cierre.empty:
            fila = cierre.iloc[0]
            elegidos.append(fila["iid"])
            total += float(fila["Capital"])

    if total < minimo and elegidos:
        # Intercambio: cambia una partida elegida por otra para entrar al rango.
        # Se recorren las elegidas de la menos prioritaria a la más prioritaria.
        cap = dict(zip(c["iid"], c["Capital"]))
        usados = set(elegidos)
        resto = c[~c["iid"].isin(usados)][["iid", "Capital"]].sort_values("Capital")
        caps_resto = resto["Capital"].to_numpy()
        iids_resto = resto["iid"].to_numpy()

        for sale in reversed(elegidos):
            base = total - cap[sale]
            # buscar un candidato con base + x en [minimo, maximo]
            i = bisect.bisect_left(caps_resto, minimo - base)
            if i < len(caps_resto) and base + caps_resto[i] <= maximo:
                elegidos[elegidos.index(sale)] = iids_resto[i]
                total = base + float(caps_resto[i])
                break

    return elegidos, total


# ============================================================
# REGISTRO DE APARTADOS (seguro para carpeta compartida de OneDrive)
# ------------------------------------------------------------
# Las bases NUNCA se modifican. Cada apartado es un archivo nuevo en
# Apartados\ y cada liberación un archivo nuevo en Liberaciones\.
# Nadie edita un archivo que otro usuario pueda estar editando, por eso
# OneDrive no genera copias en conflicto ni se pierde información.
# ============================================================

def es_administrador(usuario):
    admins = set(ADMINISTRADORES)
    try:
        with open(ARCHIVO_ADMINS, "r", encoding="utf-8-sig") as f:
            admins |= {l.strip().upper() for l in f if l.strip()}
    except Exception:
        pass
    return str(usuario).strip().upper() in admins


def _nombre_seguro(texto):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in str(texto))[:40]


def _archivos_csv(carpeta):
    if not os.path.isdir(carpeta):
        return []
    return sorted(
        os.path.join(carpeta, n) for n in os.listdir(carpeta)
        if n.lower().endswith(".csv") and not n.startswith(("~", "."))
    )


def firma_registro():
    """Huella barata de las carpetas: cambia cuando alguien aparta o libera."""
    firma = []
    for carpeta in (DIR_APARTADOS, DIR_LIBERACIONES):
        for ruta in _archivos_csv(carpeta):
            try:
                firma.append((os.path.basename(ruta), os.path.getmtime(ruta)))
            except OSError:
                pass
    return tuple(firma)


def leer_carpeta(carpeta, columnas):
    partes = []
    for ruta in _archivos_csv(carpeta):
        try:
            df, _ = _leer_con_encodings(ruta, dtype=str, keep_default_na=False)
        except Exception:
            continue  # archivo aún sincronizando; se toma en la siguiente revisión
        for c in columnas:
            if c not in df.columns:
                df[c] = ""
        df["_Archivo"] = ruta
        partes.append(df)
    if not partes:
        return pd.DataFrame(columns=columnas + ["_Archivo"])
    return pd.concat(partes, ignore_index=True)


def guardar_registro_nuevo(df, ruta):
    """Escribe un archivo nuevo de una sola vez (temporal + renombrar)."""
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    temp = ruta + ".tmp"
    df.to_csv(temp, index=False, encoding="utf-8-sig")
    os.replace(temp, ruta)


def _a_float(v):
    try:
        return float(str(v).replace(",", ""))
    except Exception:
        return 0.0


def migrar_bitacora_v8():
    """
    Propuestas hechas con v7/v8 (Bitacora_Propuestas.csv + Propuestas_Registradas)
    se pasan una sola vez a Apartados\\ / Liberaciones\\ para verlas y liberarlas en v9.
    """
    if not os.path.exists(BITACORA_V8):
        return 0
    try:
        bit, _ = _leer_con_encodings(BITACORA_V8, dtype=str, keep_default_na=False)
    except Exception:
        return 0
    existentes = set()
    for carpeta in (DIR_APARTADOS,):
        for ruta in _archivos_csv(carpeta):
            existentes.add(os.path.basename(ruta).split("_")[0])

    migradas = 0
    for _, b in bit.iterrows():
        pid = str(b.get("IdPropuesta", "")).strip()
        if not pid or pid in existentes:
            continue
        detalle = os.path.join(DIR_REGISTRADAS, f"{pid}.csv")
        if not os.path.exists(detalle):
            continue
        try:
            det, _ = _leer_con_encodings(detalle, dtype=str, keep_default_na=False)
        except Exception:
            continue
        reg = pd.DataFrame({
            "IdPropuesta": pid,
            "FechaPropuesta": b.get("FechaPropuesta", ""),
            "UsuarioWindows": b.get("UsuarioWindows", ""),
            "EquipoWindows": b.get("EquipoWindows", ""),
            "TipoVenta": b.get("TipoVenta", ""),
            "TipoCartera": det.get("TipoCartera", pd.Series([""] * len(det))).values,
            "vReference": det.get("vReference", pd.Series([""] * len(det))).values,
            "vGroupId": det.get("vGroupId", pd.Series([""] * len(det))).values,
            "nPendingK": det.get("nPendingK", pd.Series([""] * len(det))).values,
            "CapitalObjetivo": b.get("CapitalObjetivo", ""),
            "CapitalSeleccionado": b.get("CapitalSeleccionado", ""),
            "CentavosPorPeso": b.get("CentavosPorPeso", ""),
            "ValorVenta": b.get("ValorVenta", ""),
            "DiasPromedioMora": b.get("DiasPromedioMora", ""),
            "ArchivoFunnel": b.get("ArchivoFunnel", ""),
        })[COLUMNAS_APARTADO]
        try:
            # Nombre fijo: si dos equipos migran a la vez, es la misma propuesta.
            guardar_registro_nuevo(reg, os.path.join(DIR_APARTADOS, f"{pid}_migrado-v8.csv"))
            if str(b.get("EstatusPropuesta", "")).upper() == "LIBERADA":
                lib = pd.DataFrame([{
                    "IdPropuesta": pid,
                    "FechaLiberacion": b.get("FechaLiberacion", ""),
                    "UsuarioLibera": b.get("UsuarioLibera", ""),
                    "EquipoLibera": "",
                    "MotivoLiberacion": b.get("MotivoLiberacion", ""),
                }])[COLUMNAS_LIBERACION]
                guardar_registro_nuevo(lib, os.path.join(DIR_LIBERACIONES, f"LIB-{pid}_migrado-v8.csv"))
            migradas += 1
        except Exception:
            pass
    return migradas


def _columna(df, *nombres):
    """Busca una columna sin importar mayúsculas, espacios o guiones bajos."""
    norm = {normalizar_texto(c).replace(" ", "").replace("_", ""): c for c in df.columns}
    for n in nombres:
        c = norm.get(n.upper().replace(" ", "").replace("_", ""))
        if c is not None:
            return c
    return None


def preparar_importacion(ruta, df_jyp, df_grupal, usuario_importa, ids_existentes=(),
                         apartados_jyp=(), apartados_grupos=()):
    """
    Convierte una propuesta hecha antes de v9 en un registro de Apartados.

    Acepta:
    - El CSV para Funnel de cualquier versión anterior (trae TipoCartera,
      vReference, vGroupId y a veces IdPropuesta, UsuarioWindows, FechaPropuesta).
    - Una lista simple con una columna vReference y/o vGroupId.

    Reglas:
    - vGroupId que exista en Grupal -> se toma el grupo completo.
    - vReference de Grupal -> se toma el grupo completo al que pertenece.
    - vReference de JyP -> crédito JyP.
    Devuelve (registro DataFrame o None, resumen dict).
    """
    datos, _ = _leer_con_encodings(ruta, dtype=str, keep_default_na=False)
    if datos.empty:
        raise ValueError("El archivo no tiene renglones.")

    c_ref = _columna(datos, "vReference", "Referencia", "Ref")
    c_grp = _columna(datos, "vGroupId", "Grupo", "IdGrupo")
    c_tipo = _columna(datos, "TipoCartera")
    if not c_ref and not c_grp:
        raise ValueError("El archivo debe tener una columna vReference y/o vGroupId.")

    c_id = _columna(datos, "IdPropuesta")
    c_usr = _columna(datos, "UsuarioWindows", "Usuario", "Vendedor")
    c_eq = _columna(datos, "EquipoWindows", "Equipo")
    c_fec = _columna(datos, "FechaPropuesta", "Fecha")
    c_obj = _columna(datos, "CapitalObjetivo")
    c_cen = _columna(datos, "CentavosPorPeso", "Centavos")

    def primero(col, defecto=""):
        if not col:
            return defecto
        valores = [v for v in datos[col].astype(str).str.strip() if v]
        return valores[0] if valores else defecto

    propuesta_id = primero(c_id)

    fecha = primero(c_fec)
    if not fecha:
        fecha = datetime.fromtimestamp(os.path.getmtime(ruta)).strftime("%Y-%m-%d %H:%M:%S")
    usuario = primero(c_usr, f"HISTÓRICO ({usuario_importa})")

    refs_j = set(df_jyp["vReference"])
    grupos_g = set(df_grupal["vGroupId"])
    ref_a_grupo = dict(zip(df_grupal["vReference"], df_grupal["vGroupId"]))

    jyp_refs, grupos, no_encontrados = [], [], []
    for _, fila in datos.iterrows():
        tipo = str(fila[c_tipo]).strip().upper() if c_tipo else ""
        ref = str(fila[c_ref]).strip() if c_ref else ""
        gid = str(fila[c_grp]).strip() if c_grp else ""

        if gid and gid in grupos_g and tipo != "JYP":
            grupos.append(gid)
        elif ref and tipo != "GRUPAL" and ref in refs_j:
            jyp_refs.append(ref)
        elif ref and ref in ref_a_grupo:
            grupos.append(ref_a_grupo[ref])
        elif ref or gid:
            no_encontrados.append(ref or gid)

    jyp_refs = list(dict.fromkeys(jyp_refs))
    grupos = list(dict.fromkeys(grupos))

    if not propuesta_id:
        # Id fijo según el contenido: importar dos veces el mismo archivo no duplica.

        firma = "|".join(sorted(jyp_refs)) + "#" + "|".join(sorted(grupos))
        propuesta_id = (
            "PV-HIST-" + str(fecha)[:10].replace("-", "") + "-"
            + hashlib.md5(firma.encode("utf-8")).hexdigest()[:6].upper()
        )
    if propuesta_id in set(ids_existentes):
        return None, {"id": propuesta_id, "duplicada": True}

    if not jyp_refs and not grupos:
        raise ValueError(
            "Ninguna referencia o grupo del archivo existe en las bases actuales."
            + (f"\nEjemplos: {', '.join(no_encontrados[:5])}" if no_encontrados else "")
        )

    det_j = df_jyp[df_jyp["vReference"].isin(jyp_refs)].drop_duplicates("vReference")
    det_g = df_grupal[df_grupal["vGroupId"].isin(grupos)]
    capital = float(det_j["nPendingK"].sum() + det_g["nPendingK"].sum())

    try:
        centavos = float(primero(c_cen, "0") or 0)
    except ValueError:
        centavos = 0.0
    mora = promedio_mora(pd.concat([det_j, det_g], ignore_index=True))

    registro = pd.DataFrame({
        "TipoCartera": ["JyP"] * len(det_j) + ["Grupal"] * len(det_g),
        "vReference": list(det_j["vReference"]) + list(det_g["vReference"]),
        "vGroupId": [""] * len(det_j) + list(det_g["vGroupId"]),
        "nPendingK": list(det_j["nPendingK"].round(2)) + list(det_g["nPendingK"].round(2)),
    })
    registro["IdPropuesta"] = propuesta_id
    registro["FechaPropuesta"] = fecha
    registro["UsuarioWindows"] = usuario
    registro["EquipoWindows"] = primero(c_eq, "Importada")
    registro["TipoVenta"] = (
        "Dual" if len(det_j) and len(det_g) else ("JyP" if len(det_j) else "Grupal")
    )
    registro["CapitalObjetivo"] = primero(c_obj, "")
    registro["CapitalSeleccionado"] = f"{capital:.2f}"
    registro["CentavosPorPeso"] = f"{centavos:.4f}" if centavos else ""
    registro["ValorVenta"] = f"{capital * centavos:.2f}" if centavos else ""
    registro["DiasPromedioMora"] = "" if mora is None else f"{mora:.1f}"
    registro["ArchivoFunnel"] = ruta
    registro = registro[COLUMNAS_APARTADO]

    # En otra propuesta ya registrada en Apartados -> quedará EN CONFLICTO.
    en_otra = len(set(jyp_refs) & set(apartados_jyp)) + len(set(grupos) & set(apartados_grupos))
    # Marcados Propuesta/Venta sólo en la base (normal en propuestas de v6-v8).
    en_base = (
        int(((det_j["_Estatus"] != "DISPONIBLE") & ~det_j["vReference"].isin(set(apartados_jyp))).sum())
        + len(set(det_g.loc[(det_g["_Estatus"] != "DISPONIBLE")
                            & ~det_g["vGroupId"].isin(set(apartados_grupos)), "vGroupId"]))
    )

    resumen = {
        "id": propuesta_id,
        "duplicada": False,
        "archivo": os.path.basename(ruta),
        "usuario": usuario,
        "fecha": fecha,
        "jyp": len(det_j),
        "grupos": len(grupos),
        "integrantes": len(det_g),
        "capital": capital,
        "no_encontrados": no_encontrados,
        "en_otra": en_otra,
        "en_base": en_base,
    }
    return registro, resumen


def calcular_apartados():
    """
    Lee Apartados\\ y Liberaciones\\ y devuelve:
    - jyp: vReference apartadas vigentes
    - grupos: vGroupId apartados vigentes
    - resumen: una fila por propuesta (APARTADA / EN CONFLICTO / LIBERADA)
    Si dos propuestas tomaron el mismo crédito o grupo, gana la más antigua
    y la otra queda EN CONFLICTO (no se pierde, queda visible).
    """
    ap = leer_carpeta(DIR_APARTADOS, COLUMNAS_APARTADO)
    lib = leer_carpeta(DIR_LIBERACIONES, COLUMNAS_LIBERACION)

    liberadas = {}
    for _, r in lib.sort_values("FechaLiberacion").iterrows():
        liberadas.setdefault(r["IdPropuesta"], r)

    duenos_jyp, duenos_grp = {}, {}
    liberados_jyp, liberados_grp = set(), set()
    filas = []

    if not ap.empty:
        cabeceras = (
            ap.groupby("IdPropuesta", sort=False).first().reset_index()
            .sort_values(["FechaPropuesta", "IdPropuesta"])
        )
        for _, cab in cabeceras.iterrows():
            pid = cab["IdPropuesta"]
            det = ap[ap["IdPropuesta"] == pid]
            tipo = det["TipoCartera"].astype(str).str.strip()
            refs = [r for r in det.loc[tipo == "JyP", "vReference"].astype(str).str.strip().unique() if r]
            grupos = [g for g in det.loc[tipo == "Grupal", "vGroupId"].astype(str).str.strip().unique() if g]

            fila = {
                "IdPropuesta": pid,
                "FechaPropuesta": cab["FechaPropuesta"],
                "UsuarioWindows": cab["UsuarioWindows"],
                "EquipoWindows": cab["EquipoWindows"],
                "TipoVenta": cab["TipoVenta"],
                "CreditosJyP": len(refs),
                "GruposGrupal": len(grupos),
                "Registros": len(det),
                "CapitalObjetivo": _a_float(cab["CapitalObjetivo"]),
                "CapitalSeleccionado": _a_float(cab["CapitalSeleccionado"]),
                "CentavosPorPeso": _a_float(cab["CentavosPorPeso"]),
                "ValorVenta": _a_float(cab["ValorVenta"]),
                "DiasPromedioMora": cab["DiasPromedioMora"],
                "ArchivoFunnel": cab["ArchivoFunnel"],
                "EstatusPropuesta": "APARTADA",
                "Conflicto": "",
                "FechaLiberacion": "",
                "UsuarioLibera": "",
                "MotivoLiberacion": "",
            }

            if pid in liberadas:
                l = liberadas[pid]
                fila.update({
                    "EstatusPropuesta": "LIBERADA",
                    "FechaLiberacion": l["FechaLiberacion"],
                    "UsuarioLibera": l["UsuarioLibera"],
                    "MotivoLiberacion": l["MotivoLiberacion"],
                })
                liberados_jyp.update(refs)
                liberados_grp.update(grupos)
                filas.append(fila)
                continue

            choques = [f"{r} ({duenos_jyp[r]})" for r in refs if r in duenos_jyp]
            choques += [f"{g} ({duenos_grp[g]})" for g in grupos if g in duenos_grp]
            if choques:
                fila["EstatusPropuesta"] = "EN CONFLICTO"
                fila["Conflicto"] = "Ya apartados antes en: " + ", ".join(choques[:10])

            for r in refs:
                duenos_jyp.setdefault(r, pid)
            for g in grupos:
                duenos_grp.setdefault(g, pid)
            filas.append(fila)

    resumen = pd.DataFrame(filas)
    return {
        "jyp": set(duenos_jyp),
        "grupos": set(duenos_grp),
        # Liberados y no apartados de nuevo: vuelven a Disponible aunque la base
        # diga Propuesta/Venta (propuestas de v7/v8 que sí escribían en la base).
        "liberados_jyp": liberados_jyp - set(duenos_jyp),
        "liberados_grupos": liberados_grp - set(duenos_grp),
        "resumen": resumen,
        "firma": firma_registro(),
    }


# ============================================================
# TEMA (Tema Ejecutivo Exitus Credit · mismo JSON de los dashboards)
# ============================================================

T = {
    "rojo": "#B01217",
    "rojo_oscuro": "#7A0C10",
    "rojo_suave": "#FCEAEC",
    "rojo_borde_suave": "#E8B7BA",
    "rojo_seleccion": "#F8DDDF",
    "tinta": "#1F2430",
    "pizarra": "#3E4652",
    "gris_medio": "#5A6472",
    "texto_secundario": "#5F6875",
    "gris_suave": "#A0A8B3",
    "texto_sobre_oscuro": "#C9CED6",
    "subtitulo_sobre_oscuro": "#CDD2D9",
    "borde": "#D9DDE3",
    "linea_fila": "#ECEFF2",
    "fondo_pagina": "#F3F4F6",
    "fondo_fila_hover": "#FAFAFB",
    "fondo_grupo": "#ECEEF1",
    "blanco": "#FFFFFF",
    "bien": "#2E7D32",
    "alerta": "#F2B705",
    "mal": "#B01217",
}
FUENTE = "Segoe UI"


# Escala de letra (A- / A+ en el encabezado). Se guarda por usuario.
ESCALA_DEFECTO = 1.20
ESCALAS = (1.00, 1.10, 1.20, 1.35, 1.50, 1.70)
_ESCALA = [ESCALA_DEFECTO]
_FUENTES = {}
PREFERENCIAS = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "VentaCartera", "preferencias.json"
)


def leer_escala():
    try:
        with open(PREFERENCIAS, "r", encoding="utf-8") as f:
            valor = float(json.load(f).get("escala", ESCALA_DEFECTO))
        return min(ESCALAS, key=lambda e: abs(e - valor))
    except Exception:
        return ESCALA_DEFECTO


def guardar_escala(valor):
    try:
        os.makedirs(os.path.dirname(PREFERENCIAS), exist_ok=True)
        with open(PREFERENCIAS, "w", encoding="utf-8") as f:
            json.dump({"escala": valor}, f)
    except Exception:
        pass


def _puntos(px):
    # Tamaños del JSON en px (a 96 dpi) convertidos a puntos: Windows los
    # agranda solo según la escala de pantalla (125 %, 150 %) y además se
    # aplica la escala elegida por el usuario.
    return max(7, int(round(px * 0.75 * _ESCALA[0])))


def F(px, peso="normal"):
    """Fuente compartida; al cambiar la escala se actualizan todas en vivo."""
    clave = (px, peso)
    if clave not in _FUENTES:
        _FUENTES[clave] = tkfont.Font(
            family=FUENTE, size=_puntos(px), weight="bold" if peso == "bold" else "normal"
        )
    return _FUENTES[clave]


def aplicar_escala(valor):
    _ESCALA[0] = valor
    for (px, _), fuente in _FUENTES.items():
        fuente.configure(size=_puntos(px))


def W(px):
    """Ancho en pixeles escalado igual que la letra."""
    # "0" en Segoe UI 10 pt a 96 dpi mide ~7 px; crece con la escala y los dpi.
    return int(px * max(F(13).measure("0"), 1) / 7)


def hover(widget, normal, encima):
    widget.bind("<Enter>", lambda e: widget.configure(bg=encima))
    widget.bind("<Leave>", lambda e: widget.configure(bg=normal))


def boton(padre, texto, comando, tipo="primario"):
    """
    primario   -> fondo tinta, texto blanco
    marca      -> fondo rojo, texto blanco (acción principal)
    secundario -> fondo blanco, texto tinta, borde gris
    """
    if tipo == "secundario":
        marco = tk.Frame(padre, bg=T["borde"], padx=1, pady=1)
        b = tk.Button(
            marco, text=texto, command=comando, bg=T["blanco"], fg=T["tinta"],
            activebackground=T["fondo_pagina"], activeforeground=T["tinta"],
            relief="flat", bd=0, font=F(13, "bold"), padx=13, pady=5, cursor="hand2"
        )
        b.pack()
        hover(b, T["blanco"], T["fondo_pagina"])
        return marco

    fondo = T["rojo"] if tipo == "marca" else T["tinta"]
    encima = T["rojo_oscuro"] if tipo == "marca" else T["pizarra"]
    b = tk.Button(
        padre, text=texto, command=comando, bg=fondo, fg=T["blanco"],
        activebackground=encima, activeforeground=T["blanco"],
        relief="flat", bd=0, font=F(13, "bold"), padx=14, pady=6, cursor="hand2"
    )
    hover(b, fondo, encima)
    return b


def tarjeta(padre, titulo=None, **pack):
    marco = tk.Frame(
        padre, bg=T["blanco"], highlightthickness=1,
        highlightbackground=T["borde"], highlightcolor=T["borde"]
    )
    marco.pack(**pack)
    cuerpo = tk.Frame(marco, bg=T["blanco"], padx=14, pady=10)
    cuerpo.pack(fill="both", expand=True)
    if titulo:
        tk.Label(
            cuerpo, text=titulo.upper(), bg=T["blanco"], fg=T["tinta"],
            font=F(13, "bold")
        ).pack(anchor="w", pady=(0, 6))
    return cuerpo


def etiqueta_filtro(padre, texto):
    return tk.Label(
        padre, text=texto.upper(), bg=T["blanco"], fg=T["rojo_oscuro"],
        font=F(11, "bold")
    )


def entrada(padre, var=None, ancho=14):
    return tk.Entry(
        padre, textvariable=var, width=ancho, relief="flat", bd=0,
        font=F(14), bg=T["blanco"], fg=T["tinta"], insertbackground=T["tinta"],
        highlightthickness=1, highlightbackground=T["borde"], highlightcolor=T["rojo"]
    )


def lista(padre, alto=6):
    return tk.Listbox(
        padre, selectmode=tk.MULTIPLE, height=alto, exportselection=False,
        relief="flat", bd=0, font=F(13), bg=T["blanco"], fg=T["tinta"],
        selectbackground=T["rojo_seleccion"], selectforeground=T["rojo_oscuro"],
        highlightthickness=1, highlightbackground=T["borde"], highlightcolor=T["borde"],
        activestyle="none"
    )


class EntradaBusqueda(tk.Entry):
    """Entry con texto guía; .valor() ignora el texto guía."""

    def __init__(self, padre, guia, al_cambiar=None, ancho=24):
        self.var = tk.StringVar()
        super().__init__(
            padre, textvariable=self.var, width=ancho, relief="flat", bd=0,
            font=F(13), bg=T["blanco"], fg=T["gris_suave"], insertbackground=T["tinta"],
            highlightthickness=1, highlightbackground=T["borde"], highlightcolor=T["rojo"]
        )
        self.guia = guia
        self._con_guia = True
        self.var.set(guia)
        self.bind("<FocusIn>", self._entrar)
        self.bind("<FocusOut>", self._salir)
        if al_cambiar:
            self.bind("<KeyRelease>", lambda e: al_cambiar())

    def _entrar(self, _=None):
        if self._con_guia:
            self.var.set("")
            self.configure(fg=T["tinta"])
            self._con_guia = False

    def _salir(self, _=None):
        if not self.var.get().strip():
            self.limpiar()

    def valor(self):
        return "" if self._con_guia else self.var.get().strip()

    def limpiar(self):
        self._con_guia = True
        self.configure(fg=T["gris_suave"])
        self.var.set(self.guia)


def terminos_busqueda(texto):
    """Separa por coma, punto y coma, espacio o salto de línea (pegar listas)."""
    for sep in (",", ";", "\n", "\t", "\r"):
        texto = texto.replace(sep, " ")
    return [t.strip().upper() for t in texto.split(" ") if t.strip()]


def coincide(serie, terminos):
    """Un término: contiene. Varios: coincidencia exacta con cualquiera."""
    s = serie.astype(str).str.strip().str.upper()
    if len(terminos) == 1:
        return s.str.contains(terminos[0], regex=False)
    return s.isin(terminos)


# ============================================================
# APLICACIÓN
# ============================================================

COLUMNAS_NUMERICAS = {"Capital", "nPendingK", "iDays", "DiasPromedioMora", "Integrantes", "iDays / Mora"}


class VentaCarteraApp:

    def __init__(self, root):
        self.root = root
        self.root.title(APP_TITLE)
        aplicar_escala(leer_escala())
        ancho = min(1600, self.root.winfo_screenwidth() - 40)
        alto = min(980, self.root.winfo_screenheight() - 80)
        self.root.geometry(f"{ancho}x{alto}+10+10")
        self.root.minsize(1100, 680)
        try:
            self.root.state("zoomed")  # Windows: abre maximizada
        except Exception:
            pass
        self.root.configure(bg=T["fondo_pagina"])

        self.usuario_windows = getpass.getuser()
        self.equipo_windows = socket.gethostname()
        self.es_admin = es_administrador(self.usuario_windows)
        self.apartados = {"jyp": set(), "grupos": set(), "liberados_jyp": set(), "liberados_grupos": set(), "resumen": pd.DataFrame(), "firma": ()}
        self._mtime_cargado = None

        self.df_jyp = None
        self.df_grupal = None
        self.df_grupos = pd.DataFrame()
        self.df_resultado = pd.DataFrame()
        self.df_seleccionado = pd.DataFrame()
        self._pos_grupo = {}
        self._marcados = set()

        self._mun_todos = []      # municipios de los estados elegidos
        self._mun_sel = set()     # municipios elegidos (persisten al buscar)

        self.portafolio = tk.StringVar(value="JyP")
        self.capital_objetivo = tk.DoubleVar(value=200000.0)
        self.centavos = tk.DoubleVar(value=0.26)
        self.prioridad = tk.StringVar(value=PRIORIDADES[0])
        self.mora_min = tk.StringVar(value="")
        self.mora_max = tk.StringVar(value="")

        self.cargar_bases()
        self.configurar_estilos()
        self.crear_interfaz()
        self.cargar_estados()

        self.root.after(REVISION_SEG * 1000, self.revisar_cambios)

        avisos = diagnosticar_bases(self.df_jyp, self.df_grupal)
        if avisos:
            self.root.after(
                300,
                lambda: messagebox.showwarning(
                    "Diagnóstico de bases",
                    "Revisa estos puntos en las bases:\n\n• " + "\n\n• ".join(avisos)
                )
            )

    # --------------------------------------------------------
    # CARGA
    # --------------------------------------------------------

    def _mtime_bases(self):
        try:
            return (os.path.getmtime(BASE_JYP), os.path.getmtime(BASE_GRUPAL))
        except OSError:
            return None

    def cargar_bases(self):
        self.df_jyp = preparar_base(cargar_csv(BASE_JYP), es_grupal=False)
        self.df_grupal = preparar_base(cargar_csv(BASE_GRUPAL), es_grupal=True)
        self._mtime_cargado = self._mtime_bases()

        self.df_jyp["TipoCartera"] = "JyP"
        self.df_grupal["TipoCartera"] = "Grupal"

        # Estatus tal como viene en la base (antes de los apartados).
        self._est_base = {
            "jyp": (self.df_jyp["Estatus"].copy(), self.df_jyp["_Estatus"].copy()),
            "grp": (self.df_grupal["Estatus"].copy(), self.df_grupal["_Estatus"].copy()),
        }

        self._pos_grupo = self.df_grupal.groupby("vGroupId", sort=False).indices
        self.aplicar_apartados()

    def aplicar_apartados(self):
        """Marca como Propuesta/Venta lo que está en la carpeta Apartados y no fue liberado."""
        if not getattr(self, "_migrado", False):
            migrar_bitacora_v8()
            self._migrado = True
        self.apartados = calcular_apartados()

        for clave, df, columna, activos in (
            ("jyp", self.df_jyp, "vReference", self.apartados["jyp"]),
            ("grp", self.df_grupal, "vGroupId", self.apartados["grupos"]),
        ):
            est, est_norm = self._est_base[clave]
            df["Estatus"] = est
            df["_Estatus"] = est_norm
            liberados = self.apartados["liberados_jyp" if clave == "jyp" else "liberados_grupos"]
            if liberados:
                mask = df[columna].isin(liberados) & (df["_Estatus"] == normalizar_texto(ESTATUS_APARTADO))
                df.loc[mask, "Estatus"] = ESTATUS_DISPONIBLE
                df.loc[mask, "_Estatus"] = "DISPONIBLE"
            if activos:
                mask = df[columna].isin(activos)
                df.loc[mask, "Estatus"] = ESTATUS_APARTADO
                df.loc[mask, "_Estatus"] = normalizar_texto(ESTATUS_APARTADO)

    def revisar_cambios(self):
        """Cada minuto revisa si otro usuario apartó o liberó algo."""
        try:
            if firma_registro() != self.apartados["firma"]:
                if not self.tree.selection():
                    self.aplicar_apartados()
                    if self.tree.get_children():
                        self.aplicar_filtros(silencioso=True)
                    self.lbl_actualizacion.config(
                        text="Apartados de otros usuarios actualizados " + datetime.now().strftime("%H:%M"),
                        fg=T["texto_secundario"]
                    )
                else:
                    self.lbl_actualizacion.config(
                        text="⚠ Hay apartados nuevos de otros usuarios; se validarán al apartar",
                        fg=T["rojo"]
                    )
        except Exception:
            pass
        self.root.after(REVISION_SEG * 1000, self.revisar_cambios)

    def recargar_bases(self):
        try:
            self.cargar_bases()
        except Exception as exc:
            messagebox.showerror("Recargar bases", str(exc))
            return
        estados_previos = self.estados_elegidos()
        mun_previos = set(self._mun_sel)
        self.cargar_estados()
        for i in range(self.list_estados.size()):
            if self.list_estados.get(i) in estados_previos:
                self.list_estados.selection_set(i)
        self._mun_sel = mun_previos
        self.actualizar_municipios()
        if self.tree.get_children():
            self.aplicar_filtros(silencioso=True)
        self.lbl_actualizacion.config(text="Bases recargadas " + datetime.now().strftime("%H:%M"))

    # --------------------------------------------------------
    # ESTILOS
    # --------------------------------------------------------

    def configurar_estilos(self):
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except Exception:
            pass

        style.configure(
            "Treeview", font=F(13), rowheight=F(13).metrics("linespace") + 12, background=T["blanco"],
            fieldbackground=T["blanco"], foreground=T["tinta"], borderwidth=0
        )
        style.map(
            "Treeview",
            background=[("selected", T["rojo_suave"])],
            foreground=[("selected", T["rojo_oscuro"])]
        )
        style.configure(
            "Treeview.Heading", font=F(12.5, "bold"), background=T["tinta"],
            foreground=T["blanco"], relief="flat", padding=(8, 7), borderwidth=0
        )
        style.map("Treeview.Heading", background=[("active", T["pizarra"])])

        style.configure(
            "Exitus.TCombobox", fieldbackground=T["blanco"], background=T["blanco"],
            foreground=T["tinta"], arrowcolor=T["tinta"], bordercolor=T["borde"],
            lightcolor=T["borde"], darkcolor=T["borde"], padding=4
        )
        style.configure(
            "Vertical.TScrollbar", background=T["fondo_grupo"], troughcolor=T["blanco"],
            bordercolor=T["blanco"], arrowcolor=T["gris_medio"]
        )
        style.configure(
            "Horizontal.TScrollbar", background=T["fondo_grupo"], troughcolor=T["blanco"],
            bordercolor=T["blanco"], arrowcolor=T["gris_medio"]
        )
        self.root.option_add("*TCombobox*Listbox.font", str(F(13)))
        self.root.option_add("*TCombobox*Listbox.selectBackground", T["rojo_seleccion"])
        self.root.option_add("*TCombobox*Listbox.selectForeground", T["rojo_oscuro"])

    # --------------------------------------------------------
    # INTERFAZ
    # --------------------------------------------------------

    def crear_interfaz(self):
        # ---------------- Encabezado ----------------
        header = tk.Frame(self.root, bg=T["tinta"], pady=6)
        header.pack(fill="x")
        tk.Frame(self.root, bg=T["rojo"], height=3).pack(fill="x")

        titulo = tk.Frame(header, bg=T["tinta"])
        titulo.pack(side="left", padx=20)
        tk.Label(
            titulo, text="💼 Venta de Cartera", bg=T["tinta"], fg=T["blanco"],
            font=F(24, "bold")
        ).pack(anchor="w", pady=(8, 0))
        tk.Label(
            titulo, text=f"Exitus Credit · Armado y apartado de propuestas · {APP_VERSION}",
            bg=T["tinta"], fg=T["subtitulo_sobre_oscuro"], font=F(12.5)
        ).pack(anchor="w")

        derecha = tk.Frame(header, bg=T["tinta"])
        derecha.pack(side="right", padx=20)

        usuario = tk.Frame(derecha, bg=T["tinta"])
        usuario.pack(side="right", padx=(14, 0))
        tk.Label(
            usuario, text=f"👤 {self.usuario_windows}", bg=T["tinta"], fg=T["blanco"],
            font=F(13, "bold")
        ).pack(anchor="e")
        tk.Label(
            usuario, text=f"{'Administrador' if self.es_admin else 'Vendedor'} · {self.equipo_windows}", bg=T["tinta"],
            fg=T["texto_sobre_oscuro"], font=F(11.5)
        ).pack(anchor="e")

        b = tk.Button(
            derecha, text="⟳ Recargar bases", command=self.recargar_bases,
            bg=T["pizarra"], fg=T["blanco"], activebackground=T["gris_medio"],
            activeforeground=T["blanco"], relief="flat", bd=0, font=F(12.5, "bold"),
            padx=12, pady=5, cursor="hand2"
        )
        b.pack(side="right")
        hover(b, T["pizarra"], T["gris_medio"])

        zoom = tk.Frame(derecha, bg=T["tinta"])
        zoom.pack(side="right", padx=(0, 12))
        for texto, paso in (("A−", -1), ("A+", 1)):
            z = tk.Button(
                zoom, text=texto, command=lambda p=paso: self.cambiar_escala(p),
                bg=T["pizarra"], fg=T["blanco"], activebackground=T["gris_medio"],
                activeforeground=T["blanco"], relief="flat", bd=0, font=F(13, "bold"),
                padx=10, pady=4, cursor="hand2"
            )
            z.pack(side="left", padx=(0, 2))
            hover(z, T["pizarra"], T["gris_medio"])

        main = tk.Frame(self.root, bg=T["fondo_pagina"])
        main.pack(fill="both", expand=True, padx=14, pady=(12, 12))

        # ======== Panel izquierdo (parámetros + filtros), con scroll ========
        self.panel_izq = tk.Frame(main, bg=T["fondo_pagina"])
        self.panel_izq.pack(side="left", fill="y", padx=(0, 12))

        ancho_panel = W(360)
        lienzo = tk.Canvas(
            self.panel_izq, bg=T["fondo_pagina"], highlightthickness=0, width=ancho_panel
        )
        barra_izq = ttk.Scrollbar(self.panel_izq, orient="vertical", command=lienzo.yview)
        lienzo.configure(yscrollcommand=barra_izq.set)
        lienzo.pack(side="left", fill="y")
        barra_izq.pack(side="right", fill="y")
        izq = tk.Frame(lienzo, bg=T["fondo_pagina"])
        ventana = lienzo.create_window((0, 0), window=izq, anchor="nw", width=ancho_panel)
        izq.bind("<Configure>", lambda e: lienzo.configure(scrollregion=lienzo.bbox("all")))
        self._lienzo_izq, self._ventana_izq, self._izq = lienzo, ventana, izq

        def rueda(event):
            lienzo.yview_scroll(int(-event.delta / 120) or (-1 if event.num == 4 else 1), "units")
        izq.bind("<Enter>", lambda e: lienzo.bind_all("<MouseWheel>", rueda))
        izq.bind("<Leave>", lambda e: lienzo.unbind_all("<MouseWheel>"))

        # ---------------- Propuesta ----------------
        p = tarjeta(izq, "Propuesta", fill="x")

        etiqueta_filtro(p, "Tipo de venta").pack(anchor="w")
        seg = tk.Frame(p, bg=T["borde"], padx=1, pady=1)
        seg.pack(fill="x", pady=(3, 10))
        self._seg_botones = {}
        for valor in ("JyP", "Grupal", "Dual"):
            sb = tk.Button(
                seg, text=valor, relief="flat", bd=0, font=F(13, "bold"),
                pady=5, cursor="hand2", command=lambda v=valor: self.elegir_portafolio(v)
            )
            sb.pack(side="left", fill="x", expand=True, padx=(0, 1))
            self._seg_botones[valor] = sb
        self.pintar_segmentado()

        dos = tk.Frame(p, bg=T["blanco"])
        dos.pack(fill="x")
        dos.grid_columnconfigure(0, weight=3)
        dos.grid_columnconfigure(1, weight=2)
        for c, (texto, var, evento) in enumerate((
            ("Capital objetivo", self.capital_objetivo, self.al_cambiar_capital),
            ("Centavos por peso", self.centavos, self.actualizar_seleccion),
        )):
            etiqueta_filtro(dos, texto).grid(row=0, column=c, sticky="w", padx=(0 if c == 0 else 8, 0))
            e = entrada(dos, var, 8)
            e.grid(row=1, column=c, sticky="ew", padx=(0 if c == 0 else 8, 0), pady=(3, 0), ipady=4)
            e.bind("<KeyRelease>", lambda ev, f=evento: f())

        etiqueta_filtro(p, "Rango permitido").pack(anchor="w", pady=(10, 0))
        self.lbl_rango = tk.Label(
            p, text="", bg=T["rojo_suave"], fg=T["rojo_oscuro"], font=F(12.5, "bold"),
            pady=5, highlightthickness=1, highlightbackground=T["rojo_borde_suave"]
        )
        self.lbl_rango.pack(fill="x", pady=(3, 10))

        etiqueta_filtro(p, "Prioridad para sugerir").pack(anchor="w")
        ttk.Combobox(
            p, textvariable=self.prioridad, values=PRIORIDADES, state="readonly",
            style="Exitus.TCombobox", font=F(13)
        ).pack(fill="x", pady=(3, 8))
        boton(p, "⚡ Sugerir propuesta", self.sugerir, "primario").pack(fill="x")

        # ---------------- Filtros ----------------
        f = tarjeta(izq, "Filtros", fill="x", pady=(12, 0))
        self.card_filtros = f.master

        cab = tk.Frame(f, bg=T["blanco"])
        cab.pack(fill="x")
        etiqueta_filtro(cab, "Estados").pack(side="left")
        self.lbl_estados = tk.Label(cab, text="", bg=T["blanco"], fg=T["texto_secundario"], font=F(11.5))
        self.lbl_estados.pack(side="right")
        self.list_estados = lista(f, 6)
        self.list_estados.pack(fill="x", pady=(4, 10))
        self.list_estados.bind("<<ListboxSelect>>", self.actualizar_municipios)

        cab = tk.Frame(f, bg=T["blanco"])
        cab.pack(fill="x")
        etiqueta_filtro(cab, "Municipios").pack(side="left")
        self.lbl_municipios = tk.Label(cab, text="Todos", bg=T["blanco"], fg=T["texto_secundario"], font=F(11.5))
        self.lbl_municipios.pack(side="right")
        self.buscar_municipio = EntradaBusqueda(f, "🔍 Buscar municipio…", self.filtrar_lista_municipios)
        self.buscar_municipio.pack(fill="x", pady=(4, 4), ipady=3)
        self.list_municipios = lista(f, 6)
        self.list_municipios.pack(fill="x", pady=(0, 10))
        self.list_municipios.bind("<<ListboxSelect>>", self.al_elegir_municipio)

        etiqueta_filtro(f, "Días de mora").pack(anchor="w")
        rango = tk.Frame(f, bg=T["blanco"])
        rango.pack(fill="x", pady=(4, 10))
        tk.Label(rango, text="De", bg=T["blanco"], fg=T["texto_secundario"], font=F(13)).pack(side="left")
        e = entrada(rango, self.mora_min, 6)
        e.pack(side="left", padx=6, ipady=3)
        e.bind("<Return>", lambda ev: self.aplicar_filtros())
        tk.Label(rango, text="a", bg=T["blanco"], fg=T["texto_secundario"], font=F(13)).pack(side="left")
        e = entrada(rango, self.mora_max, 6)
        e.pack(side="left", padx=6, ipady=3)
        e.bind("<Return>", lambda ev: self.aplicar_filtros())
        tk.Label(rango, text="días", bg=T["blanco"], fg=T["texto_secundario"], font=F(13)).pack(side="left")

        etiqueta_filtro(f, "Buscar vReference / Grupo").pack(anchor="w")
        self.buscar_ref = EntradaBusqueda(f, "🔍 Una o varias, separadas por coma…")
        self.buscar_ref.pack(fill="x", pady=(4, 2), ipady=3)
        self.buscar_ref.bind("<Return>", lambda ev: self.aplicar_filtros())
        tk.Label(
            f, text="Con referencia no es obligatorio elegir Estado.", bg=T["blanco"],
            fg=T["gris_suave"], font=F(11.5)
        ).pack(anchor="w")

        btns = tk.Frame(f, bg=T["blanco"])
        btns.pack(fill="x", pady=(10, 0))
        btns.grid_columnconfigure(0, weight=1)
        btns.grid_columnconfigure(1, weight=1)
        boton(btns, "Aplicar filtros", self.aplicar_filtros, "primario").grid(row=0, column=0, sticky="ew", padx=(0, 4))
        bl = boton(btns, "Limpiar filtros", self.limpiar_filtros, "secundario")
        bl.grid(row=0, column=1, sticky="ew", padx=(4, 0))
        bl.winfo_children()[0].pack_configure(fill="x")

        # ======== Panel derecho: acciones, KPIs y tabla de validación ========
        der = tk.Frame(main, bg=T["fondo_pagina"])
        der.pack(side="left", fill="both", expand=True)

        acciones = tk.Frame(der, bg=T["fondo_pagina"])
        acciones.pack(fill="x")
        self.btn_panel = boton(acciones, "◀ Panel", self.alternar_panel, "secundario")
        self.btn_panel.pack(side="left")
        boton(acciones, "🔎 Aplicar filtros", self.aplicar_filtros, "primario").pack(side="left", padx=(6, 0))
        boton(acciones, "✔ Validar y apartar", self.validar_y_apartar, "marca").pack(side="right")
        boton(acciones, "📋 Bitácora", self.abrir_bitacora, "secundario").pack(side="right", padx=(0, 6))
        boton(acciones, "Limpiar", self.limpiar_seleccion, "secundario").pack(side="right", padx=(0, 6))
        boton(acciones, "☑ Todos", self.seleccionar_todos, "secundario").pack(side="right", padx=(0, 6))

        # ---------------- KPIs ----------------
        kpis = tk.Frame(der, bg=T["fondo_pagina"])
        self.kpis_frame = kpis
        kpis.pack(fill="x", pady=(10, 0))
        self.kpi = {}
        for i, (clave, titulo) in enumerate((
            ("disp", "📊 Disponibles"),
            ("capital", "💰 Capital"),
            ("venta", "📈 Valor de venta"),
            ("mora", "📅 Mora promedio"),
            ("partidas", "☑ Partidas"),
        )):
            kpis.grid_columnconfigure(i, weight=1, uniform="k")
            self.kpi[clave] = self.crear_kpi(kpis, titulo, i)

        # ---------------- Tabla ----------------
        t = tarjeta(der, None, fill="both", expand=True, pady=(10, 0))
        barra = tk.Frame(t, bg=T["blanco"])
        barra.pack(fill="x", pady=(0, 4))
        self.lbl_tabla = tk.Label(
            barra, text="DETALLE", bg=T["blanco"], fg=T["tinta"], font=F(13, "bold")
        )
        self.lbl_tabla.pack(side="left")
        self.lbl_actualizacion = tk.Label(
            barra, text=f"Bases cargadas {datetime.now().strftime('%H:%M')}",
            bg=T["blanco"], fg=T["texto_secundario"], font=F(12)
        )
        self.lbl_actualizacion.pack(side="right")
        self.lbl_resumen_filtros = tk.Label(
            t, text="Elige Estado(s) o busca una referencia y presiona Aplicar filtros.",
            bg=T["blanco"], fg=T["texto_secundario"], font=F(12), anchor="w"
        )
        self.lbl_resumen_filtros.pack(fill="x", pady=(0, 8))

        table_frame = tk.Frame(t, bg=T["blanco"])
        table_frame.pack(fill="both", expand=True)

        self.tree = ttk.Treeview(table_frame, show="headings", selectmode="extended")
        scroll_y = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        scroll_x = ttk.Scrollbar(table_frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=scroll_y.set, xscrollcommand=scroll_x.set)

        self.tree.grid(row=0, column=0, sticky="nsew")
        scroll_y.grid(row=0, column=1, sticky="ns")
        scroll_x.grid(row=1, column=0, sticky="ew")
        table_frame.grid_rowconfigure(0, weight=1)
        table_frame.grid_columnconfigure(0, weight=1)

        self.tree.tag_configure("impar", background=T["fondo_fila_hover"])
        self.tree.tag_configure("bloqueado", foreground=T["gris_suave"])

        self.tree.bind("<<TreeviewSelect>>", self.actualizar_seleccion)
        self.tree.bind("<Button-1>", self.manejar_click_tabla)

        self.actualizar_rango()
        self.actualizar_seleccion()
        self.actualizar_kpi_disponibles()

    def alternar_panel(self):
        b = self.btn_panel.winfo_children()[0]
        if self.panel_izq.winfo_ismapped():
            self.panel_izq.pack_forget()
            b.config(text="▶ Panel")
        else:
            self.panel_izq.pack(side="left", fill="y", padx=(0, 12), before=self.panel_izq.master.winfo_children()[1])
            b.config(text="◀ Panel")

    def ajustar_panel(self):
        """Tras cambiar el tamaño de letra, ajusta el ancho del panel izquierdo."""
        ancho = W(360)
        self._lienzo_izq.configure(width=ancho)
        self._lienzo_izq.itemconfigure(self._ventana_izq, width=ancho)

    def cambiar_escala(self, paso):
        actual = _ESCALA[0]
        i = min(range(len(ESCALAS)), key=lambda k: abs(ESCALAS[k] - actual))
        nuevo = ESCALAS[max(0, min(len(ESCALAS) - 1, i + paso))]
        if nuevo == actual:
            return
        aplicar_escala(nuevo)
        guardar_escala(nuevo)
        ttk.Style().configure("Treeview", rowheight=F(13).metrics("linespace") + 12)
        self.ajustar_panel()
        cols = list(self.tree["columns"])
        if cols:
            self.configurar_columnas(cols[1:])
        self.lbl_actualizacion.config(text=f"Tamaño de letra {int(round(nuevo * 100))} %")

    def crear_kpi(self, padre, titulo, col):
        marco = tk.Frame(padre, bg=T["blanco"], highlightthickness=1, highlightbackground=T["borde"])
        marco.grid(row=0, column=col, sticky="nsew", padx=(0 if col == 0 else 6, 0))
        barra = tk.Frame(marco, bg=T["tinta"], height=4)
        barra.pack(fill="x")
        cuerpo = tk.Frame(marco, bg=T["blanco"], padx=10, pady=5)
        cuerpo.pack(fill="both", expand=True)
        tit = tk.Label(cuerpo, text=titulo.upper(), bg=T["blanco"], fg=T["texto_secundario"],
                       font=F(11, "bold"), justify="left", anchor="w")
        tit.pack(fill="x")
        valor = tk.Label(cuerpo, text="—", bg=T["blanco"], fg=T["tinta"], font=F(20, "bold"), anchor="w")
        valor.pack(fill="x")
        sub = tk.Label(cuerpo, text="", bg=T["blanco"], fg=T["texto_secundario"], font=F(11.5),
                       justify="left", anchor="w")
        sub.pack(fill="x")
        # El texto se acomoda en varias líneas si la tarjeta es angosta.
        def ajustar(e, etiquetas=(tit, sub)):
            for et in etiquetas:
                et.configure(wraplength=max(60, e.width - 22))
        marco.bind("<Configure>", ajustar)
        return {"barra": barra, "valor": valor, "sub": sub}

    def set_kpi(self, clave, valor, sub="", estado=None):
        k = self.kpi[clave]
        color = {"good": T["bien"], "bad": T["mal"], "warn": T["alerta"]}.get(estado)
        k["barra"].configure(bg=color or T["tinta"])
        k["valor"].configure(text=valor, fg=T["tinta"] if estado in (None, "warn") else color)
        k["sub"].configure(text=sub)

    # --------------------------------------------------------
    # PORTAFOLIO
    # --------------------------------------------------------

    def pintar_segmentado(self):
        for valor, b in self._seg_botones.items():
            if valor == self.portafolio.get():
                b.configure(bg=T["rojo"], fg=T["blanco"], activebackground=T["rojo_oscuro"],
                            activeforeground=T["blanco"])
            else:
                b.configure(bg=T["blanco"], fg=T["tinta"], activebackground=T["fondo_pagina"],
                            activeforeground=T["tinta"])

    def elegir_portafolio(self, valor):
        if valor == self.portafolio.get():
            return
        self.portafolio.set(valor)
        self.pintar_segmentado()
        self.cambiar_portafolio()

    def cambiar_portafolio(self):
        self.df_resultado = pd.DataFrame()
        self.df_grupos = pd.DataFrame()
        self.limpiar_tabla()
        self._mun_sel = set()
        self.cargar_estados()
        self.actualizar_rango()
        self.actualizar_kpi_disponibles()

    # --------------------------------------------------------
    # ESTADOS / MUNICIPIOS
    # --------------------------------------------------------

    def base_para_portafolio(self):
        tipo = self.portafolio.get()

        if tipo == "JyP":
            return self.df_jyp

        if tipo == "Grupal":
            return self.df_grupal

        return pd.concat(
            [
                self.df_jyp[["_Estado", "_Municipio"]],
                self.df_grupal[["_Estado", "_Municipio"]]
            ],
            ignore_index=True
        )

    def estados_elegidos(self):
        return [self.list_estados.get(i) for i in self.list_estados.curselection()]

    def cargar_estados(self):
        self.list_estados.delete(0, tk.END)
        self.list_municipios.delete(0, tk.END)
        self._mun_todos = []

        df = self.base_para_portafolio()
        for estado in estados_de(df):
            self.list_estados.insert(tk.END, estado)
        self.actualizar_contadores()

    def actualizar_municipios(self, event=None):
        estados = self.estados_elegidos()
        if estados:
            self._mun_todos = municipios_de(self.base_para_portafolio(), estados)
        else:
            self._mun_todos = []
        # Conserva sólo los municipios que siguen existiendo.
        self._mun_sel &= set(self._mun_todos)
        self.filtrar_lista_municipios()

    def filtrar_lista_municipios(self):
        texto = normalizar_texto(self.buscar_municipio.valor()) if hasattr(self, "buscar_municipio") else ""
        visibles = [m for m in self._mun_todos if texto in m] if texto else self._mun_todos

        self.list_municipios.delete(0, tk.END)
        for i, m in enumerate(visibles):
            self.list_municipios.insert(tk.END, m)
            if m in self._mun_sel:
                self.list_municipios.selection_set(i)
        self.actualizar_contadores()

    def al_elegir_municipio(self, event=None):
        visibles = self.list_municipios.get(0, tk.END)
        elegidos = {self.list_municipios.get(i) for i in self.list_municipios.curselection()}
        for m in visibles:
            if m in elegidos:
                self._mun_sel.add(m)
            else:
                self._mun_sel.discard(m)
        self.actualizar_contadores()

    def actualizar_contadores(self):
        n_e = len(self.list_estados.curselection())
        self.lbl_estados.config(text=f"{n_e} elegidos" if n_e else f"{self.list_estados.size()} disponibles")
        n_m = len(self._mun_sel)
        if not self._mun_todos:
            texto = "Elige un estado"
        elif n_m:
            texto = f"{n_m} elegidos de {len(self._mun_todos)}"
        else:
            texto = f"Todos ({len(self._mun_todos)})"
        self.lbl_municipios.config(text=texto)

    # --------------------------------------------------------
    # FILTROS
    # --------------------------------------------------------

    def _numero_opcional(self, var, nombre):
        texto = str(var.get()).strip().replace(",", "")
        if not texto:
            return None
        try:
            return float(texto)
        except ValueError:
            raise ValueError(f"{nombre} debe ser numérico.")

    def obtener_filtros(self):
        estados = self.estados_elegidos()
        municipios = sorted(self._mun_sel)
        terminos = terminos_busqueda(self.buscar_ref.valor())
        mora_min = self._numero_opcional(self.mora_min, "Mora mínima")
        mora_max = self._numero_opcional(self.mora_max, "Mora máxima")

        if mora_min is not None and mora_max is not None and mora_min > mora_max:
            raise ValueError("La mora mínima no puede ser mayor que la máxima.")

        if not estados and not terminos:
            raise ValueError("Selecciona al menos un Estado o busca una vReference / Grupo.")

        return {
            "estados": estados,
            "municipios": municipios,
            "terminos": terminos,
            "mora_min": mora_min,
            "mora_max": mora_max,
        }

    def aplicar_filtros(self, silencioso=False):
        try:
            objetivo = float(self.capital_objetivo.get())
            if objetivo <= 0:
                raise ValueError
        except Exception:
            if not silencioso:
                messagebox.showerror("Capital inválido", "Captura un capital objetivo mayor a cero.")
            return

        try:
            f = self.obtener_filtros()
        except ValueError as exc:
            if not silencioso:
                messagebox.showwarning("Filtros", str(exc))
            return

        tipo = self.portafolio.get()

        if tipo == "JyP":
            self.df_resultado = self.filtrar_jyp(f)
            self.df_grupos = pd.DataFrame()
            self.mostrar_jyp()

        elif tipo == "Grupal":
            self.df_resultado = pd.DataFrame()
            self.df_grupos = self.generar_grupos_filtrados(f)
            self.mostrar_grupal()

        else:
            jyp = self.filtrar_jyp(f).copy()
            jyp["TipoCartera"] = "JyP"
            grupos = self.generar_grupos_filtrados(f).copy()
            grupos["TipoCartera"] = "Grupal"
            self.df_resultado = jyp
            self.df_grupos = grupos
            self.mostrar_dual()

        self.actualizar_rango()
        self.actualizar_kpi_disponibles()
        self._ultimos_filtros = f
        self.lbl_resumen_filtros.config(text="🔎 " + self.texto_filtros(f), fg=T["tinta"])

    def texto_filtros(self, f):
        partes = [self.portafolio.get()]
        if f["estados"]:
            est = ", ".join(e.title() for e in f["estados"][:3])
            if len(f["estados"]) > 3:
                est += f" +{len(f['estados']) - 3}"
            partes.append(est)
        if f["municipios"]:
            mun = ", ".join(m.title() for m in f["municipios"][:2])
            if len(f["municipios"]) > 2:
                mun += f" +{len(f['municipios']) - 2}"
            partes.append(mun)
        else:
            partes.append("todos los municipios")
        if f["mora_min"] is not None or f["mora_max"] is not None:
            de = "0" if f["mora_min"] is None else f"{f['mora_min']:,.0f}"
            a = "∞" if f["mora_max"] is None else f"{f['mora_max']:,.0f}"
            partes.append(f"mora {de}–{a} días")
        if f["terminos"]:
            partes.append(f"búsqueda: {', '.join(f['terminos'][:3])}" + (" …" if len(f["terminos"]) > 3 else ""))
        return "  ·  ".join(partes)

    def limpiar_filtros(self):
        self.lbl_resumen_filtros.config(
            text="Elige Estado(s) o busca una referencia y presiona Aplicar filtros.",
            fg=T["texto_secundario"]
        )
        self.list_estados.selection_clear(0, tk.END)
        self._mun_sel = set()
        self.buscar_municipio.limpiar()
        self.buscar_ref.limpiar()
        self.mora_min.set("")
        self.mora_max.set("")
        self.actualizar_municipios()
        self.df_resultado = pd.DataFrame()
        self.df_grupos = pd.DataFrame()
        self.limpiar_tabla()
        self.actualizar_kpi_disponibles()

    def _filtro_mora(self, serie, f):
        mask = pd.Series(True, index=serie.index)
        if f["mora_min"] is None and f["mora_max"] is None:
            return mask
        valores = pd.to_numeric(serie, errors="coerce")
        if f["mora_min"] is not None:
            mask &= valores >= f["mora_min"]
        if f["mora_max"] is not None:
            mask &= valores <= f["mora_max"]
        return mask.fillna(False)

    def filtrar_jyp(self, f):
        df = self.df_jyp

        if f["estados"]:
            df = df[df["_Estado"].isin(f["estados"])]
        if f["municipios"]:
            df = df[df["_Municipio"].isin(f["municipios"])]
        if f["terminos"]:
            df = df[coincide(df["vReference"], f["terminos"])]

        # Sólo créditos disponibles
        df = df[df["_Estatus"] == "DISPONIBLE"]
        df = df[self._filtro_mora(df["iDays"], f)]

        return df.reset_index(drop=True)

    def generar_grupos_filtrados(self, f):
        df = self.df_grupal

        # Grupos con al menos un integrante dentro del filtro.
        miembros = df
        if f["estados"]:
            miembros = miembros[miembros["_Estado"].isin(f["estados"])]
        if f["municipios"]:
            miembros = miembros[miembros["_Municipio"].isin(f["municipios"])]
        if f["terminos"]:
            miembros = miembros[
                coincide(miembros["vGroupId"], f["terminos"])
                | coincide(miembros["vReference"], f["terminos"])
            ]

        ids = miembros["vGroupId"].replace("", pd.NA).dropna().unique().tolist()

        columnas = ["vGroupId", "Integrantes", "Estados", "Municipios", "Colonias", "Capital",
                    "DiasPromedioMora", "EstatusGrupo", "_Disponible"]
        if not ids:
            return pd.DataFrame(columns=columnas)

        grupos = df[df["vGroupId"].isin(ids)]

        def unir(serie):
            return ", ".join(sorted(x for x in serie.astype(str).unique() if x.strip()))

        res = grupos.groupby("vGroupId", sort=False).agg(
            Integrantes=("vReference", "size"),
            Estados=("Estado", unir),
            Municipios=("Municipio", unir),
            Colonias=("_Colonia", unir),
            Capital=("nPendingK", "sum"),
            DiasPromedioMora=("iDays", lambda s: pd.to_numeric(s, errors="coerce").mean()),
            _Disponible=("_Estatus", lambda s: bool((s == "DISPONIBLE").all())),
        ).reset_index()

        res = res[self._filtro_mora(res["DiasPromedioMora"], f)].reset_index(drop=True)

        res["Capital"] = res["Capital"].astype(float)
        res["DiasPromedioMora"] = res["DiasPromedioMora"].astype(object).where(
            res["DiasPromedioMora"].notna(), None
        )
        res["_Disponible"] = res["_Disponible"].astype(bool)
        res["EstatusGrupo"] = res["_Disponible"].map({True: "DISPONIBLE", False: "BLOQUEADO"})

        return res[columnas]

    # --------------------------------------------------------
    # TABLAS
    # --------------------------------------------------------

    def limpiar_tabla(self):
        hijos = self.tree.get_children()
        if hijos:
            self.tree.delete(*hijos)
        self._marcados = set()
        self.actualizar_seleccion()

    def configurar_columnas(self, columnas):
        columnas = ["Seleccionar"] + list(columnas)
        self.tree["columns"] = columnas

        for col in columnas:
            self.tree.heading(col, text="✓" if col == "Seleccionar" else col,
                              anchor="center" if col == "Seleccionar" else
                              ("e" if col in COLUMNAS_NUMERICAS else "w"))
            if col == "Seleccionar":
                self.tree.column(col, width=W(44), minwidth=W(40), stretch=False, anchor="center")
            elif col in COLUMNAS_NUMERICAS:
                self.tree.column(col, width=W(95), minwidth=W(70), anchor="e")
            else:
                self.tree.column(col, width=W(130), minwidth=W(80), anchor="w")

        if "vReference" in columnas:
            self.tree.column("vReference", width=W(130))
        if "vGroupId" in columnas:
            self.tree.column("vGroupId", width=W(100))
        if "Integrantes" in columnas:
            self.tree.column("Integrantes", width=W(80))

    def _tags(self, n, disponible=True):
        tags = []
        if n % 2:
            tags.append("impar")
        tags.append("disponible" if disponible else "bloqueado")
        return tuple(tags)

    def mostrar_jyp(self):
        self.limpiar_tabla()

        columnas = ["vReference", "Estado", "Municipio", "Colonia", "iDays", "nPendingK", "Estatus"]
        self.configurar_columnas(columnas)

        for n, (idx, row) in enumerate(self.df_resultado.iterrows()):
            self.tree.insert(
                "", "end", iid=f"JYP|{idx}", tags=self._tags(n),
                values=(
                    "☐", row["vReference"], row["Estado"], row["Municipio"], row["_Colonia"],
                    mora_mostrada(row["iDays"]), capital_mostrado(row["nPendingK"]),
                    row["Estatus"]
                )
            )
        self.lbl_tabla.config(text=f"DETALLE · CRÉDITOS JyP ({len(self.df_resultado):,})")

    def _insertar_grupos(self, dual=False, inicio=0):
        for n, (idx, row) in enumerate(self.df_grupos.iterrows(), start=inicio):
            marca = "☐" if row["_Disponible"] else "—"
            if dual:
                valores = (
                    marca, "Grupal", row["vGroupId"], row["Estados"], row["Municipios"],
                    row["Colonias"], row["Integrantes"], mora_mostrada(row["DiasPromedioMora"]),
                    capital_mostrado(row["Capital"]), row["EstatusGrupo"]
                )
            else:
                valores = (
                    marca, row["vGroupId"], row["Integrantes"], row["Estados"],
                    row["Municipios"], row["Colonias"], mora_mostrada(row["DiasPromedioMora"]),
                    capital_mostrado(row["Capital"]), row["EstatusGrupo"]
                )
            self.tree.insert("", "end", iid=f"GRP|{idx}", tags=self._tags(n, row["_Disponible"]), values=valores)

    def mostrar_grupal(self):
        self.limpiar_tabla()

        columnas = ["vGroupId", "Integrantes", "Estados", "Municipios", "Colonias",
                    "DiasPromedioMora", "Capital", "EstatusGrupo"]
        self.configurar_columnas(columnas)
        self._insertar_grupos(dual=False)
        bloq = int((~self.df_grupos["_Disponible"]).sum()) if not self.df_grupos.empty else 0
        self.lbl_tabla.config(
            text=f"DETALLE · GRUPOS ({len(self.df_grupos):,})" + (f" · {bloq:,} bloqueados" if bloq else "")
        )

    def mostrar_dual(self):
        self.limpiar_tabla()

        columnas = ["TipoCartera", "Identificador", "Estado", "Municipio", "Colonia",
                    "Integrantes", "iDays / Mora", "Capital", "Estatus"]
        self.configurar_columnas(columnas)

        for n, (idx, row) in enumerate(self.df_resultado.iterrows()):
            self.tree.insert(
                "", "end", iid=f"JYP|{idx}", tags=self._tags(n),
                values=(
                    "☐", "JyP", row["vReference"], row["Estado"], row["Municipio"], row["_Colonia"], 1,
                    mora_mostrada(row["iDays"]), capital_mostrado(row["nPendingK"]),
                    row["Estatus"]
                )
            )

        self._insertar_grupos(dual=True, inicio=len(self.df_resultado))
        self.lbl_tabla.config(
            text=f"DETALLE · DUAL ({len(self.df_resultado):,} JyP + {len(self.df_grupos):,} grupos)"
        )

    # --------------------------------------------------------
    # SELECCIÓN
    # --------------------------------------------------------

    def _es_bloqueado(self, item):
        return "bloqueado" in self.tree.item(item, "tags")

    def manejar_click_tabla(self, event):
        item = self.tree.identify_row(event.y)
        columna = self.tree.identify_column(event.x)

        if not item:
            return

        if self._es_bloqueado(item):
            self.tree.selection_remove(item)
            return "break"

        # Primera columna: casilla.
        if columna == "#1":
            if item in self._marcados:
                self.tree.selection_remove(item)
            else:
                self.tree.selection_add(item)
            self.actualizar_seleccion()
            return "break"

    def seleccionar_todos(self):
        disponibles = [i for i in self.tree.get_children() if not self._es_bloqueado(i)]
        if disponibles:
            self.tree.selection_set(disponibles)
        self.actualizar_seleccion()

    def seleccionar_items(self, items):
        if items:
            self.tree.selection_set(items)
            self.tree.see(items[0])
        else:
            self.tree.selection_remove(self.tree.selection())
        self.actualizar_seleccion()

    def actualizar_seleccion(self, event=None):
        if getattr(self, "tree", None) is None:
            return

        bloqueados = [i for i in self.tree.selection() if i.startswith("GRP|") and self._es_bloqueado(i)]
        if bloqueados:
            self.tree.selection_remove(bloqueados)

        actuales = set(self.tree.selection())
        for item in actuales - self._marcados:
            if self.tree.exists(item):
                self.tree.set(item, "Seleccionar", "☑")
        for item in self._marcados - actuales:
            if self.tree.exists(item):
                self.tree.set(item, "Seleccionar", "☐")
        self._marcados = actuales

        try:
            seleccion = self.obtener_seleccion()
        except Exception:
            seleccion = pd.DataFrame()

        capital = float(seleccion["nPendingK"].sum()) if not seleccion.empty else 0.0
        try:
            centavos = float(self.centavos.get())
        except Exception:
            centavos = 0.0
        try:
            objetivo = float(self.capital_objetivo.get())
        except Exception:
            objetivo = 0.0
        minimo, maximo = max(0, objetivo - RANGO_ABAJO), objetivo + RANGO_ARRIBA

        if capital <= 0:
            self.set_kpi("capital", capital_mostrado(0), f"Objetivo {capital_mostrado(objetivo)}")
        elif capital < minimo:
            self.set_kpi("capital", capital_mostrado(capital),
                         f"Faltan {capital_mostrado(minimo - capital)} para el mínimo", "warn")
        elif capital > maximo:
            self.set_kpi("capital", capital_mostrado(capital),
                         f"Excede {capital_mostrado(capital - maximo)} el máximo", "bad")
        else:
            self.set_kpi("capital", capital_mostrado(capital), "✔ Dentro del rango", "good")

        self.set_kpi("venta", capital_mostrado(capital * centavos), f"{centavos:.4f} centavos por peso")
        mora = promedio_mora(seleccion)
        self.set_kpi("mora", mora_mostrada(mora), "Promedio simple de iDays")

        jyp = int((seleccion["TipoCartera"] == "JyP").sum()) if not seleccion.empty else 0
        grp = len([i for i in actuales if i.startswith("GRP|")])
        integ = int((seleccion["TipoCartera"] == "Grupal").sum()) if not seleccion.empty else 0
        partes = []
        if jyp:
            partes.append(f"{jyp:,} JyP")
        if grp:
            partes.append(f"{grp:,} grupos · {integ:,} integrantes")
        self.set_kpi("partidas", f"{len(actuales):,}", " + ".join(partes) or "Sin selección")

    def actualizar_kpi_disponibles(self):
        n = len(self.tree.get_children()) if getattr(self, "tree", None) else 0
        cap = 0.0
        if not self.df_resultado.empty:
            cap += float(self.df_resultado["nPendingK"].sum())
        if not self.df_grupos.empty:
            cap += float(self.df_grupos.loc[self.df_grupos["_Disponible"].astype(bool), "Capital"].sum())
        self.set_kpi(
            "disp", f"{n:,}",
            f"Capital {capital_mostrado(cap)}" if n else "Aplica filtros para ver registros"
        )

    def obtener_seleccion(self):
        """
        Construye la selección sin asumir que JyP tiene vGroupId.
        Grupal: incluye TODOS los integrantes de cada grupo.
        """
        items = self.tree.selection()

        if not items:
            return pd.DataFrame()

        idx_jyp, pos_grupal = [], []

        for item in items:
            tipo, _, num = item.partition("|")
            idx = int(num)

            if tipo == "JYP":
                if idx < len(self.df_resultado):
                    idx_jyp.append(idx)

            elif tipo == "GRP":
                if idx >= len(self.df_grupos):
                    continue
                resumen = self.df_grupos.iloc[idx]
                if not bool(resumen["_Disponible"]):
                    continue
                pos = self._pos_grupo.get(str(resumen["vGroupId"]))
                if pos is not None:
                    pos_grupal.extend(pos.tolist())

        partes = []
        if idx_jyp:
            jyp = self.df_resultado.iloc[sorted(idx_jyp)].copy()
            jyp["TipoCartera"] = "JyP"
            partes.append(jyp)
        if pos_grupal:
            grupo = self.df_grupal.iloc[pos_grupal].copy()
            grupo["TipoCartera"] = "Grupal"
            partes.append(grupo)

        if not partes:
            return pd.DataFrame()

        return pd.concat(partes, ignore_index=True)

    def limpiar_seleccion(self):
        self.tree.selection_remove(self.tree.selection())
        self.actualizar_seleccion()

    # --------------------------------------------------------
    # SUGERIR PROPUESTA
    # --------------------------------------------------------

    def candidatos_tabla(self):
        filas = []
        if not self.df_resultado.empty:
            for idx, row in self.df_resultado.iterrows():
                iid = f"JYP|{idx}"
                if self.tree.exists(iid):
                    filas.append((iid, float(row["nPendingK"]), row["iDays"]))
        if not self.df_grupos.empty:
            for idx, row in self.df_grupos.iterrows():
                iid = f"GRP|{idx}"
                if row["_Disponible"] and self.tree.exists(iid):
                    filas.append((iid, float(row["Capital"]), row["DiasPromedioMora"]))
        return pd.DataFrame(filas, columns=["iid", "Capital", "Mora"])

    def sugerir(self):
        if not self.tree.get_children():
            messagebox.showwarning("Sugerir propuesta", "Primero aplica los filtros.")
            return
        try:
            objetivo = float(self.capital_objetivo.get())
            if objetivo <= 0:
                raise ValueError
        except Exception:
            messagebox.showerror("Capital inválido", "Captura un capital objetivo mayor a cero.")
            return

        minimo, maximo = max(0, objetivo - RANGO_ABAJO), objetivo + RANGO_ARRIBA
        candidatos = self.candidatos_tabla()
        elegidos, total = sugerir_propuesta(candidatos, objetivo, minimo, maximo, self.prioridad.get())

        self.seleccionar_items(elegidos)

        if minimo <= total <= maximo:
            messagebox.showinfo(
                "Sugerir propuesta",
                f"Se seleccionaron {len(elegidos):,} partidas por {capital_mostrado(total)} "
                f"({self.prioridad.get().lower()}).\n\n"
                "Puedes ajustar con las casillas y después usar Validar y apartar."
            )
        else:
            disponible = float(candidatos["Capital"].sum()) if not candidatos.empty else 0.0
            messagebox.showwarning(
                "Sugerir propuesta",
                f"No se logró caer en el rango {capital_mostrado(minimo)} - {capital_mostrado(maximo)}.\n\n"
                f"Mejor combinación: {capital_mostrado(total)}.\n"
                f"Capital disponible en el filtro: {capital_mostrado(disponible)}.\n\n"
                "Amplía Estados/Municipios, cambia la prioridad o ajusta el objetivo."
            )

    # --------------------------------------------------------
    # RANGO
    # --------------------------------------------------------

    def al_cambiar_capital(self):
        self.actualizar_rango()
        self.actualizar_seleccion()

    def actualizar_rango(self):
        try:
            objetivo = float(self.capital_objetivo.get())
        except Exception:
            objetivo = 0

        minimo = max(0, objetivo - RANGO_ABAJO)
        maximo = objetivo + RANGO_ARRIBA

        self.lbl_rango.config(text=f"{capital_mostrado(minimo)}  a  {capital_mostrado(maximo)}")

    # --------------------------------------------------------
    # VALIDACIÓN FINAL
    # --------------------------------------------------------

    def validar_actualidad(self, seleccion):
        """
        Vuelve a leer los apartados de todos los usuarios (y las bases si
        cambiaron) y confirma que la selección siga disponible.
        """
        if "TipoCartera" not in seleccion.columns:
            return False, "La selección no contiene el tipo de cartera."

        if self._mtime_bases() != self._mtime_cargado:
            self.cargar_bases()
        else:
            self.aplicar_apartados()

        refs, grupos = ids_de_seleccion(seleccion)

        if refs:
            actual = self.df_jyp[self.df_jyp["vReference"].isin(refs)]
            if actual["vReference"].nunique() != len(refs):
                return False, "Uno o más créditos JyP ya no existen en la base."
            tomados = actual.loc[actual["_Estatus"] != "DISPONIBLE", "vReference"].unique().tolist()
            if tomados:
                return False, (
                    "Estos créditos JyP ya no están disponibles (otro usuario los apartó):\n"
                    + ", ".join(tomados[:15])
                )

        malos = []
        for gid in grupos:
            pos = self._pos_grupo.get(gid)
            if pos is None:
                return False, f"El grupo {gid} ya no existe."
            if not bool((self.df_grupal.iloc[pos]["_Estatus"] == "DISPONIBLE").all()):
                malos.append(gid)
        if malos:
            return False, (
                "Estos grupos ya no están completamente disponibles (otro usuario los apartó):\n"
                + ", ".join(malos[:15])
            )

        return True, "OK"

    def validar_y_apartar(self):
        try:
            objetivo = float(self.capital_objetivo.get())
            centavos = float(self.centavos.get())
        except Exception:
            messagebox.showerror("Datos inválidos", "Capital objetivo y centavos deben ser numéricos.")
            return

        seleccion = self.obtener_seleccion()

        if seleccion.empty:
            messagebox.showwarning("Selección", "Selecciona al menos un crédito o grupo.")
            return

        capital = float(seleccion["nPendingK"].sum())
        minimo = max(0, objetivo - RANGO_ABAJO)
        maximo = objetivo + RANGO_ARRIBA

        if capital < minimo or capital > maximo:
            messagebox.showwarning(
                "Capital fuera de rango",
                f"El capital seleccionado es {capital_mostrado(capital)}.\n\n"
                f"Debe quedar entre {capital_mostrado(minimo)} y {capital_mostrado(maximo)}."
            )
            return

        ok, mensaje = self.validar_actualidad(seleccion)
        if not ok:
            messagebox.showerror("Validación final", mensaje)
            self.aplicar_filtros(silencioso=True)
            return

        venta = capital * centavos
        mora = promedio_mora(seleccion)

        detalle = (
            f"Usuario Windows: {self.usuario_windows}\n"
            f"Equipo: {self.equipo_windows}\n"
            f"Capital seleccionado: {capital_mostrado(capital)}\n"
            f"Centavos por peso: {centavos:.4f}\n"
            f"Valor de venta: {capital_mostrado(venta)}\n"
            f"Registros: {len(seleccion):,}"
        )

        if not messagebox.askyesno(
            "Apartar propuesta",
            "¿Quieres apartar estos créditos/grupos?\n\n" + detalle
        ):
            return

        propuesta_id = (
            "PV-" + datetime.now().strftime("%Y%m%d-%H%M%S")
            + "-" + uuid.uuid4().hex[:6].upper()
        )

        carpeta_inicial = os.path.join(os.path.expanduser("~"), "Documents")
        if not os.path.isdir(carpeta_inicial):
            carpeta_inicial = os.path.expanduser("~")
        ruta = filedialog.asksaveasfilename(
            title="Guardar propuesta para Funnel",
            initialdir=carpeta_inicial,
            initialfile=f"{propuesta_id}.csv",
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")]
        )
        if not ruta:
            return

        # Última revisión justo antes de registrar (pudo pasar tiempo en el diálogo).
        ok, mensaje = self.validar_actualidad(seleccion)
        if not ok:
            messagebox.showerror("Validación final", "No se apartó nada.\n\n" + mensaje)
            self.aplicar_filtros(silencioso=True)
            return

        # Milisegundos para ordenar bien dos apartados del mismo segundo.
        ahora = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        registro = pd.DataFrame({
            "IdPropuesta": propuesta_id,
            "FechaPropuesta": ahora,
            "UsuarioWindows": self.usuario_windows,
            "EquipoWindows": self.equipo_windows,
            "TipoVenta": self.portafolio.get(),
            "TipoCartera": seleccion["TipoCartera"].astype(str).values,
            "vReference": seleccion["vReference"].astype(str).values,
            "vGroupId": (
                seleccion["vGroupId"].fillna("").astype(str).values
                if "vGroupId" in seleccion.columns else ""
            ),
            "nPendingK": seleccion["nPendingK"].round(2).values,
            "CapitalObjetivo": f"{objetivo:.2f}",
            "CapitalSeleccionado": f"{capital:.2f}",
            "CentavosPorPeso": f"{centavos:.4f}",
            "ValorVenta": f"{venta:.2f}",
            "DiasPromedioMora": "" if mora is None else f"{mora:.1f}",
            "ArchivoFunnel": ruta,
        })[COLUMNAS_APARTADO]

        archivo_apartado = os.path.join(
            DIR_APARTADOS, f"{propuesta_id}_{_nombre_seguro(self.usuario_windows)}.csv"
        )

        try:
            guardar_registro_nuevo(registro, archivo_apartado)
        except Exception as exc:
            messagebox.showerror(
                "No se pudo apartar",
                f"No fue posible registrar el apartado en la carpeta compartida.\n\n{exc}\n\n"
                "Revisa que OneDrive esté sincronizando y que tengas permiso de edición."
            )
            return

        try:
            salida = self.armar_salida(seleccion, propuesta_id, objetivo, centavos)
            salida.to_csv(ruta, index=False, encoding="latin-1", errors="replace")
            try:
                os.makedirs(DIR_REGISTRADAS, exist_ok=True)
                salida.to_csv(
                    os.path.join(DIR_REGISTRADAS, f"{propuesta_id}.csv"),
                    index=False, encoding="latin-1", errors="replace"
                )
            except Exception:
                pass  # la copia es opcional; el apartado y el archivo Funnel ya existen
        except Exception as exc:
            try:
                os.remove(archivo_apartado)
                revertido = "El apartado se canceló; los registros siguen Disponibles."
            except Exception as exc2:
                revertido = f"ATENCIÓN: no se pudo cancelar el apartado: {exc2}"
            messagebox.showerror(
                "Error al generar la propuesta",
                f"No fue posible guardar el archivo para Funnel.\n\n{exc}\n\n{revertido}"
            )
            self.aplicar_apartados()
            self.aplicar_filtros(silencioso=True)
            return

        self.aplicar_apartados()
        self.aplicar_filtros(silencioso=True)

        res = self.apartados["resumen"]
        fila = res[res["IdPropuesta"] == propuesta_id] if not res.empty else res
        if not fila.empty and fila.iloc[0]["EstatusPropuesta"] == "EN CONFLICTO":
            messagebox.showwarning(
                "Propuesta en conflicto",
                "Se generó la propuesta, pero otro usuario apartó parte de estos registros "
                "unos instantes antes.\n\n"
                f"{fila.iloc[0]['Conflicto']}\n\n"
                "No la envíes a Funnel. Libérala desde Bitácora y arma una nueva."
            )
            return

        messagebox.showinfo(
            "Propuesta apartada",
            "La propuesta fue generada y los registros quedaron "
            f"apartados como {ESTATUS_APARTADO}.\n\n"
            f"Id: {propuesta_id}\nArchivo:\n{ruta}"
        )

    def recargar_vista_silenciosa(self):
        """Recarga bases y apartados y vuelve a aplicar filtros sin mensajes."""
        try:
            self.cargar_bases()
            if self.tree.get_children() or self.estados_elegidos():
                self.aplicar_filtros(silencioso=True)
            self.lbl_actualizacion.config(text="Bases recargadas " + datetime.now().strftime("%H:%M"))
        except Exception:
            pass

    def armar_salida(self, seleccion, propuesta_id, objetivo, centavos):
        salida = seleccion.copy()
        capital = float(seleccion["nPendingK"].sum())

        salida["IdPropuesta"] = propuesta_id
        salida["UsuarioWindows"] = self.usuario_windows
        salida["EquipoWindows"] = self.equipo_windows
        salida["FechaPropuesta"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        salida["CapitalObjetivo"] = objetivo
        salida["CentavosPorPeso"] = centavos
        salida["CapitalSeleccionadoPropuesta"] = capital
        salida["ValorVentaPropuesta"] = capital * centavos
        salida["DiasPromedioMoraPropuesta"] = promedio_mora(seleccion)
        salida["EstatusPropuesta"] = "APARTADA"
        salida["Estatus"] = ESTATUS_APARTADO

        tecnicas = ["_Estado", "_Municipio", "_Estatus", "_Disponible", "_Colonia"]
        return salida.drop(columns=[c for c in tecnicas if c in salida.columns])

    # --------------------------------------------------------
    # BITÁCORA / LIBERAR
    # --------------------------------------------------------

    def abrir_bitacora(self):
        VentanaBitacora(self)

    def puede_liberar(self, fila):
        return self.es_admin or str(fila["UsuarioWindows"]).upper() == self.usuario_windows.upper()

    def liberar_propuesta(self, propuesta_id, motivo=""):
        """Registra la liberación en un archivo nuevo; los registros vuelven a Disponible."""
        self.aplicar_apartados()
        res = self.apartados["resumen"]
        fila = res[res["IdPropuesta"] == propuesta_id] if not res.empty else res
        if fila.empty:
            raise ValueError(f"No existe la propuesta {propuesta_id}.")
        fila = fila.iloc[0]
        if fila["EstatusPropuesta"] == "LIBERADA":
            raise ValueError("Esa propuesta ya fue liberada.")
        if not self.puede_liberar(fila):
            raise PermissionError(
                f"Sólo {fila['UsuarioWindows']} o un administrador pueden liberar esta propuesta."
            )

        ahora = datetime.now()
        lib = pd.DataFrame([{
            "IdPropuesta": propuesta_id,
            "FechaLiberacion": ahora.strftime("%Y-%m-%d %H:%M:%S"),
            "UsuarioLibera": self.usuario_windows,
            "EquipoLibera": self.equipo_windows,
            "MotivoLiberacion": motivo,
        }])[COLUMNAS_LIBERACION]
        guardar_registro_nuevo(
            lib,
            os.path.join(
                DIR_LIBERACIONES,
                f"LIB-{propuesta_id}_{_nombre_seguro(self.usuario_windows)}_{ahora:%Y%m%d%H%M%S}.csv"
            )
        )

        self.aplicar_apartados()
        if self.tree.get_children():
            self.aplicar_filtros(silencioso=True)
        return {"jyp": int(fila["CreditosJyP"]), "grupal": int(fila["GruposGrupal"])}


class VentanaBitacora:

    def __init__(self, app):
        self.app = app
        self.win = tk.Toplevel(app.root)
        self.win.title("Bitácora de propuestas")
        self.win.geometry(
            f"{min(W(1300), app.root.winfo_screenwidth() - 60)}x"
            f"{min(W(600), app.root.winfo_screenheight() - 120)}"
        )
        self.win.configure(bg=T["fondo_pagina"])
        self.win.transient(app.root)

        header = tk.Frame(self.win, bg=T["tinta"])
        header.pack(fill="x")
        tk.Label(
            header, text="📋 Bitácora de propuestas", bg=T["tinta"], fg=T["blanco"],
            font=F(20, "bold"), padx=18, pady=10
        ).pack(side="left")
        tk.Label(
            header,
            text="Administrador: puedes liberar cualquier propuesta" if app.es_admin
            else "Puedes liberar sólo tus propuestas",
            bg=T["tinta"], fg=T["texto_sobre_oscuro"], font=F(12.5), padx=18
        ).pack(side="right")
        tk.Frame(self.win, bg=T["rojo"], height=3).pack(fill="x")

        cuerpo = tarjeta(self.win, None, fill="both", expand=True, padx=14, pady=12)

        barra = tk.Frame(cuerpo, bg=T["blanco"])
        barra.pack(fill="x", pady=(0, 8))

        self.solo_vigentes = tk.BooleanVar(value=True)
        self.solo_mias = tk.BooleanVar(value=not app.es_admin)
        for texto, var in (("Sólo vigentes", self.solo_vigentes), ("Sólo mías", self.solo_mias)):
            tk.Checkbutton(
                barra, text=texto, variable=var, command=self.cargar,
                bg=T["blanco"], fg=T["tinta"], activebackground=T["blanco"],
                selectcolor=T["blanco"], font=F(13, "bold")
            ).pack(side="left", padx=(0, 10))

        boton(barra, "Liberar seleccionada", self.liberar_seleccionada, "marca").pack(side="left", padx=(8, 6))
        if app.es_admin:
            boton(barra, "➕ Importar anteriores", self.importar, "secundario").pack(side="left", padx=(0, 6))
        boton(barra, "⬇ Exportar bitácora", self.exportar, "secundario").pack(side="left", padx=(0, 6))
        boton(barra, "📂 Abrir carpeta", self.abrir_carpeta, "secundario").pack(side="left")

        self.lbl = tk.Label(barra, text="", bg=T["blanco"], fg=T["texto_secundario"], font=F(12.5, "bold"))
        self.lbl.pack(side="right")

        frame = tk.Frame(cuerpo, bg=T["blanco"])
        frame.pack(fill="both", expand=True)

        self.cols = ["IdPropuesta", "FechaPropuesta", "UsuarioWindows", "TipoVenta",
                     "CreditosJyP", "GruposGrupal", "CapitalSeleccionado", "ValorVenta",
                     "DiasPromedioMora", "EstatusPropuesta", "FechaLiberacion", "UsuarioLibera",
                     "Conflicto"]
        numericas = {"CreditosJyP", "GruposGrupal", "CapitalSeleccionado", "ValorVenta", "DiasPromedioMora"}
        self.tree = ttk.Treeview(frame, columns=self.cols, show="headings", selectmode="browse")
        for c in self.cols:
            self.tree.heading(c, text=c, anchor="e" if c in numericas else "w")
            self.tree.column(c, width=W(105), anchor="e" if c in numericas else "w")
        self.tree.column("IdPropuesta", width=W(210))
        self.tree.column("FechaPropuesta", width=W(150))
        self.tree.column("FechaLiberacion", width=W(150))
        self.tree.column("EstatusPropuesta", width=W(125))
        self.tree.column("Conflicto", width=W(300))
        self.tree.tag_configure("impar", background=T["fondo_fila_hover"])
        self.tree.tag_configure("liberada", foreground=T["gris_suave"])
        self.tree.tag_configure("conflicto", foreground=T["rojo"], background=T["rojo_suave"])

        sy = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        sx = ttk.Scrollbar(frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=sy.set, xscrollcommand=sx.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        sy.grid(row=0, column=1, sticky="ns")
        sx.grid(row=1, column=0, sticky="ew")
        frame.grid_rowconfigure(0, weight=1)
        frame.grid_columnconfigure(0, weight=1)

        self.cargar()

    def _datos(self):
        self.app.aplicar_apartados()
        bit = self.app.apartados["resumen"]
        if bit.empty:
            return bit
        if self.solo_vigentes.get():
            bit = bit[bit["EstatusPropuesta"] != "LIBERADA"]
        if self.solo_mias.get():
            bit = bit[bit["UsuarioWindows"].astype(str).str.upper() == self.app.usuario_windows.upper()]
        return bit.iloc[::-1]

    def cargar(self):
        hijos = self.tree.get_children()
        if hijos:
            self.tree.delete(*hijos)
        try:
            bit = self._datos()
        except Exception as exc:
            messagebox.showerror("Bitácora", str(exc), parent=self.win)
            return

        for n, (_, r) in enumerate(bit.iterrows()):
            valores = []
            for c in self.cols:
                v = r.get(c, "")
                if c in ("CapitalSeleccionado", "ValorVenta"):
                    v = capital_mostrado(float(v or 0))
                valores.append(v)
            tags = ["impar"] if n % 2 else []
            if r["EstatusPropuesta"] == "LIBERADA":
                tags.append("liberada")
            elif r["EstatusPropuesta"] == "EN CONFLICTO":
                tags.append("conflicto")
            self.tree.insert("", "end", iid=r["IdPropuesta"], values=valores, tags=tuple(tags))

        conflictos = int((bit["EstatusPropuesta"] == "EN CONFLICTO").sum()) if not bit.empty else 0
        texto = f"{len(bit):,} propuestas"
        if conflictos:
            texto += f" · {conflictos} en conflicto"
        self.lbl.config(text=texto, fg=T["rojo"] if conflictos else T["texto_secundario"])

    def liberar_seleccionada(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showwarning("Liberar", "Selecciona una propuesta.", parent=self.win)
            return
        pid = sel[0]
        if not messagebox.askyesno(
            "Liberar propuesta",
            f"¿Regresar a Disponible todos los registros de {pid}?\n\n"
            "Úsalo cuando la propuesta se canceló o quedó en conflicto.",
            parent=self.win
        ):
            return
        motivo = simpledialog.askstring(
            "Liberar propuesta", "Motivo de la liberación (opcional):", parent=self.win
        )
        if motivo is None:
            return
        try:
            res = self.app.liberar_propuesta(pid, motivo=motivo)
        except Exception as exc:
            messagebox.showerror("Liberar", str(exc), parent=self.win)
            return
        messagebox.showinfo(
            "Propuesta liberada",
            f"Regresaron a Disponible:\n• JyP: {res['jyp']:,} créditos\n• Grupal: {res['grupal']:,} grupos",
            parent=self.win
        )
        self.cargar()

    def importar(self):
        """Registra propuestas hechas antes de v9 (CSV de Funnel o lista de referencias)."""
        rutas = filedialog.askopenfilenames(
            title="Propuestas anteriores a registrar (CSV)", parent=self.win,
            filetypes=[("CSV", "*.csv")]
        )
        if not rutas:
            return

        app = self.app
        app.aplicar_apartados()
        existentes = set(app.apartados["resumen"]["IdPropuesta"]) if not app.apartados["resumen"].empty else set()

        preparadas, errores = [], []
        for ruta in rutas:
            try:
                reg, res = preparar_importacion(
                    ruta, app.df_jyp, app.df_grupal, app.usuario_windows, existentes,
                    app.apartados["jyp"], app.apartados["grupos"]
                )
            except Exception as exc:
                errores.append(f"• {os.path.basename(ruta)}: {exc}")
                continue
            if res.get("duplicada"):
                errores.append(f"• {os.path.basename(ruta)}: {res['id']} ya estaba registrada.")
                continue
            existentes.add(res["id"])
            preparadas.append((reg, res))

        if not preparadas:
            messagebox.showwarning("Importar", "No se registró nada.\n\n" + "\n".join(errores), parent=self.win)
            return

        lineas = []
        for _, r in preparadas:
            linea = (
                f"• {r['archivo']}\n   {r['usuario']} · {r['fecha']}\n"
                f"   {r['jyp']:,} JyP + {r['grupos']:,} grupos ({r['integrantes']:,} integrantes) · "
                f"{capital_mostrado(r['capital'])}"
            )
            if r["en_base"]:
                linea += f"\n   ✔ {r['en_base']:,} ya marcados Propuesta/Venta en la base (normal)"
            if r["en_otra"]:
                linea += f"\n   ⚠ {r['en_otra']:,} ya están en otra propuesta registrada → EN CONFLICTO"
            if r["no_encontrados"]:
                linea += f"\n   ⚠ {len(r['no_encontrados']):,} no existen en las bases y se omiten"
            lineas.append(linea)
        texto = "Se registrarán como APARTADAS:\n\n" + "\n\n".join(lineas)
        if errores:
            texto += "\n\nNo se importan:\n" + "\n".join(errores)
        texto += "\n\nLo que ya estaba apartado en otra propuesta quedará EN CONFLICTO para que lo revises.\n¿Continuar?"

        if not messagebox.askyesno("Importar propuestas anteriores", texto, parent=self.win):
            return

        hechas = 0
        for reg, r in preparadas:
            try:
                guardar_registro_nuevo(
                    reg, os.path.join(DIR_APARTADOS, f"{r['id']}_importada-{_nombre_seguro(app.usuario_windows)}.csv")
                )
                hechas += 1
            except Exception as exc:
                errores.append(f"• {r['archivo']}: {exc}")

        app.aplicar_apartados()
        if app.tree.get_children():
            app.aplicar_filtros(silencioso=True)
        self.solo_vigentes.set(True)
        self.solo_mias.set(False)
        self.cargar()
        messagebox.showinfo(
            "Importar", f"Se registraron {hechas} propuesta(s)."
            + ("\n\nCon problemas:\n" + "\n".join(errores) if errores else ""),
            parent=self.win
        )

    def exportar(self):
        bit = self.app.apartados["resumen"]
        if bit.empty:
            messagebox.showinfo("Exportar", "Todavía no hay propuestas.", parent=self.win)
            return
        ruta = filedialog.asksaveasfilename(
            title="Exportar bitácora", parent=self.win,
            initialfile=f"Bitacora_VentaCartera_{datetime.now():%Y%m%d}.csv",
            defaultextension=".csv", filetypes=[("CSV", "*.csv")]
        )
        if not ruta:
            return
        try:
            bit.to_csv(ruta, index=False, encoding="utf-8-sig")
        except Exception as exc:
            messagebox.showerror("Exportar", str(exc), parent=self.win)
            return
        messagebox.showinfo("Exportar", f"Bitácora guardada en:\n{ruta}", parent=self.win)

    def abrir_carpeta(self):
        os.makedirs(DIR_APARTADOS, exist_ok=True)
        try:
            os.startfile(DIR_APARTADOS)  # Windows
        except Exception:
            messagebox.showinfo("Carpeta", DIR_APARTADOS, parent=self.win)


def main():
    try:
        try:
            # Nitidez en pantallas con escala de Windows (125%, 150%).
            from ctypes import windll
            windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
        root = tk.Tk()
        app = VentaCarteraApp(root)
        root.mainloop()
    except Exception as exc:
        try:
            messagebox.showerror("Error de la aplicación", str(exc))
        except Exception:
            print(exc)


if __name__ == "__main__":
    main()
