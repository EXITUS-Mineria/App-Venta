-- ============================================================
-- ESTADOS CON EL MISMO NOMBRE EN TODAS LAS BASES
--  Las bases traen el mismo estado escrito de varias formas ("MEXICO", "México", "MÉXICO";
--  "CDMX" y "DISTRITO FEDERAL"; "VERACRUZ" y "Veracruz de Ignacio de la Llave"...).
--  Se deja el nombre oficial (INEGI) en MAYÚSCULAS con acentos, en:
--    BASE_JYP, BASE_GRUPAL (columna "Estado") y el índice cartera_jyp / cartera_grupal.
--  Un trigger lo hace solo en cada carga nueva; un estado que no reconoce se queda como viene.
-- Requiere 21 y 25 (_clave_nombre). Idempotente.
-- ============================================================
create table if not exists public.estados_oficiales (
    clave  text primary key,          -- _clave_nombre(variante)
    nombre text not null              -- nombre oficial
);
alter table public.estados_oficiales enable row level security;
revoke all on public.estados_oficiales from anon, authenticated;

insert into public.estados_oficiales (clave, nombre)
select public._clave_nombre(v), n from (values
    ('AGUASCALIENTES', 'AGUASCALIENTES'), ('BAJA CALIFORNIA', 'BAJA CALIFORNIA'), ('BAJA CALIFORNIA NORTE', 'BAJA CALIFORNIA'),
    ('BAJA CALIFORNIA SUR', 'BAJA CALIFORNIA SUR'), ('CAMPECHE', 'CAMPECHE'),
    ('CHIAPAS', 'CHIAPAS'), ('CHIHUAHUA', 'CHIHUAHUA'),
    ('CIUDAD DE MEXICO', 'CIUDAD DE MÉXICO'), ('CDMX', 'CIUDAD DE MÉXICO'), ('CD MX', 'CIUDAD DE MÉXICO'),
    ('DISTRITO FEDERAL', 'CIUDAD DE MÉXICO'), ('DF', 'CIUDAD DE MÉXICO'), ('D.F.', 'CIUDAD DE MÉXICO'),
    ('COAHUILA', 'COAHUILA DE ZARAGOZA'), ('COAHUILA DE ZARAGOZA', 'COAHUILA DE ZARAGOZA'), ('COLIMA', 'COLIMA'),
    ('DURANGO', 'DURANGO'), ('GUANAJUATO', 'GUANAJUATO'), ('GUERRERO', 'GUERRERO'), ('HIDALGO', 'HIDALGO'),
    ('JALISCO', 'JALISCO'), ('MEXICO', 'MÉXICO'), ('ESTADO DE MEXICO', 'MÉXICO'), ('EDO MEX', 'MÉXICO'),
    ('EDO. DE MEXICO', 'MÉXICO'), ('EDOMEX', 'MÉXICO'),
    ('MICHOACAN', 'MICHOACÁN DE OCAMPO'), ('MICHOACAN DE OCAMPO', 'MICHOACÁN DE OCAMPO'),
    ('MORELOS', 'MORELOS'), ('NAYARIT', 'NAYARIT'), ('NUEVO LEON', 'NUEVO LEÓN'), ('OAXACA', 'OAXACA'),
    ('PUEBLA', 'PUEBLA'), ('QUERETARO', 'QUERÉTARO'), ('QUERETARO DE ARTEAGA', 'QUERÉTARO'),
    ('QUINTANA ROO', 'QUINTANA ROO'), ('SAN LUIS POTOSI', 'SAN LUIS POTOSÍ'), ('SINALOA', 'SINALOA'),
    ('SONORA', 'SONORA'), ('TABASCO', 'TABASCO'), ('TAMAULIPAS', 'TAMAULIPAS'), ('TLAXCALA', 'TLAXCALA'),
    ('VERACRUZ', 'VERACRUZ DE IGNACIO DE LA LLAVE'), ('VERACRUZ DE IGNACIO DE LA LLAVE', 'VERACRUZ DE IGNACIO DE LA LLAVE'),
    ('VERACRUZ LLAVE', 'VERACRUZ DE IGNACIO DE LA LLAVE'),
    ('YUCATAN', 'YUCATÁN'), ('ZACATECAS', 'ZACATECAS')) as t (v, n)
on conflict (clave) do update set nombre = excluded.nombre;

-- Nombre oficial del estado (si no lo reconoce, lo deja como viene)
create or replace function public._estado_oficial(p text) returns text
language sql stable security definer set search_path = public as $$
    select coalesce((select e.nombre from public.estados_oficiales e where e.clave = public._clave_nombre(p)), p)
$$;
revoke all on function public._estado_oficial(text) from public, anon, authenticated;

-- Triggers: cada carga nueva queda con el nombre oficial
create or replace function public._tg_estado_base() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    new."Estado" := public._estado_oficial(new."Estado");
    return new;
end $$;
create or replace function public._tg_estado_cartera() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    new.estado := public._estado_oficial(new.estado);
    return new;
end $$;
revoke all on function public._tg_estado_base() from public, anon, authenticated;
revoke all on function public._tg_estado_cartera() from public, anon, authenticated;

drop trigger if exists estado_oficial on public."BASE_JYP";
create trigger estado_oficial before insert or update of "Estado" on public."BASE_JYP"
    for each row execute function public._tg_estado_base();
drop trigger if exists estado_oficial on public."BASE_GRUPAL";
create trigger estado_oficial before insert or update of "Estado" on public."BASE_GRUPAL"
    for each row execute function public._tg_estado_base();
drop trigger if exists estado_oficial on public.cartera_jyp;
create trigger estado_oficial before insert or update of estado on public.cartera_jyp
    for each row execute function public._tg_estado_cartera();
drop trigger if exists estado_oficial on public.cartera_grupal;
create trigger estado_oficial before insert or update of estado on public.cartera_grupal
    for each row execute function public._tg_estado_cartera();

-- Corregir lo que ya está cargado (sólo las filas que cambian)
update public."BASE_JYP" set "Estado" = public._estado_oficial("Estado") where "Estado" is distinct from public._estado_oficial("Estado");
update public."BASE_GRUPAL" set "Estado" = public._estado_oficial("Estado") where "Estado" is distinct from public._estado_oficial("Estado");
update public.cartera_jyp set estado = public._estado_oficial(estado) where estado is distinct from public._estado_oficial(estado);
update public.cartera_grupal set estado = public._estado_oficial(estado) where estado is distinct from public._estado_oficial(estado);
