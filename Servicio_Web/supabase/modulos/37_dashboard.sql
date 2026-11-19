-- ============================================================
-- DASHBOARD DE VENTA DE CARTERA (réplica del Dashboard_Venta_Cartera.html, ahora en vivo desde el Funnel)
--  - dashboard_metas: metas editables por admin/validador (general, grupal, jyp, complementario,
--    zona:<Zona>, vendedor:<parte del nombre>).
--  - zonas_estado: catálogo Estado -> Zona (llave sin acentos y en mayúsculas).
--  - dashboard_datos(anio): ventas del Funnel que el usuario PUEDE VER (funnel_puede_ver): el vendedor sólo
--    las suyas; auxiliar, control documental, validador y admin todas. Mes tomado de la columna Mes
--    ("Noviembre 2026") o de la fecha de venta / propuesta.
-- Requiere 31 (funnel_puede_ver). Idempotente.
-- ============================================================
create table if not exists public.dashboard_metas (
    clave text primary key,
    valor numeric not null check (valor >= 0),
    actualizado timestamptz not null default now(),
    actualizado_por text
);
alter table public.dashboard_metas enable row level security;
revoke all on public.dashboard_metas from anon, authenticated;
insert into public.dashboard_metas (clave, valor) values
    ('general', 1500000), ('grupal', 750000), ('jyp', 750000), ('complementario', 50000),
    ('zona:Centro', 675000), ('zona:Norte', 525000), ('zona:Sur', 300000),
    ('vendedor:Sandibel', 975000), ('vendedor:Maricela', 525000)
on conflict (clave) do nothing;

create table if not exists public.zonas_estado (
    estado_n text primary key,
    zona text not null
);
alter table public.zonas_estado enable row level security;
revoke all on public.zonas_estado from anon, authenticated;
insert into public.zonas_estado (estado_n, zona) values
    ('AGUASCALIENTES', 'Norte'), ('BAJA CALIFORNIA', 'Norte'), ('BAJA CALIFORNIA SUR', 'Norte'), ('CAMPECHE', 'Sur'),
    ('CHIAPAS', 'Sur'), ('CHIHUAHUA', 'Norte'), ('CIUDAD DE MEXICO', 'Centro'), ('CDMX', 'Centro'), ('DISTRITO FEDERAL', 'Centro'),
    ('COAHUILA', 'Norte'), ('COAHUILA DE ZARAGOZA', 'Norte'), ('COLIMA', 'Norte'), ('DURANGO', 'Norte'),
    ('ESTADO DE MEXICO', 'Centro'), ('MEXICO', 'Centro'), ('EDO DE MEXICO', 'Centro'), ('EDO. DE MEXICO', 'Centro'),
    ('GUANAJUATO', 'Centro'), ('GUERRERO', 'Centro'), ('HIDALGO', 'Centro'), ('JALISCO', 'Norte'),
    ('MICHOACAN', 'Centro'), ('MICHOACAN DE OCAMPO', 'Centro'), ('MORELOS', 'Centro'), ('NAYARIT', 'Norte'),
    ('NUEVO LEON', 'Norte'), ('OAXACA', 'Sur'), ('PUEBLA', 'Centro'), ('QUERETARO', 'Centro'), ('QUERETARO DE ARTEAGA', 'Centro'),
    ('QUINTANA ROO', 'Sur'), ('SAN LUIS POTOSI', 'Norte'), ('SINALOA', 'Norte'), ('SONORA', 'Norte'), ('TABASCO', 'Sur'),
    ('TAMAULIPAS', 'Norte'), ('TLAXCALA', 'Centro'), ('VERACRUZ', 'Sur'), ('VERACRUZ DE IGNACIO DE LA LLAVE', 'Sur'),
    ('YUCATAN', 'Sur'), ('ZACATECAS', 'Norte')
on conflict (estado_n) do nothing;

create or replace function public._mes_numero(p_texto text) returns integer
language sql immutable set search_path = public as $$
    select case
        when t ~ '^ene' then 1 when t ~ '^feb' then 2 when t ~ '^mar' then 3 when t ~ '^abr' then 4
        when t ~ '^may' then 5 when t ~ '^jun' then 6 when t ~ '^jul' then 7 when t ~ '^ago' then 8
        when t ~ '^(sep|set)' then 9 when t ~ '^oct' then 10 when t ~ '^nov' then 11 when t ~ '^dic' then 12 end
    from (select lower(trim(coalesce(p_texto, ''))) t) x
$$;

create or replace function public.dashboard_datos(p_anio integer default null)
returns table (folio text, anio integer, mes integer, comprador text, capital numeric, monto_venta numeric,
               estado text, municipio text, zona text, tipo text, estatus_venta text,
               fecha_propuesta date, fecha_venta date, vendedor text, vendedor_user uuid, es_mio boolean,
               estatus_md text, estatus_control_doc text, estatus_juridico text, estatus_final text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with v as (
        select f.*,
               coalesce(public._mes_numero(f.mes), extract(month from coalesce(f.fecha_venta, f.fecha_propuesta))::integer) m,
               coalesce(substring(f.mes from '(20\d\d)')::integer,
                        extract(year from coalesce(f.fecha_venta, f.fecha_propuesta, f.actualizado))::integer) a
          from public.funnel_ventas f
         where public.funnel_puede_ver(f.folio)
    )
    select v.folio, v.a, v.m, v.comprador, coalesce(v.capital, 0), coalesce(v.monto_venta, 0),
           v.estado, v.municipios,
           coalesce(z.zona, 'Sin zona'),
           case when v.tipo ilike '%grupal%' then 'Grupal' when v.tipo ilike '%dual%' then 'Dual'
                when v.tipo ~* '(j\s*&\s*p|jyp|j y p)' then 'JyP' else coalesce(nullif(v.tipo, ''), 'Sin tipo') end,
           v.estatus_venta, v.fecha_propuesta, v.fecha_venta,
           coalesce(nullif(trim(p.nombre), ''), v.vendedor, 'Sin vendedor'), v.vendedor_user,
           v.vendedor_user is not distinct from auth.uid(),
           v.estatus_md, v.estatus_control_doc, v.estatus_juridico, v.estatus_final
      from v
      left join public.perfiles p on p.user_id = v.vendedor_user
      left join public.zonas_estado z on z.estado_n = upper(public._sin_acentos(regexp_replace(trim(coalesce(v.estado, '')), '\s+', ' ', 'g')))
     where p_anio is null or v.a = p_anio
     order by v.a, v.m, v.folio;
end $$;

create or replace function public.dashboard_metas_lista()
returns table (clave text, valor numeric, actualizado timestamptz, actualizado_por text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query select m.clave, m.valor, m.actualizado, m.actualizado_por from public.dashboard_metas m order by m.clave;
end $$;

create or replace function public.dashboard_guardar_meta(p_clave text, p_valor numeric)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_quien text;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador cambian las metas' using errcode = '42501'; end if;
    p_clave := trim(coalesce(p_clave, ''));
    if p_clave !~ '^(general|grupal|jyp|complementario|zona:.+|vendedor:.+)$' then
        raise exception 'Clave de meta no válida: %', p_clave;
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    if p_valor is null then
        delete from public.dashboard_metas where clave = p_clave and clave not in ('general', 'grupal', 'jyp', 'complementario');
        return;
    end if;
    insert into public.dashboard_metas (clave, valor, actualizado, actualizado_por) values (p_clave, p_valor, now(), v_quien)
    on conflict (clave) do update set valor = excluded.valor, actualizado = now(), actualizado_por = v_quien;
end $$;

do $$
declare f text;
begin
    foreach f in array array['dashboard_datos(integer)', 'dashboard_metas_lista()', 'dashboard_guardar_meta(text,numeric)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
