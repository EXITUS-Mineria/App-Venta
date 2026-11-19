-- ============================================================
-- VENTAS DUPLICADAS: SÓLO EL ADMINISTRADOR
--  El rol «admin» (no el validador ni otros perfiles) consulta y marca los duplicados.
--  ventas_duplicadas() queda como envoltura de _ventas_duplicadas_base() con la validación.
--  propuesta_ya_vendidas() (aviso en Revisión) no cambia.
-- Requiere 40. Idempotente.
-- ============================================================
create or replace function public._es_administrador() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo and rol = 'admin')
$$;
revoke all on function public._es_administrador() from public, anon;
grant execute on function public._es_administrador() to authenticated;

do $$
begin
    if not exists (select 1 from pg_proc where proname = '_ventas_duplicadas_base' and pronamespace = 'public'::regnamespace) then
        alter function public.ventas_duplicadas() rename to _ventas_duplicadas_base;
    end if;
    revoke all on function public._ventas_duplicadas_base() from public, anon, authenticated;
end $$;

create or replace function public.ventas_duplicadas()
returns table (tipo text, clave text, n_ventas integer, integrantes_repetidos integer, mismo_credito boolean,
               ventas json, restituido text, revision text, comentario text, revisado_por text, revisado_en timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not public._es_administrador() then
        raise exception 'Sólo el administrador ve las ventas duplicadas' using errcode = '42501';
    end if;
    return query select * from public._ventas_duplicadas_base();
end $$;

create or replace function public.duplicado_marcar(p_tipo text, p_clave text, p_estatus text, p_comentario text default null)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_quien text;
begin
    perform public._exigir_activo();
    if not public._es_administrador() then
        raise exception 'Sólo el administrador revisa las ventas duplicadas' using errcode = '42501';
    end if;
    if p_estatus not in ('Pendiente', 'En revisión', 'Justificado') then raise exception 'Estatus no válido: %', p_estatus; end if;
    if p_estatus = 'Justificado' and nullif(trim(coalesce(p_comentario, '')), '') is null then
        raise exception 'Escribe por qué está justificado (p. ej. otro ciclo del grupo)';
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    insert into public.duplicados_revision (tipo, clave, estatus, comentario, usuario, actualizado)
    values (p_tipo, trim(p_clave), p_estatus, nullif(trim(coalesce(p_comentario, '')), ''), v_quien, now())
    on conflict (tipo, clave) do update
       set estatus = excluded.estatus,
           comentario = coalesce(excluded.comentario, public.duplicados_revision.comentario),
           usuario = excluded.usuario, actualizado = now();
end $$;

do $$
declare f text;
begin
    foreach f in array array['ventas_duplicadas()', 'duplicado_marcar(text,text,text,text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
