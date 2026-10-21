import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createLedger } from './ledger.mjs';

// Cached pinned source test image supplies these locked dependencies.
// Network is disabled; this starts a disposable loopback-only test PostgreSQL.
const require = createRequire('/app/packages/db/package.json');
const postgres = require('postgres');
const EmbeddedPostgres = require('embedded-postgres').default;
let db, instance, ledger, epoch, company;
const clients = [];
const scopeKeys = ['instance', 'runner:codex', 'account:codex', 'credential:codex'];
before(async () => {
  instance = new EmbeddedPostgres({ databaseDir: await mkdtemp('/tmp/admission-db-'),
    user: 'fixture', password: 'fixture', port: 15439, persistent: false,
    initdbFlags: ['--encoding=UTF8','--locale=C'], onLog() {}, onError() {} });
  await instance.initialise(); await instance.start();
  db = postgres('postgres://fixture:fixture@127.0.0.1:15439/postgres', { max: 12 });
  await db.unsafe(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
});
after(async () => {
  await Promise.all(clients.map(x => x.end()));
  await db?.end(); await instance?.stop();
});
beforeEach(async () => {
  await db`TRUNCATE admission_attempts,admission_projects,admission_scopes,admission_scheduler RESTART IDENTITY`;
  epoch=randomUUID(); company=randomUUID(); ledger=createLedger(db,epoch);
  await db`INSERT INTO admission_scheduler(epoch,pending_limit) VALUES(${epoch},12)`;
  for (const key of scopeKeys) await ledger.scope(key,1);
  await ledger.configure({draining:false,evaluationExemptionUntil:new Date(Date.now()+60_000)});
});
const request = (project='A', extra={}) => ledger.enqueue({company,project,operation:randomUUID(),scopes:scopeKeys,...extra});
const binding = () => Object.fromEntries(['agentId','runId','environmentId','leaseId','invocationId'].map(k=>[k,randomUUID()]).concat([['runnerKey','runner:codex']]));
async function finish(a) {
  const b=binding(); await ledger.begin(company,a.id,a.token,b);
  return ledger.settle(company,a.id,a.token,{...b,companyId:company,attemptId:a.id,processStopped:true,restorationComplete:true});
}
test('independent dispatcher clients cannot overbook any scope', async () => {
  await Promise.all(Array.from({length:12},(_,i)=>request('P'+i%3)));
  const dispatchers=Array.from({length:8},()=>{
    const client=postgres('postgres://fixture:fixture@127.0.0.1:15439/postgres',{max:1});clients.push(client);
    return createLedger(client,epoch);
  });
  const granted=(await Promise.all(dispatchers.map(x=>x.grant()))).filter(Boolean);
  assert.equal(granted.length,1);
  assert.equal((await db`SELECT count(*)::int AS n FROM admission_attempts WHERE state='queued'`)[0].n,11);
});
test('durable round robin serves three projects within three grants; FIFO survives service recreation', async () => {
  const ids={A:[],B:[],C:[]};
  for(const p of Object.keys(ids)) for(let i=0;i<4;i++) ids[p].push((await request(p)).id);
  const order=[];
  for(let i=0;i<12;i++) {
    ledger=createLedger(db,epoch);
    const a=await ledger.grant();order.push(a.project_key);
    assert.equal(a.id,ids[a.project_key].shift());await finish(a);
  }
  assert.deepEqual(order,['A','B','C','A','B','C','A','B','C','A','B','C']);
});
test('capacity two remains serialized by credential scope until independently qualified', async () => {
  for(const k of scopeKeys.filter(x=>!x.startsWith('credential'))) await ledger.scope(k,2);
  await request();await request('B');
  const a=await ledger.grant();assert.ok(a);assert.equal(await ledger.grant(),null);
  await ledger.scope('credential:codex',2);assert.ok(await ledger.grant());
});
test('queue ceiling is atomic and idempotent acceptance does not consume another place',async()=>{
  const input={id:randomUUID(),operation:'stable'};
  const first=await request('A',input);assert.equal((await request('A',input)).id,first.id);
  const outcomes=await Promise.allSettled(Array.from({length:20},()=>request()));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,11);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,9);
  await assert.rejects(request('B',input),/identity_changed/);
});
test('unknown scope and second unsettled attempt for one operation fail closed',async()=>{
  await assert.rejects(request('A',{scopes:['unknown']}),/unknown_scope/);
  await request('A',{operation:'same'});
  await assert.rejects(request('B',{operation:'same'}),/admission_operation_unsettled/);
});
test('cancel winning the grant race cannot start; grant winning retains capacity',async()=>{
  for(let i=0;i<20;i++) {
    const a=await request();
    const [g]=await Promise.all([ledger.grant(),ledger.cancel(company,a.id)]);
    const [r]=await db`SELECT * FROM admission_attempts WHERE id=${a.id}`;
    assert.ok(['cancelled','stopping'].includes(r.state));
    if(g) {
      assert.equal(r.state,'stopping');
      await assert.rejects(ledger.begin(company,g.id,g.token,binding()),/already_started/);
      // A real reconciliation protocol is required for this hold; test stops here.
      assert.equal(await ledger.grant(),null);break;
    } else assert.equal(r.state,'cancelled');
  }
});
test('queued cancellation releases no execution slot and leaves sibling intact',async()=>{
  const a=await request();const b=await request('B');
  await ledger.cancel(company,a.id);assert.equal((await ledger.grant()).id,b.id);
  assert.equal((await ledger.cancel(company,a.id)).state,'cancelled');
});
test('start token is single use and exact company/attempt/binding is required',async()=>{
  await request();const a=await ledger.grant();const b=binding();
  await assert.rejects(ledger.begin(randomUUID(),a.id,a.token,b),/ownership/);
  await assert.rejects(ledger.begin(company,a.id,randomUUID(),b),/ownership/);
  await assert.rejects(ledger.begin(company,a.id,a.token,{...b,runnerKey:'runner:other'}),/runner_binding/);
  await ledger.begin(company,a.id,a.token,b);
  await assert.rejects(ledger.begin(company,a.id,a.token,b),/already_started/);
  await ledger.cancel(company,a.id);
  assert.equal(await ledger.grant(),null);
});
test('stop alone or restoration alone cannot release; sibling evidence rejected',async()=>{
  await request();const a=await ledger.grant();const b=binding();await ledger.begin(company,a.id,a.token,b);
  const proof={...b,companyId:company,attemptId:a.id,processStopped:true,restorationComplete:true};
  for(const key of ['agentId','runId','environmentId','leaseId','invocationId','companyId','attemptId']) {
    await assert.rejects(ledger.settle(company,a.id,a.token,{...proof,[key]:randomUUID()}),/unsettled/);
  }
  for(const key of ['processStopped','restorationComplete']) await assert.rejects(ledger.settle(company,a.id,a.token,{...proof,[key]:false}),/unsettled/);
  assert.equal((await ledger.settle(company,a.id,a.token,proof)).state,'released');
  assert.equal((await ledger.settle(company,a.id,a.token,proof)).state,'released');
});
test('takeover drains, fences old owner and preserves uncertain occupancy indefinitely',async()=>{
  await request();const a=await ledger.grant();const b=binding();await ledger.begin(company,a.id,a.token,b);
  const next=randomUUID();await ledger.takeover(next);
  await assert.rejects(ledger.grant(),/stale_controller/);
  await assert.rejects(ledger.settle(company,a.id,a.token,{...b,companyId:company,attemptId:a.id,processStopped:true,restorationComplete:true}),/stale_controller/);
  ledger=createLedger(db,next);assert.equal(await ledger.grant(),null);
  await ledger.configure({draining:false,evaluationExemptionUntil:new Date(Date.now()+60_000)});
  await request('B');assert.equal(await ledger.grant(),null);
  assert.equal((await db`SELECT state FROM admission_attempts WHERE id=${a.id}`)[0].state,'uncertain');
});
test('lowering capacity never kills admitted work; zero and drain block successors',async()=>{
  await request();const a=await ledger.grant();await request('B');
  await ledger.scope('runner:codex',0);assert.equal(await ledger.grant(),null);
  await finish(a);assert.equal(await ledger.grant(),null);
  await ledger.scope('runner:codex',1,{draining:true});assert.equal(await ledger.grant(),null);
  await ledger.scope('runner:codex',1);assert.ok(await ledger.grant());
});
test('cooldown and ineligible heads skip without advancing project grant history',async()=>{
  const a=await request();await ledger.eligibility(company,a.id,false);
  const b=await request('B');assert.equal((await ledger.grant()).id,b.id);
  assert.equal((await db`SELECT last_grant FROM admission_projects WHERE project_key='A'`)[0].last_grant,'0');
  await ledger.scope('account:codex',1,{notBefore:new Date(Date.now()+60_000)});
  await ledger.eligibility(company,a.id,true);assert.equal(await ledger.grant(),null);
});
test('unknown, stale and future backup points fail closed; explicit disposable exemption expires',async()=>{
  await request();
  for(const recoveryPoint of [null,new Date(Date.now()-3_600_001),new Date(Date.now()+60_000)]) {
    await ledger.configure({draining:false,recoveryPoint});assert.equal(await ledger.grant(),null);
  }
  await ledger.configure({draining:false,evaluationExemptionUntil:new Date(Date.now()-1)});assert.equal(await ledger.grant(),null);
  await ledger.configure({draining:false,recoveryPoint:new Date()});assert.ok(await ledger.grant());
});
test('transaction rollback does not advance fairness or leave a partial reservation',async()=>{
  await request();
  await db.unsafe(`CREATE FUNCTION fail_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state='reserved' THEN RAISE EXCEPTION 'injected_grant_failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_grant BEFORE UPDATE ON admission_attempts FOR EACH ROW EXECUTE FUNCTION fail_grant();`);
  try {
    await assert.rejects(ledger.grant(),/injected_grant_failure/);
    assert.equal((await db`SELECT sequence FROM admission_scheduler`)[0].sequence,'0');
    assert.equal((await db`SELECT state FROM admission_attempts`)[0].state,'queued');
  } finally { await db.unsafe('DROP TRIGGER reject_grant ON admission_attempts; DROP FUNCTION fail_grant();'); }
  assert.ok(await ledger.grant());
});
test('instance cap spans providers and one account cooldown leaves another runnable',async()=>{
  const claude=['instance','runner:claude','account:claude','credential:claude'];
  for(const k of claude.slice(1)) await ledger.scope(k,1);
  await request();const b=await request('B',{scopes:claude});
  await ledger.scope('account:codex',1,{notBefore:new Date(Date.now()+60_000)});
  assert.equal((await ledger.grant()).id,b.id);
  await ledger.scope('account:codex',1);assert.equal(await ledger.grant(),null);
  await ledger.scope('instance',2);assert.ok(await ledger.grant());
});
test('disconnected dispatcher cannot lose a committed reservation',async()=>{
  await request();
  const client=postgres('postgres://fixture:fixture@127.0.0.1:15439/postgres',{max:1});
  const separate=createLedger(client,epoch);const a=await separate.grant();await client.end();
  await request('B');assert.equal(await ledger.grant(),null);
  const [saved]=await db`SELECT * FROM admission_attempts WHERE id=${a.id}`;
  assert.equal(saved.state,'reserved');assert.equal(saved.token,a.token);
});
test('scope order cannot deadlock competing callers and failed multi-scope grant takes no partial slot',async()=>{
  await ledger.scope('runner:codex',0);
  await Promise.all([request('A'),request('B',{scopes:[...scopeKeys].reverse()})]);
  assert.deepEqual(await Promise.all([ledger.grant(),ledger.grant()]),[null,null]);
  assert.equal((await db`SELECT count(*)::int AS n FROM admission_attempts WHERE state='reserved'`)[0].n,0);
  await ledger.scope('runner:codex',1);
  assert.equal((await Promise.all([ledger.grant(),ledger.grant()])).filter(Boolean).length,1);
});
test('new project arrivals cannot continually jump ahead of an existing eligible project',async()=>{
  await request('A');await request('A');await request('B');await request('B');
  let a=await ledger.grant();assert.equal(a.project_key,'A');await finish(a);
  a=await ledger.grant();assert.equal(a.project_key,'B');await finish(a);
  await request('new-project');
  a=await ledger.grant();assert.equal(a.project_key,'A');await finish(a);
  await request('newer-project');
  a=await ledger.grant();assert.equal(a.project_key,'B');await finish(a);
});
