-- ============================================================
-- DESCARGA DE LA PROPUESTA (más columnas) y PROPUESTA FINAL
--  - propuesta_descarga(id): un renglón por crédito con nombre, saldos y fechas tomados de la fila original
--    de la base (propuesta_detalle.datos). JyP no trae nombre del cliente en BASE_JYP.
--  - propuesta_final(id, refs, grupos): el validador / admin sube el archivo con las cuentas que SÍ se venden;
--    todo lo demás sale de la propuesta y se LIBERA (vuelve a disponible). Recalcula capital, precio y mora.
--    Sirve para propuestas EN REVISIÓN, APROBADA o APARTADA (migradas); no para EN VENTA (ya tiene sub base).
-- Requiere 10-31. Idempotente.
-- ============================================================
create or replace function public.propuesta_descarga(p_id text)
returns table (tipo text, vgroupid text, grupo text, vreference text, nombre text, estado text, municipio text, colonia text,
               cp text, dias numeric, capital numeric, monto_original numeric, saldo_total numeric, saldo_vencido numeric,
               fecha_apertura text, ultimo_pago text, frecuencia text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select d.tipo_cartera, d.vgroupid, d.datos->>'vGroup', d.vreference, d.datos->>'vName',
           coalesce(j.estado, g.estado), coalesce(j.municipio, g.municipio),
           coalesce(nullif(j.colonia, ''), nullif(g.colonia, ''), d.datos->>'Colonia', d.datos->>'vColonia'),
           coalesce(d.datos->>'CP', d.datos->>'C.P'),
           coalesce(j.dias, g.dias), round(d.npendingk, 2),
           public._num(d.datos->>'nAmount'), public._num(d.datos->>'nTotBalance'),
           public._num(coalesce(d.datos->>'nDueBalance', d.datos->>'nDueBalance_y', d.datos->>'nDueBalance_x')),
           d.datos->>'vOpenned', d.datos->>'vUltPago', d.datos->>'vFrecuencia'
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = p_id
     order by d.tipo_cartera, d.vgroupid nulls first, d.vreference;
end $$;

-- Archivo de propuesta final: p_refs / p_grupos = lo que SE QUEDA
create or replace function public.propuesta_final(p_id text, p_refs text[], p_grupos text[])
returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_p public.propuestas; v_quitar_refs text[]; v_quitar_grupos text[]; v_total integer; v_quitadas integer := 0;
        v_cap numeric; v_mora numeric; v_quedan integer; v_quien text; v_no_estan text[];
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador suben la propuesta final' using errcode = '42501'; end if;
    p_refs := coalesce(p_refs, '{}'); p_grupos := coalesce(p_grupos, '{}');
    select * into v_p from public.propuestas where id_propuesta = p_id for update;
    if not found then raise exception 'No existe la propuesta %', p_id; end if;
    if v_p.estatus not in ('EN REVISIÓN', 'APROBADA', 'APARTADA') then
        raise exception 'La propuesta % está %; la propuesta final sólo aplica EN REVISIÓN, APROBADA o APARTADA', p_id, v_p.estatus;
    end if;
    select count(*) into v_total from public.apartados_activos where id_propuesta = p_id;

    -- cuentas del archivo que no son de esta propuesta (se reportan, no se agregan)
    select coalesce(array_agg(x), '{}') into v_no_estan from (
        select r x from unnest(p_refs) r where not exists (select 1 from public.propuesta_detalle d where d.id_propuesta = p_id and d.tipo_cartera = 'JyP' and d.vreference = r)
        union all
        select g from unnest(p_grupos) g where not exists (select 1 from public.propuesta_detalle d where d.id_propuesta = p_id and d.tipo_cartera = 'Grupal' and d.vgroupid = g)) s;

    select coalesce(array_agg(distinct d.vreference), '{}') into v_quitar_refs
      from public.propuesta_detalle d where d.id_propuesta = p_id and d.tipo_cartera = 'JyP' and not (d.vreference = any (p_refs));
    select coalesce(array_agg(distinct d.vgroupid), '{}') into v_quitar_grupos
      from public.propuesta_detalle d where d.id_propuesta = p_id and d.tipo_cartera = 'Grupal' and not (d.vgroupid = any (p_grupos));
    if cardinality(v_quitar_refs) + cardinality(v_quitar_grupos) = v_total then
        raise exception 'Ninguna cuenta del archivo pertenece a %; revisa que sea la propuesta correcta', p_id;
    end if;

    if cardinality(v_quitar_refs) + cardinality(v_quitar_grupos) > 0 then
        delete from public.propuesta_detalle d
         where d.id_propuesta = p_id
           and ((d.tipo_cartera = 'JyP' and d.vreference = any (v_quitar_refs))
                or (d.tipo_cartera = 'Grupal' and d.vgroupid = any (v_quitar_grupos)));
        delete from public.apartados_activos a
         where a.id_propuesta = p_id
           and a.clave = any (array(select 'J:' || x from unnest(v_quitar_refs) x) || array(select 'G:' || x from unnest(v_quitar_grupos) x));
        get diagnostics v_quitadas = row_count;
        select count(*) into v_quedan from public.apartados_activos where id_propuesta = p_id;

        select coalesce(sum(d.npendingk), 0), avg(coalesce(j.dias, g.dias)) into v_cap, v_mora
          from public.propuesta_detalle d
          left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
          left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
         where d.id_propuesta = p_id;
        update public.propuestas
           set capital = round(v_cap, 2), valor_venta = round(v_cap * centavos, 2),
               dias_mora = coalesce(round(v_mora, 1), dias_mora), partidas_quitadas = partidas_quitadas + v_quitadas
         where id_propuesta = p_id;
    end if;

    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
    values (p_id, v_quien, 'Propuesta final',
            format('Quedan %s de %s partidas; %s liberadas', v_total - v_quitadas, v_total, v_quitadas)
            || case when cardinality(v_no_estan) > 0 then format('; %s cuentas del archivo no eran de la propuesta', cardinality(v_no_estan)) else '' end);
    perform public._notificar(array['validador'], v_p.user_id, '📄 Propuesta final de ' || p_id,
        format('%s · quedan %s partidas, %s regresaron a disponibles (%s)', coalesce(v_p.comprador, ''), v_total - v_quitadas, v_quitadas, v_quien),
        'bitacora');
    return json_build_object('quedan', v_total - v_quitadas, 'quitadas', v_quitadas, 'total', v_total,
        'no_estan', to_json(v_no_estan[1:50]), 'n_no_estan', cardinality(v_no_estan),
        'capital', (select capital from public.propuestas where id_propuesta = p_id),
        'valor_venta', (select valor_venta from public.propuestas where id_propuesta = p_id));
end $$;

do $$
declare f text;
begin
    foreach f in array array['propuesta_descarga(text)', 'propuesta_final(text,text[],text[])'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
