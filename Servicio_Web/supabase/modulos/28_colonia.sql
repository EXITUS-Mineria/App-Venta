-- ============================================================
-- COLONIA EN LA CARTERA
--  BASE_JYP y BASE_GRUPAL todavía no traen colonia. En cuanto la carga mensual traiga una columna
--  Colonia / COLONIA / vColonia / Colonia_cliente, cargar_cartera_desde_tablas() la toma sola y sale en
--  el portal del comprador, el Excel de la propuesta y Armar propuesta. Sin columna, queda vacía.
-- Requiere 21. Idempotente.
-- ============================================================
create or replace function public.cargar_cartera_desde_tablas()
returns json
language plpgsql security definer set search_path = public as $function$
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
           b."vReference", b."Estado", b."Municipio",
           nullif(trim(coalesce(to_jsonb(b)->>'Colonia', to_jsonb(b)->>'COLONIA', to_jsonb(b)->>'vColonia', to_jsonb(b)->>'Colonia_cliente')), ''),
           public._num(b."iDays"::text), coalesce(public._num(b."nPendingK"::text), 0), b."Estatus"
      from public."BASE_JYP" b
     where nullif(trim(b."vReference"), '') is not null
     order by b."vReference";
    get diagnostics v_jyp = row_count;

    truncate public.cartera_grupal restart identity;
    insert into public.cartera_grupal (vgroupid, vreference, estado, municipio, colonia, dias, npendingk, estatus_base)
    select distinct on (b."vGroupId", b."vReference", b."iCredId")
           b."vGroupId", b."vReference", b."Estado", b."Municipio",
           nullif(trim(coalesce(to_jsonb(b)->>'Colonia', to_jsonb(b)->>'COLONIA', to_jsonb(b)->>'vColonia', to_jsonb(b)->>'Colonia_cliente')), ''),
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
end $function$;
