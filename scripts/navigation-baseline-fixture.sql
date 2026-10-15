\set ON_ERROR_STOP on
-- SP0 synthetic masters only. Called by the existing disposable performance workflow.
-- It is not an operator/live script; no URL or credentials are embedded here.
insert into public.parties(tenant_id,name,created_by,client_id)
select :'perf_tenant'::uuid,'Baseline Supplier '||g,:'perf_user'::uuid,'sp0-supplier-'||g
from generate_series(1,8) g;
insert into public.customers(tenant_id,name,created_by,client_id)
select :'perf_tenant'::uuid,'Baseline Customer '||g,:'perf_user'::uuid,'sp0-customer-'||g
from generate_series(1,8) g;
