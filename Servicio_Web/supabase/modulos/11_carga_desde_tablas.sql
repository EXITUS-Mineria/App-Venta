-- ============================================================
-- CARGA DE CARTERA DESDE LAS TABLAS BASE_JYP / BASE_GRUPAL
-- Para cuando las bases se suben a Supabase (Table Editor › Import CSV) en lugar
-- de usar CARGAR_SUPABASE.bat. Reemplaza la cartera; los apartados vigentes se conservan.
-- Se ejecuta en Supabase › SQL Editor:   select public.cargar_cartera_desde_tablas();
-- (no se expone a la página).
-- ============================================================
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
    insert into public.cartera_jyp (vreference, estado, municipio, colonia, dias, npendingk, estatus_base, datos)
    select distinct on (b."vReference")
           b."vReference", b."Estado", b."Municipio", null, b."iDays", coalesce(b."nPendingK", 0),
           b."Estatus", to_jsonb(b)
      from public."BASE_JYP" b
     where nullif(trim(b."vReference"), '') is not null
     order by b."vReference";
    get diagnostics v_jyp = row_count;

    truncate public.cartera_grupal restart identity;
    insert into public.cartera_grupal (vgroupid, vreference, estado, municipio, colonia, dias, npendingk, estatus_base, datos)
    select distinct on (b."vGroupId", b."vReference", b."iCredId")
           b."vGroupId", b."vReference", b."Estado", b."Municipio", null,
           coalesce(b."Diasatraso_hoy", b."dias hoy"), coalesce(b."nPendingK", 0), b."Estatus", to_jsonb(b)
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
