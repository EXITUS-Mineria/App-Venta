-- ============================================================
-- ALMACENAMIENTO · una sola copia de la cartera
--  - La fila completa de cada crédito se lee de BASE_JYP / BASE_GRUPAL al apartar
--    (antes se duplicaba en cartera_jyp_datos / cartera_grupal_datos: ~150 MB).
--  - Propuestas LIBERADAS o RECHAZADAS: se borra la copia de la fila (datos) de su detalle.
--  - Los CSV (propuesta, base final, bitácora, funnel) se generan al momento en el navegador;
--    no se guardan archivos en ningún lado.
-- Requiere 10-20. Idempotente.
-- ============================================================
create index if not exists base_jyp_vreference on public."BASE_JYP" ("vReference");
create index if not exists base_grupal_grupo on public."BASE_GRUPAL" ("vGroupId", "vReference");

-- número tolerante: acepta 1,234.50 / $1,234 / texto vacío
create or replace function public._num(t text) returns numeric
language sql immutable set search_path = public as $$
    select nullif(regexp_replace(coalesce(t, ''), '[^0-9.\-]', '', 'g'), '')::numeric
$$;

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

    truncate public.cartera_jyp;
    insert into public.cartera_jyp (vreference, estado, municipio, colonia, dias, npendingk, estatus_base)
    select distinct on (b."vReference")
           b."vReference", b."Estado", b."Municipio", null, public._num(b."iDays"::text),
           coalesce(public._num(b."nPendingK"::text), 0), b."Estatus"
      from public."BASE_JYP" b
     where nullif(trim(b."vReference"), '') is not null
     order by b."vReference";
    get diagnostics v_jyp = row_count;

    truncate public.cartera_grupal restart identity;
    insert into public.cartera_grupal (vgroupid, vreference, estado, municipio, colonia, dias, npendingk, estatus_base)
    select distinct on (b."vGroupId", b."vReference", b."iCredId")
           b."vGroupId", b."vReference", b."Estado", b."Municipio", null,
           coalesce(public._num(b."Diasatraso_hoy"::text), public._num(b."dias hoy"::text)),
           coalesce(public._num(b."nPendingK"::text), 0), b."Estatus"
      from public."BASE_GRUPAL" b
     where nullif(trim(b."vGroupId"), '') is not null and nullif(trim(b."vReference"), '') is not null
     order by b."vGroupId", b."vReference", b."iCredId";
    get diagnostics v_grp = row_count;

    insert into public.cargas (cartera, archivo, filas, columnas, usuario)
    values ('JyP', 'BASE_JYP (Supabase)', v_jyp, v_cols_jyp, coalesce(auth.email(), current_user)),
           ('Grupal', 'BASE_GRUPAL (Supabase)', v_grp, v_cols_grp, coalesce(auth.email(), current_user));
    return json_build_object('jyp', v_jyp, 'grupal', v_grp);
end $$;
revoke all on function public.cargar_cartera_desde_tablas() from public, anon, authenticated;

drop function if exists public.apartar(text, numeric, numeric, text[], text[], text);
create or replace function public.apartar(
    p_tipo_venta text, p_capital_objetivo numeric, p_centavos numeric,
    p_refs text[] default '{}', p_grupos text[] default '{}', p_comprador text default null)
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
    if coalesce(trim(p_comprador), '') = '' then
        raise exception 'Escribe el nombre del comprador';
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

    select string_agg(substr(b.clave, 3) || ' (' || b.motivo || ')', ', ') into v_ocupados
    from public.bloqueados b
    where b.clave = any (array(select 'J:' || x from unnest(p_refs) x)
                         || array(select 'G:' || x from unnest(p_grupos) x));
    if v_ocupados is not null then
        raise exception 'Créditos o grupos bloqueados por restitución: %', left(v_ocupados, 400);
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
                                   centavos, valor_venta, dias_mora, estatus, capital_original, comprador)
    values (v_id, auth.uid(), v_usuario, p_tipo_venta, p_capital_objetivo, round(v_capital, 2),
            p_centavos, round(v_capital * p_centavos, 2), round(v_mora, 1), 'EN REVISIÓN', round(v_capital, 2),
            trim(p_comprador));

    insert into public.propuesta_detalle (id_propuesta, tipo_cartera, vreference, vgroupid, npendingk, datos)
    select v_id, 'JyP', j.vreference, null, j.npendingk, b.datos
      from public.cartera_jyp j
      left join lateral (select to_jsonb(x) datos from public."BASE_JYP" x where x."vReference" = j.vreference limit 1) b on true
     where j.vreference = any (p_refs)
    union all
    select v_id, 'Grupal', g.vreference, g.vgroupid, g.npendingk, b.datos
      from public.cartera_grupal g
      left join lateral (select to_jsonb(x) datos from public."BASE_GRUPAL" x
                          where x."vGroupId" = g.vgroupid and x."vReference" = g.vreference limit 1) b on true
     where g.vgroupid = any (p_grupos);

    insert into public.apartados_activos (clave, id_propuesta)
    select 'J:' || r, v_id from unnest(p_refs) r
    union all
    select 'G:' || g, v_id from unnest(p_grupos) g;

    perform public._notificar(array['validador'], null, 'Propuesta por revisar: ' || v_id,
        v_usuario || ' · ' || trim(p_comprador) || ' · ' || p_tipo_venta || ' · capital ' || to_char(v_capital, 'FM$999,999,990.00')
        || ' · ' || (cardinality(p_refs) + cardinality(p_grupos)) || ' partidas', 'revision');

    return json_build_object('id_propuesta', v_id, 'estatus', 'EN REVISIÓN', 'comprador', trim(p_comprador), 'capital', round(v_capital, 2),
                             'valor_venta', round(v_capital * p_centavos, 2), 'usuario', v_usuario);
end $$;

create or replace function public.complementar_propuesta(p_id text, p_refs text[] default '{}', p_grupos text[] default '{}')
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
    v_p public.propuestas; v_usuario text; v_faltan text; v_ocupados text;
    v_agregado numeric; v_cap numeric; v_mora numeric; v_n integer; v_estatus text;
begin
    perform public._exigir_activo();
    p_refs := coalesce(p_refs, '{}'); p_grupos := coalesce(p_grupos, '{}');
    v_n := cardinality(p_refs) + cardinality(p_grupos);
    if v_n = 0 then raise exception 'Selecciona al menos un crédito o grupo para agregar'; end if;

    perform pg_advisory_xact_lock(7781203);
    select * into v_p from public.propuestas where id_propuesta = p_id for update;
    if not found then raise exception 'No existe la propuesta %', p_id; end if;
    if v_p.estatus not in ('EN REVISIÓN', 'APROBADA', 'EN VENTA', 'APARTADA') then
        raise exception 'No se puede complementar una propuesta %', v_p.estatus;
    end if;
    if v_p.user_id is distinct from auth.uid() and not public.es_admin() then
        raise exception 'Sólo % o un usuario maestro pueden complementar %', v_p.usuario, p_id;
    end if;

    select string_agg(r, ', ') into v_faltan from unnest(p_refs) r
     where not exists (select 1 from public.cartera_jyp j where j.vreference = r and j.disponible);
    if v_faltan is not null then raise exception 'Créditos JyP que ya no están disponibles: %', left(v_faltan, 300); end if;
    select string_agg(g, ', ') into v_faltan from unnest(p_grupos) g
     where not exists (select 1 from public.cartera_grupal c where c.vgroupid = g)
        or exists (select 1 from public.cartera_grupal c where c.vgroupid = g and not c.disponible);
    if v_faltan is not null then raise exception 'Grupos que ya no están completamente disponibles: %', left(v_faltan, 300); end if;

    select string_agg(substr(a.clave, 3) || ' (' || a.id_propuesta || ')', ', ') into v_ocupados
      from public.apartados_activos a
     where a.clave = any (array(select 'J:' || x from unnest(p_refs) x) || array(select 'G:' || x from unnest(p_grupos) x));
    if v_ocupados is not null then raise exception 'Ya están apartados: %', left(v_ocupados, 400); end if;
    select string_agg(substr(b.clave, 3), ', ') into v_ocupados
      from public.bloqueados b
     where b.clave = any (array(select 'J:' || x from unnest(p_refs) x) || array(select 'G:' || x from unnest(p_grupos) x));
    if v_ocupados is not null then raise exception 'Bloqueados por restitución: %', left(v_ocupados, 400); end if;

    insert into public.propuesta_detalle (id_propuesta, tipo_cartera, vreference, vgroupid, npendingk, datos)
    select p_id, 'JyP', j.vreference, null, j.npendingk, b.datos
      from public.cartera_jyp j
      left join lateral (select to_jsonb(x) datos from public."BASE_JYP" x where x."vReference" = j.vreference limit 1) b on true
     where j.vreference = any (p_refs)
    union all
    select p_id, 'Grupal', g.vreference, g.vgroupid, g.npendingk, b.datos
      from public.cartera_grupal g
      left join lateral (select to_jsonb(x) datos from public."BASE_GRUPAL" x
                          where x."vGroupId" = g.vgroupid and x."vReference" = g.vreference limit 1) b on true
     where g.vgroupid = any (p_grupos);
    insert into public.apartados_activos (clave, id_propuesta)
    select 'J:' || r, p_id from unnest(p_refs) r
    union all
    select 'G:' || g, p_id from unnest(p_grupos) g;

    select coalesce(sum(npendingk), 0) into v_agregado from (
        select npendingk from public.cartera_jyp where vreference = any (p_refs)
        union all
        select npendingk from public.cartera_grupal where vgroupid = any (p_grupos)) s;
    select coalesce(sum(d.npendingk), 0), avg(coalesce(j.dias, g.dias)) into v_cap, v_mora
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = p_id;

    select coalesce(nombre, email) into v_usuario from public.perfiles where user_id = auth.uid();
    v_estatus := case when v_p.estatus in ('APROBADA', 'EN VENTA') then 'EN REVISIÓN' else v_p.estatus end;
    update public.propuestas
       set capital = round(v_cap, 2), valor_venta = round(v_cap * coalesce(centavos, 0), 2),
           dias_mora = round(v_mora, 1), estatus = v_estatus, complementos = complementos + 1,
           comentario = concat_ws(' | ', nullif(comentario, ''),
               'Complemento ' || (complementos + 1) || ': +' || to_char(v_agregado, 'FM$999,999,990.00')
               || ' (' || v_n || ' partidas, ' || v_usuario || ')')
     where id_propuesta = p_id;

    perform public._notificar(array['validador'], v_p.user_id, 'Complemento en ' || p_id,
        v_usuario || ' agregó ' || to_char(v_agregado, 'FM$999,999,990.00') || ' (' || v_n || ' partidas). Capital total '
        || to_char(v_cap, 'FM$999,999,990.00') || '.' ||
        case when v_estatus <> v_p.estatus then ' Regresa a revisión.' else '' end, 'revision');

    return json_build_object('id_propuesta', p_id, 'agregado', round(v_agregado, 2), 'capital', round(v_cap, 2),
        'valor_venta', round(v_cap * coalesce(v_p.centavos, 0), 2), 'partidas', v_n,
        'estatus', v_estatus, 'regresa_a_revision', v_estatus <> v_p.estatus);
end $$;

create or replace function public.aplicar_restitucion(p_original text, p_reemplazo text, p_motivo text,
                                                      p_comentario text default '')
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
    o record; n record; v_ol text; v_nl text;
    v_cap_o numeric; v_cap_n numeric; v_ok boolean;
    v_prop public.propuestas; v_id_prop text; v_folio text; v_usuario text; v_cap numeric; v_mora numeric;
begin
    perform public._exigir_activo();
    if p_motivo not in ('Defunción', 'Liquidado', 'Venta duplicada', 'Incidencia en el expediente') then
        raise exception 'Motivo no válido: %', p_motivo;
    end if;
    perform pg_advisory_xact_lock(7781203);

    select * into o from public._ubicar_cartera(p_original);
    if o.clave is null then raise exception 'No encontré «%» en las bases', p_original; end if;
    select * into n from public._ubicar_cartera(p_reemplazo);
    if n.clave is null then raise exception 'No encontré el reemplazo «%» en las bases', p_reemplazo; end if;
    if o.tipo <> n.tipo then raise exception 'El reemplazo debe ser del mismo tipo (%)', o.tipo; end if;
    if o.clave = n.clave then raise exception 'El reemplazo no puede ser el mismo crédito/grupo'; end if;
    v_ol := case when o.tipo = 'JyP' then 'J:' else 'G:' end || o.clave;
    v_nl := case when n.tipo = 'JyP' then 'J:' else 'G:' end || n.clave;

    if exists (select 1 from public.bloqueados where clave = v_ol) then
        raise exception '% ya fue restituido antes', o.clave;
    end if;

    -- capital y disponibilidad
    if o.tipo = 'JyP' then
        select npendingk, not disponible into v_cap_o, v_ok from public.cartera_jyp where vreference = o.clave;
        select npendingk, disponible into v_cap_n, v_ok from public.cartera_jyp where vreference = n.clave;
    else
        select sum(npendingk) into v_cap_o from public.cartera_grupal where vgroupid = o.clave;
        select sum(npendingk), bool_and(disponible) into v_cap_n, v_ok from public.cartera_grupal where vgroupid = n.clave;
    end if;
    if not v_ok or exists (select 1 from public.apartados_activos where clave = v_nl)
       or exists (select 1 from public.bloqueados where clave = v_nl) then
        raise exception 'El reemplazo % ya no está disponible', n.clave;
    end if;
    if abs(v_cap_n - v_cap_o) > 5000 then
        raise exception 'La diferencia de capital (%) es mayor a ±5,000', round(v_cap_n - v_cap_o, 2);
    end if;

    select coalesce(nombre, email) into v_usuario from public.perfiles where user_id = auth.uid();
    v_folio := 'RST-' || lpad(nextval('public.folio_restitucion')::text, 4, '0');

    -- ¿en qué propuesta está el original?
    select p.* into v_prop from public.apartados_activos a join public.propuestas p using (id_propuesta)
     where a.clave = v_ol;
    if found then
        v_id_prop := v_prop.id_propuesta;
        delete from public.propuesta_detalle d where d.id_propuesta = v_id_prop
           and ((o.tipo = 'JyP' and d.tipo_cartera = 'JyP' and d.vreference = o.clave)
             or (o.tipo = 'Grupal' and d.tipo_cartera = 'Grupal' and d.vgroupid = o.clave));
        delete from public.apartados_activos where clave = v_ol;
    else
        -- vendido antes de la página: la restitución lleva su propia propuesta
        if not exists (select 1 from public.cartera_jyp where o.tipo = 'JyP' and vreference = o.clave and not disponible)
           and not exists (select 1 from public.cartera_grupal where o.tipo = 'Grupal' and vgroupid = o.clave and not disponible) then
            raise exception '% está Disponible y no está en ninguna propuesta: no requiere restitución', o.clave;
        end if;
        v_id_prop := v_folio;
        insert into public.propuestas (id_propuesta, user_id, usuario, tipo_venta, capital_objetivo, capital, centavos,
                                       valor_venta, estatus, capital_original, origen, comentario, revisada_en, revisada_por)
        values (v_folio, auth.uid(), v_usuario, 'Restitución', round(v_cap_o, 2), 0, 0, 0, 'APROBADA',
                round(v_cap_o, 2), 'restitución',
                p_motivo || ': ' || o.clave || ' → ' || n.clave, now(), v_usuario);
    end if;

    insert into public.propuesta_detalle (id_propuesta, tipo_cartera, vreference, vgroupid, npendingk, datos)
    select v_id_prop, 'JyP', j.vreference, null, j.npendingk, b.datos
      from public.cartera_jyp j
      left join lateral (select to_jsonb(x) datos from public."BASE_JYP" x where x."vReference" = j.vreference limit 1) b on true
     where n.tipo = 'JyP' and j.vreference = n.clave
    union all
    select v_id_prop, 'Grupal', g.vreference, g.vgroupid, g.npendingk, b.datos
      from public.cartera_grupal g
      left join lateral (select to_jsonb(x) datos from public."BASE_GRUPAL" x
                          where x."vGroupId" = g.vgroupid and x."vReference" = g.vreference limit 1) b on true
     where n.tipo = 'Grupal' and g.vgroupid = n.clave;
    insert into public.apartados_activos (clave, id_propuesta) values (v_nl, v_id_prop);
    insert into public.bloqueados (clave, motivo, id_restitucion) values (v_ol, p_motivo, v_folio);

    -- recalcular la propuesta
    select coalesce(sum(d.npendingk), 0), avg(coalesce(j.dias, g.dias)) into v_cap, v_mora
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = v_id_prop;
    update public.propuestas
       set capital = round(v_cap, 2), valor_venta = round(v_cap * coalesce(centavos, 0), 2),
           dias_mora = round(v_mora, 1),
           comentario = case when v_id_prop = v_folio then comentario
                             else concat_ws(' | ', nullif(comentario, ''), v_folio || ' ' || p_motivo || ': ' || o.clave || ' → ' || n.clave) end
     where id_propuesta = v_id_prop;

    insert into public.restituciones (id_restitucion, user_id, usuario, motivo, comentario, tipo_cartera,
        clave_original, capital_original, id_propuesta_original, clave_reemplazo, capital_reemplazo,
        id_propuesta_reemplazo, diferencia)
    values (v_folio, auth.uid(), v_usuario, p_motivo, nullif(trim(p_comentario), ''), o.tipo,
        o.clave, round(v_cap_o, 2), v_prop.id_propuesta, n.clave, round(v_cap_n, 2), v_id_prop, round(v_cap_n - v_cap_o, 2));

    perform public._notificar(array['validador', 'auxiliar'], null, 'Restitución ' || v_folio || ' · ' || p_motivo,
        v_usuario || ': ' || o.clave || ' → ' || n.clave || ' en ' || v_id_prop
        || case when v_prop.estatus = 'EN VENTA' then '. Regenerar la sub base.' else '.' end, 'restituciones');

    return json_build_object('id_restitucion', v_folio, 'id_propuesta', v_id_prop, 'original', o.clave,
        'reemplazo', n.clave, 'capital_original', round(v_cap_o, 2), 'capital_reemplazo', round(v_cap_n, 2),
        'diferencia', round(v_cap_n - v_cap_o, 2), 'propuesta_nueva', v_prop.id_propuesta is null);
end $$;

-- liberadas / rechazadas no necesitan la copia de la fila
create or replace function public.tg_detalle_limpio() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if new.estatus in ('LIBERADA', 'RECHAZADA') and new.estatus is distinct from old.estatus then
        update public.propuesta_detalle set datos = null where id_propuesta = new.id_propuesta and datos is not null;
    end if;
    return new;
end $$;
revoke all on function public.tg_detalle_limpio() from public, anon, authenticated;
drop trigger if exists tr_detalle_limpio on public.propuestas;
create trigger tr_detalle_limpio after update on public.propuestas
    for each row execute function public.tg_detalle_limpio();
update public.propuesta_detalle d set datos = null
  from public.propuestas p
 where p.id_propuesta = d.id_propuesta and p.estatus in ('LIBERADA', 'RECHAZADA') and d.datos is not null;

drop table if exists public.cartera_jyp_datos;
drop table if exists public.cartera_grupal_datos;

do $$
declare f text;
begin
    foreach f in array array[
        'apartar(text,numeric,numeric,text[],text[],text)',
        'complementar_propuesta(text,text[],text[])',
        'aplicar_restitucion(text,text,text,text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
