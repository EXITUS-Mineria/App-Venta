-- ============================================================
-- COMPRADOR · nombre del comprador en cada propuesta/venta
--  - apartar() lo pide (obligatorio); se guarda en propuestas.comprador.
--  - asignar_comprador(): el dueño o un usuario maestro lo captura/corrige después.
--  - Va en el historial, en el CSV de la propuesta y en la base final (columna Comprador).
-- Requiere 10-17. Idempotente.
-- ============================================================
alter table public.propuestas add column if not exists comprador text;

drop function if exists public.apartar(text, numeric, numeric, text[], text[]);
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
        v_usuario || ' · ' || trim(p_comprador) || ' · ' || p_tipo_venta || ' · capital ' || to_char(v_capital, 'FM$999,999,990.00')
        || ' · ' || (cardinality(p_refs) + cardinality(p_grupos)) || ' partidas', 'revision');

    return json_build_object('id_propuesta', v_id, 'estatus', 'EN REVISIÓN', 'comprador', trim(p_comprador), 'capital', round(v_capital, 2),
                             'valor_venta', round(v_capital * p_centavos, 2), 'usuario', v_usuario);
end $$;

create or replace function public.asignar_comprador(p_id text, p_comprador text)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_p public.propuestas;
begin
    perform public._exigir_activo();
    if coalesce(trim(p_comprador), '') = '' then raise exception 'Escribe el nombre del comprador'; end if;
    select * into v_p from public.propuestas where id_propuesta = p_id for update;
    if not found then raise exception 'No existe la propuesta %', p_id; end if;
    if v_p.user_id is distinct from auth.uid() and not public.es_admin() then
        raise exception 'Sólo % o un usuario maestro pueden cambiar el comprador', v_p.usuario;
    end if;
    update public.propuestas set comprador = trim(p_comprador) where id_propuesta = p_id;
end $$;

create or replace function public.tg_propuesta_evento() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_quien text; v_ultimo text;
begin
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    v_quien := coalesce(v_quien, new.usuario, 'sistema');
    if tg_op = 'INSERT' then
        insert into public.propuesta_eventos (id_propuesta, fecha, usuario, evento, detalle)
        values (new.id_propuesta, new.fecha, v_quien, 'Creada',
                coalesce(new.tipo_venta, '') || ' · capital ' || to_char(coalesce(new.capital, 0), 'FM$999,999,990.00')
                || ' · ' || new.estatus || coalesce(' · comprador ' || nullif(new.comprador, ''), '')
                || coalesce(' · ' || nullif(new.comentario, ''), ''));
        return new;
    end if;

    if new.estatus is distinct from old.estatus then
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        values (new.id_propuesta, v_quien,
            case new.estatus when 'APROBADA' then 'Aprobada' when 'RECHAZADA' then 'Rechazada'
                             when 'EN VENTA' then 'Sub base generada' when 'LIBERADA' then 'Liberada'
                             when 'EN REVISIÓN' then 'Regresa a revisión' else new.estatus end,
            case new.estatus when 'LIBERADA' then nullif(new.motivo, '')
                             when 'APROBADA' then nullif(new.comentario, '')
                             when 'RECHAZADA' then nullif(new.comentario, '') else null end);
    end if;
    if new.comprador is distinct from old.comprador then
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        values (new.id_propuesta, v_quien, 'Comprador',
                coalesce(nullif(old.comprador, ''), '(sin comprador)') || ' → ' || coalesce(nullif(new.comprador, ''), '(sin comprador)'));
    end if;
    if new.capital is distinct from old.capital then
        v_ultimo := case when new.comentario is distinct from old.comentario
                         then regexp_replace(coalesce(new.comentario, ''), '^.*\| ', '') end;
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        values (new.id_propuesta, v_quien,
            case when new.partidas_quitadas > old.partidas_quitadas then 'Partidas quitadas por el validador'
                 when new.complementos > old.complementos then 'Complemento'
                 when v_ultimo like 'RST-%' or new.tipo_venta = 'Restitución' then 'Restitución'
                 else 'Capital modificado' end,
            to_char(coalesce(old.capital, 0), 'FM$999,999,990.00') || ' → ' || to_char(coalesce(new.capital, 0), 'FM$999,999,990.00')
            || coalesce(' · ' || nullif(v_ultimo, ''), ''));
    end if;
    return new;
end $$;

do $$
declare f text;
begin
    foreach f in array array[
        'apartar(text,numeric,numeric,text[],text[],text)',
        'asignar_comprador(text,text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
