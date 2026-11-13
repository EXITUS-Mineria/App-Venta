-- ============================================================
-- DATOS APARTE · la fila original de cada crédito (jsonb, ~1.5 KB) vive en tablas
-- separadas para que la búsqueda en cartera_jyp / cartera_grupal lea pocos MB.
-- Requiere 10, 11 y 12. Idempotente. Después: select public.cargar_cartera_desde_tablas();
-- ============================================================
create table if not exists public.cartera_jyp_datos (
    vreference text primary key,
    datos      jsonb not null
);
create table if not exists public.cartera_grupal_datos (
    id    bigint primary key,           -- = cartera_grupal.id
    datos jsonb not null
);
alter table public.cartera_jyp_datos    enable row level security;
alter table public.cartera_grupal_datos enable row level security;
revoke all on public.cartera_jyp_datos, public.cartera_grupal_datos from anon, authenticated;

do $$
begin
    if exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'cartera_jyp' and column_name = 'datos') then
        -- la cartera se vuelve a cargar después (cargar_cartera_desde_tablas o CARGAR_SUPABASE.bat)
        truncate public.cartera_jyp;
        alter table public.cartera_jyp drop column datos;
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'cartera_grupal' and column_name = 'datos') then
        truncate public.cartera_grupal restart identity;
        alter table public.cartera_grupal drop column datos;
    end if;
end $$;

create or replace function public.apartar(
    p_tipo_venta text, p_capital_objetivo numeric, p_centavos numeric,
    p_refs text[] default '{}', p_grupos text[] default '{}')
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
    v_id        text;
    v_usuario   text;
    v_capital   numeric;
    v_mora      numeric;
    v_ocupados  text;
    v_faltan    text;
    v_min       numeric := greatest(0, p_capital_objetivo - 1000);
    v_max       numeric := p_capital_objetivo + 2000;
begin
    perform public._exigir_activo();
    p_refs := coalesce(p_refs, '{}');
    p_grupos := coalesce(p_grupos, '{}');
    if cardinality(p_refs) + cardinality(p_grupos) = 0 then
        raise exception 'Selecciona al menos un crédito o grupo';
    end if;

    -- un apartado a la vez en toda la empresa
    perform pg_advisory_xact_lock(7781203);

    -- existencia y estatus en base
    select string_agg(r, ', ') into v_faltan from unnest(p_refs) r
     where not exists (select 1 from public.cartera_jyp j where j.vreference = r
                        and public.norm(j.estatus_base) = 'DISPONIBLE');
    if v_faltan is not null then
        raise exception 'Créditos JyP que ya no están disponibles: %', left(v_faltan, 300);
    end if;
    select string_agg(g, ', ') into v_faltan from unnest(p_grupos) g
     where not exists (select 1 from public.cartera_grupal c where c.vgroupid = g)
        or exists (select 1 from public.cartera_grupal c where c.vgroupid = g
                    and public.norm(c.estatus_base) <> 'DISPONIBLE');
    if v_faltan is not null then
        raise exception 'Grupos que ya no están completamente disponibles: %', left(v_faltan, 300);
    end if;

    -- ¿otro usuario ya los apartó?
    select string_agg(substr(a.clave, 3) || ' (' || p.usuario || ')', ', ') into v_ocupados
    from public.apartados_activos a join public.propuestas p using (id_propuesta)
    where a.clave = any (array(select 'J:' || x from unnest(p_refs) x)
                         || array(select 'G:' || x from unnest(p_grupos) x));
    if v_ocupados is not null then
        raise exception 'Otro usuario ya apartó parte de la selección: %', left(v_ocupados, 400);
    end if;

    -- capital y rango
    select coalesce(sum(npendingk), 0), avg(dias) into v_capital, v_mora from (
        select npendingk, dias from public.cartera_jyp where vreference = any (p_refs)
        union all
        select npendingk, dias from public.cartera_grupal where vgroupid = any (p_grupos)
    ) s;
    if v_capital < v_min or v_capital > v_max then
        raise exception 'El capital % está fuera del rango % a %', round(v_capital, 2), v_min, v_max;
    end if;

    select coalesce(nombre, email) into v_usuario from public.perfiles where user_id = auth.uid();
    v_id := 'VTA-' || lpad(nextval('public.folio_venta')::text, 4, '0');

    insert into public.propuestas (id_propuesta, user_id, usuario, tipo_venta, capital_objetivo, capital,
                                   centavos, valor_venta, dias_mora, estatus, capital_original)
    values (v_id, auth.uid(), v_usuario, p_tipo_venta, p_capital_objetivo, round(v_capital, 2),
            p_centavos, round(v_capital * p_centavos, 2), round(v_mora, 1), 'EN REVISIÓN', round(v_capital, 2));

    insert into public.propuesta_detalle (id_propuesta, tipo_cartera, vreference, vgroupid, npendingk, datos)
    select v_id, 'JyP', j.vreference, null, j.npendingk, d.datos
      from public.cartera_jyp j left join public.cartera_jyp_datos d using (vreference)
     where j.vreference = any (p_refs)
    union all
    select v_id, 'Grupal', g.vreference, g.vgroupid, g.npendingk, d.datos
      from public.cartera_grupal g left join public.cartera_grupal_datos d using (id)
     where g.vgroupid = any (p_grupos);

    insert into public.apartados_activos (clave, id_propuesta)
    select 'J:' || r, v_id from unnest(p_refs) r
    union all
    select 'G:' || g, v_id from unnest(p_grupos) g;

    perform public._notificar(array['validador'], null, 'Propuesta por revisar: ' || v_id,
        v_usuario || ' · ' || p_tipo_venta || ' · capital ' || to_char(v_capital, 'FM$999,999,990.00')
        || ' · ' || (cardinality(p_refs) + cardinality(p_grupos)) || ' partidas', 'revision');

    return json_build_object('id_propuesta', v_id, 'estatus', 'EN REVISIÓN', 'capital', round(v_capital, 2),
                             'valor_venta', round(v_capital * p_centavos, 2), 'usuario', v_usuario);
end $$;

create or replace function public.cargar_cartera_desde_tablas()
returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_jyp integer; v_grp integer; v_cols_jyp text[]; v_cols_grp text[];
begin
    select array_agg(column_name::text order by ordinal_position) into v_cols_jyp
      from information_schema.columns where table_schema = 'public' and table_name = 'BASE_JYP';
    select array_agg(column_name::text order by ordinal_position) into v_cols_grp
      from information_schema.columns where table_schema = 'public' and table_name = 'BASE_GRUPAL';
    if v_cols_jyp is null or v_cols_grp is null then
        raise exception 'No existen las tablas BASE_JYP y BASE_GRUPAL';
    end if;

    truncate public.cartera_jyp, public.cartera_jyp_datos;
    insert into public.cartera_jyp (vreference, estado, municipio, colonia, dias, npendingk, estatus_base)
    select distinct on (b."vReference")
           b."vReference", b."Estado", b."Municipio", null, b."iDays", coalesce(b."nPendingK", 0), b."Estatus"
      from public."BASE_JYP" b
     where nullif(trim(b."vReference"), '') is not null
     order by b."vReference";
    get diagnostics v_jyp = row_count;
    insert into public.cartera_jyp_datos (vreference, datos)
    select distinct on (b."vReference") b."vReference", to_jsonb(b)
      from public."BASE_JYP" b
     where nullif(trim(b."vReference"), '') is not null
     order by b."vReference";

    truncate public.cartera_grupal, public.cartera_grupal_datos restart identity;
    create temp table _grp on commit drop as
    select row_number() over (order by b."vGroupId", b."vReference", b."iCredId") as id, b.*
      from (select distinct on (x."vGroupId", x."vReference", x."iCredId") x.*
              from public."BASE_GRUPAL" x
             where nullif(trim(x."vGroupId"), '') is not null and nullif(trim(x."vReference"), '') is not null
             order by x."vGroupId", x."vReference", x."iCredId") b;
    insert into public.cartera_grupal (id, vgroupid, vreference, estado, municipio, colonia, dias, npendingk, estatus_base)
    select t.id, t."vGroupId", t."vReference", t."Estado", t."Municipio", null,
           coalesce(t."Diasatraso_hoy", t."dias hoy"), coalesce(t."nPendingK", 0), t."Estatus"
      from _grp t;
    get diagnostics v_grp = row_count;
    insert into public.cartera_grupal_datos (id, datos)
    select t.id, to_jsonb(t) - 'id' from _grp t;
    perform setval(pg_get_serial_sequence('public.cartera_grupal', 'id'), greatest(v_grp, 1));

    insert into public.cargas (cartera, archivo, filas, columnas, usuario)
    values ('JyP', 'BASE_JYP (Supabase)', v_jyp, v_cols_jyp, coalesce(auth.email(), current_user)),
           ('Grupal', 'BASE_GRUPAL (Supabase)', v_grp, v_cols_grp, coalesce(auth.email(), current_user));

    return json_build_object('jyp', v_jyp, 'grupal', v_grp);
end $$;
revoke all on function public.cargar_cartera_desde_tablas() from public, anon, authenticated;
