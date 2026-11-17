-- ============================================================
-- PORTAL: el comprador elige con qué créditos se queda
--  Al ACEPTAR una propuesta, el comprador marca los créditos (JyP) o grupos (Grupal) que quiere.
--  Lo que no marca se QUITA de la propuesta y regresa a la base como DISPONIBLE para vender
--  (se libera su apartado). Capital, precio y días de atraso de la propuesta se recalculan.
--  Sólo con la propuesta EN REVISIÓN o APROBADA; si ya se generó la sub base (EN VENTA) sólo
--  puede aceptar completa.
-- Requiere 25. Idempotente.
-- ============================================================

-- Detalle con el tipo de cartera (para elegir grupo completo en Grupal)
drop function if exists public.portal_detalle(text);
create or replace function public.portal_detalle(p_folio text)
returns table (tipo text, vreference text, vgroupid text, dias numeric, capital numeric, colonia text, cp text, municipio text, estado text)
language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); v_f public.funnel_ventas; v_est text;
begin
    select * into v_f from public.funnel_ventas f where f.folio = p_folio and f.comprador_id = v;
    if not found or v_f.id_propuesta is null or (v_f.publicada_en is null and v_f.estatus_venta <> 'Vendida') then
        raise exception 'No tienes acceso a %', p_folio using errcode = '42501';
    end if;
    select estatus into v_est from public.propuestas where id_propuesta = v_f.id_propuesta;
    if public._portal_situacion(v_f, v_est) = 'NO DISPONIBLE' then raise exception 'La propuesta % ya no está disponible', p_folio; end if;
    update public.funnel_ventas set vistas = vistas + 1, ultima_vista = now() where folio = p_folio;
    return query
    select d.tipo_cartera, d.vreference, d.vgroupid, coalesce(j.dias, g.dias), round(d.npendingk, 2),
           coalesce(nullif(j.colonia, ''), nullif(g.colonia, ''), d.datos->>'Colonia', d.datos->>'vColonia', d.datos->>'COLONIA'),
           coalesce(d.datos->>'CP', d.datos->>'C.P'), coalesce(j.municipio, g.municipio), coalesce(j.estado, g.estado)
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = v_f.id_propuesta
     order by d.tipo_cartera, d.vgroupid nulls first, d.vreference;
end $$;

-- Aceptar quedándose con una parte. p_refs / p_grupos = lo que SE QUEDA (null = todo).
create or replace function public.portal_aceptar(p_folio text, p_refs text[], p_grupos text[], p_comentario text)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); v_f public.funnel_ventas; v_p public.propuestas;
        v_quitar_refs text[]; v_quitar_grupos text[]; v_total integer; v_quitadas integer := 0;
        v_cap numeric; v_mora numeric; v_quedan integer; v_quien text; v_comp text; v_detalle text;
begin
    select * into v_f from public.funnel_ventas f where f.folio = p_folio and f.comprador_id = v and f.publicada_en is not null for update;
    if not found then raise exception 'No tienes acceso a %', p_folio using errcode = '42501'; end if;
    select * into v_p from public.propuestas where id_propuesta = v_f.id_propuesta for update;
    if public._portal_situacion(v_f, v_p.estatus) <> 'PENDIENTE' then
        raise exception 'La propuesta % ya no espera respuesta (%)', p_folio, public._portal_situacion(v_f, v_p.estatus);
    end if;
    select count(*) into v_total from public.apartados_activos where id_propuesta = v_p.id_propuesta;

    -- lo que NO eligió
    select coalesce(array_agg(distinct d.vreference), '{}') into v_quitar_refs
      from public.propuesta_detalle d
     where d.id_propuesta = v_p.id_propuesta and d.tipo_cartera = 'JyP' and p_refs is not null and not (d.vreference = any (p_refs));
    select coalesce(array_agg(distinct d.vgroupid), '{}') into v_quitar_grupos
      from public.propuesta_detalle d
     where d.id_propuesta = v_p.id_propuesta and d.tipo_cartera = 'Grupal' and p_grupos is not null and not (d.vgroupid = any (p_grupos));

    if cardinality(v_quitar_refs) + cardinality(v_quitar_grupos) > 0 then
        if v_p.estatus not in ('EN REVISIÓN', 'APROBADA') then
            raise exception 'Esta propuesta ya está en proceso de venta; sólo se puede aceptar completa. Habla con tu ejecutivo para cambiarla.';
        end if;
        delete from public.propuesta_detalle d
         where d.id_propuesta = v_p.id_propuesta
           and ((d.tipo_cartera = 'JyP' and d.vreference = any (v_quitar_refs))
                or (d.tipo_cartera = 'Grupal' and d.vgroupid = any (v_quitar_grupos)));
        -- liberar el apartado = vuelven a estar DISPONIBLES para vender
        delete from public.apartados_activos a
         where a.id_propuesta = v_p.id_propuesta
           and a.clave = any (array(select 'J:' || x from unnest(v_quitar_refs) x) || array(select 'G:' || x from unnest(v_quitar_grupos) x));
        get diagnostics v_quitadas = row_count;
        select count(*) into v_quedan from public.apartados_activos where id_propuesta = v_p.id_propuesta;
        if v_quedan = 0 then raise exception 'Marca al menos un crédito; si no te interesa ninguno, usa «Rechazar»'; end if;

        select coalesce(sum(d.npendingk), 0), avg(coalesce(j.dias, g.dias)) into v_cap, v_mora
          from public.propuesta_detalle d
          left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
          left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
         where d.id_propuesta = v_p.id_propuesta;
        update public.propuestas
           set capital = round(v_cap, 2), valor_venta = round(v_cap * centavos, 2),
               dias_mora = coalesce(round(v_mora, 1), dias_mora), partidas_quitadas = partidas_quitadas + v_quitadas
         where id_propuesta = v_p.id_propuesta;
    end if;

    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    select nombre into v_comp from public.compradores where id = v;
    v_detalle := case when v_quitadas > 0
                      then format('Se quedó con %s de %s %s; %s %s a disponibles', v_total - v_quitadas, v_total,
                                  case when v_p.tipo_venta = 'Grupal' then 'grupos' else 'partidas' end, v_quitadas,
                                  case when v_quitadas = 1 then 'regresó' else 'regresaron' end)
                      else 'Completa' end;
    update public.funnel_ventas
       set respuesta = 'ACEPTADA', respuesta_en = now(), respuesta_por = v_quien,
           respuesta_comentario = nullif(concat_ws(' · ', case when v_quitadas > 0 then v_detalle end, nullif(trim(p_comentario), '')), ''),
           actualizado = now(), actualizado_por = v_quien
     where folio = p_folio;
    insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
    values (v_p.id_propuesta, v_quien || ' (comprador)', 'Aceptada por el comprador',
            concat_ws(' · ', v_detalle, nullif(trim(p_comentario), '')));
    perform public._notificar(array['validador', 'auxiliar'], v_p.user_id, '👍 El comprador ACEPTÓ ' || p_folio,
        v_comp || ' · ' || v_detalle || coalesce(' · «' || nullif(trim(p_comentario), '') || '»', ''), 'funnel');
    return json_build_object('quitadas', v_quitadas, 'quedan', v_total - v_quitadas,
        'capital', (select capital from public.propuestas where id_propuesta = v_p.id_propuesta),
        'precio', (select case when estatus in ('APROBADA', 'EN VENTA') then valor_venta end from public.propuestas where id_propuesta = v_p.id_propuesta));
end $$;

do $$
declare f text;
begin
    foreach f in array array['portal_detalle(text)', 'portal_aceptar(text,text[],text[],text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
