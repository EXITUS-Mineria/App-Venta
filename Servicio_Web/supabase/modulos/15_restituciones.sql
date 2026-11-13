-- ============================================================
-- RESTITUCIONES · cambiar un crédito/grupo vendido por otro de capital similar (±$5,000)
-- Motivos: Defunción, Liquidado, Venta duplicada, Incidencia en el expediente.
--  - El original queda BLOQUEADO (no se vuelve a ofrecer ni apartar).
--  - Si el original está en una propuesta, el reemplazo entra a esa misma propuesta.
--  - Si se vendió antes de la página (sin propuesta), se crea una propuesta RST-#### APROBADA
--    para que el auxiliar genere su sub base.
-- Requiere 10-13. Idempotente.
-- ============================================================
create table if not exists public.bloqueados (
    clave          text primary key,           -- 'J:<vReference>' / 'G:<vGroupId>'
    motivo         text not null,
    id_restitucion text,
    fecha          timestamptz not null default now()
);
alter table public.bloqueados enable row level security;
revoke all on public.bloqueados from anon, authenticated;

create sequence if not exists public.folio_restitucion start 1 minvalue 1;
revoke all on sequence public.folio_restitucion from anon, authenticated;

create table if not exists public.restituciones (
    id_restitucion         text primary key,  -- RST-0001
    fecha                  timestamptz not null default now(),
    user_id                uuid,
    usuario                text not null,
    motivo                 text not null check (motivo in
                           ('Defunción', 'Liquidado', 'Venta duplicada', 'Incidencia en el expediente')),
    comentario             text,
    tipo_cartera           text not null check (tipo_cartera in ('JyP', 'Grupal')),
    clave_original         text not null,
    capital_original       numeric,
    id_propuesta_original  text,
    clave_reemplazo        text not null,
    capital_reemplazo      numeric,
    id_propuesta_reemplazo text not null,
    diferencia             numeric
);
create index if not exists restituciones_usuario on public.restituciones (user_id);
alter table public.restituciones enable row level security;
revoke all on public.restituciones from anon, authenticated;
grant select on public.restituciones to authenticated;
drop policy if exists restituciones_lectura on public.restituciones;
create policy restituciones_lectura on public.restituciones for select to authenticated using (public.es_activo());

-- Ubica un texto (vReference de JyP, vGroupId, o vReference de un integrante de grupo)
create or replace function public._ubicar_cartera(p_texto text, out tipo text, out clave text)
language plpgsql stable security definer set search_path = public as $$
declare v text := upper(trim(coalesce(p_texto, '')));
begin
    if v = '' then return; end if;
    select 'JyP', j.vreference into tipo, clave from public.cartera_jyp j where upper(j.vreference) = v limit 1;
    if found then return; end if;
    select 'Grupal', g.vgroupid into tipo, clave from public.cartera_grupal g where upper(g.vgroupid) = v limit 1;
    if found then return; end if;
    select 'Grupal', g.vgroupid into tipo, clave from public.cartera_grupal g where upper(g.vreference) = v limit 1;
end $$;
revoke all on function public._ubicar_cartera(text) from public, anon, authenticated;

-- Datos de un crédito/grupo para el panel de restitución
create or replace function public.validar_restitucion(p_texto text)
returns json
language plpgsql stable security definer set search_path = public as $$
declare u record; r json; v_llave text;
begin
    perform public._exigir_activo();
    select * into u from public._ubicar_cartera(p_texto);
    if u.clave is null then
        raise exception 'No encontré «%» en Base JyP ni en Base Grupal', trim(p_texto);
    end if;
    v_llave := case when u.tipo = 'JyP' then 'J:' else 'G:' end || u.clave;
    with base as (
        select count(*) integrantes, round(sum(npendingk), 2) capital, round(avg(dias), 1) dias,
               string_agg(distinct nullif(trim(estado), ''), ', ') estados,
               string_agg(distinct nullif(trim(municipio), ''), ', ') municipios,
               string_agg(distinct estatus_base, ', ') estatus_base,
               bool_and(disponible) disponible,
               min(estado_n) estado_n
          from (select npendingk, dias, estado, municipio, estatus_base, disponible, estado_n
                  from public.cartera_jyp where u.tipo = 'JyP' and vreference = u.clave
                union all
                select npendingk, dias, estado, municipio, estatus_base, disponible, estado_n
                  from public.cartera_grupal where u.tipo = 'Grupal' and vgroupid = u.clave) x
    )
    select json_build_object(
        'tipo', u.tipo, 'clave', u.clave, 'buscado', trim(p_texto),
        'integrantes', b.integrantes, 'capital', b.capital, 'dias', b.dias,
        'estados', b.estados, 'municipios', b.municipios, 'estado_n', b.estado_n,
        'estatus_base', b.estatus_base, 'disponible_en_base', b.disponible,
        'id_propuesta', a.id_propuesta, 'estatus_propuesta', p.estatus, 'usuario_propuesta', p.usuario,
        'bloqueado', (bl.clave is not null), 'motivo_bloqueo', bl.motivo, 'restitucion', bl.id_restitucion,
        'vendido', (a.id_propuesta is not null or not b.disponible))
      into r
      from base b
      left join public.apartados_activos a on a.clave = v_llave
      left join public.propuestas p on p.id_propuesta = a.id_propuesta
      left join public.bloqueados bl on bl.clave = v_llave;
    return r;
end $$;

-- Reemplazos disponibles del mismo tipo con capital ± tolerancia (máx. 5,000)
create or replace function public.sugerir_restitucion(p_tipo text, p_capital numeric,
                                                      p_tolerancia numeric default 5000, p_estado text default null)
returns table (clave text, integrantes bigint, estados text, municipios text, dias numeric, capital numeric, diferencia numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_tol numeric := least(greatest(coalesce(p_tolerancia, 5000), 0), 5000);
begin
    perform public._exigir_activo();
    if p_tipo = 'JyP' then
        return query
        select j.vreference, 1::bigint, j.estado, j.municipio, j.dias, round(j.npendingk, 2),
               round(j.npendingk - p_capital, 2)
          from public.cartera_jyp j
         where j.disponible
           and j.npendingk between p_capital - v_tol and p_capital + v_tol
           and (p_estado is null or p_estado = '' or j.estado_n = upper(p_estado))
           and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference)
           and not exists (select 1 from public.bloqueados b where b.clave = 'J:' || j.vreference)
         order by abs(j.npendingk - p_capital), j.vreference
         limit 30;
    else
        return query
        select g.vgroupid, count(*), string_agg(distinct nullif(trim(g.estado), ''), ', '),
               string_agg(distinct nullif(trim(g.municipio), ''), ', '), round(avg(g.dias), 1),
               round(sum(g.npendingk), 2), round(sum(g.npendingk) - p_capital, 2)
          from public.cartera_grupal g
         where not exists (select 1 from public.apartados_activos a where a.clave = 'G:' || g.vgroupid)
           and not exists (select 1 from public.bloqueados b where b.clave = 'G:' || g.vgroupid)
         group by g.vgroupid
        having bool_and(g.disponible)
           and sum(g.npendingk) between p_capital - v_tol and p_capital + v_tol
           and (p_estado is null or p_estado = '' or bool_or(g.estado_n = upper(p_estado)))
         order by abs(sum(g.npendingk) - p_capital), g.vgroupid
         limit 30;
    end if;
end $$;

-- Aplicar la restitución (todo o nada)
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
    select v_id_prop, 'JyP', j.vreference, null, j.npendingk, d.datos
      from public.cartera_jyp j left join public.cartera_jyp_datos d using (vreference)
     where n.tipo = 'JyP' and j.vreference = n.clave
    union all
    select v_id_prop, 'Grupal', g.vreference, g.vgroupid, g.npendingk, d.datos
      from public.cartera_grupal g left join public.cartera_grupal_datos d using (id)
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

create or replace function public.buscar_jyp(
    p_estados text[] default null, p_municipios text[] default null,
    p_mora_min numeric default null, p_mora_max numeric default null, p_terminos text[] default null)
returns table (vreference text, estado text, municipio text, colonia text, dias numeric,
               npendingk numeric, estatus text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select j.vreference, j.estado, j.municipio, j.colonia, j.dias, j.npendingk, 'Disponible'::text
    from public.cartera_jyp j
    where j.disponible
      and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference)
      and not exists (select 1 from public.bloqueados b where b.clave = 'J:' || j.vreference)
      and (p_estados is null or cardinality(p_estados) = 0 or j.estado_n = any (p_estados))
      and (p_municipios is null or cardinality(p_municipios) = 0 or j.municipio_n = any (p_municipios))
      and (p_mora_min is null or j.dias >= p_mora_min)
      and (p_mora_max is null or j.dias <= p_mora_max)
      and public._coincide(j.vreference, p_terminos)
    order by j.estado, j.municipio, j.vreference;
end $$;

create or replace function public.buscar_grupos(
    p_estados text[] default null, p_municipios text[] default null,
    p_mora_min numeric default null, p_mora_max numeric default null, p_terminos text[] default null)
returns table (vgroupid text, integrantes bigint, estados text, municipios text, colonias text,
               dias_promedio numeric, capital numeric, disponible boolean)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with ids as (
        select distinct g.vgroupid
        from public.cartera_grupal g
        where (p_estados is null or cardinality(p_estados) = 0 or g.estado_n = any (p_estados))
          and (p_municipios is null or cardinality(p_municipios) = 0 or g.municipio_n = any (p_municipios))
          and (p_terminos is null or cardinality(p_terminos) = 0
               or public._coincide(g.vgroupid, p_terminos) or public._coincide(g.vreference, p_terminos))
    ), res as (
        select g.vgroupid,
               count(*) as integrantes,
               string_agg(distinct nullif(trim(g.estado), ''), ', ') as estados,
               string_agg(distinct nullif(trim(g.municipio), ''), ', ') as municipios,
               string_agg(distinct nullif(trim(g.colonia), ''), ', ') as colonias,
               round(avg(g.dias), 1) as dias_promedio,
               round(sum(g.npendingk), 2) as capital,
               bool_and(g.disponible)
                 and not exists (select 1 from public.apartados_activos a where a.clave = 'G:' || g.vgroupid)
                 and not exists (select 1 from public.bloqueados b where b.clave = 'G:' || g.vgroupid)
                 as disponible
        from public.cartera_grupal g join ids using (vgroupid)
        group by g.vgroupid
    )
    select * from res r
    where (p_mora_min is null or r.dias_promedio >= p_mora_min)
      and (p_mora_max is null or r.dias_promedio <= p_mora_max)
    order by r.disponible desc, r.vgroupid;
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

do $$
declare f text;
begin
    foreach f in array array[
        'validar_restitucion(text)',
        'sugerir_restitucion(text,numeric,numeric,text)',
        'aplicar_restitucion(text,text,text,text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
