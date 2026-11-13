-- ============================================================
-- COMPLEMENTAR · agregar más cartera a una venta existente (ventas parciales).
--  - Dueño de la propuesta o usuario maestro.
--  - Lo agregado se aparta igual que en una propuesta nueva (todo o nada, con candado).
--  - Si la propuesta ya estaba APROBADA o EN VENTA regresa a EN REVISIÓN para que el validador
--    revise el complemento y el auxiliar regenere la sub base.
-- Requiere 10-15. Idempotente.
-- ============================================================
alter table public.propuestas add column if not exists complementos integer not null default 0;

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
    select p_id, 'JyP', j.vreference, null, j.npendingk, d.datos
      from public.cartera_jyp j left join public.cartera_jyp_datos d using (vreference)
     where j.vreference = any (p_refs)
    union all
    select p_id, 'Grupal', g.vreference, g.vgroupid, g.npendingk, d.datos
      from public.cartera_grupal g left join public.cartera_grupal_datos d using (id)
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
revoke all on function public.complementar_propuesta(text,text[],text[]) from public, anon;
grant execute on function public.complementar_propuesta(text,text[],text[]) to authenticated;
