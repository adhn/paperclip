import { randomUUID } from 'node:crypto';

const occupied = ['reserved', 'starting', 'running', 'stopping', 'uncertain'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Executable admission contract, NOT connected to production dispatch.
 * Inputs are trusted host-resolved identities, never agent-selected scope keys.
 * Every mutation takes scheduler first; no external I/O is allowed in its tx.
 * Production integration must compose native claim/eligibility in the SAME tx.
 */
export function createLedger(sql, epoch) {
  async function locked(fn, requireEpoch = true) {
    return sql.begin(async tx => {
      const [scheduler] = await tx`SELECT *, clock_timestamp() AS now FROM admission_scheduler FOR UPDATE`;
      if (!scheduler || (requireEpoch && scheduler.epoch !== epoch)) throw Error('stale_controller');
      return fn(tx, scheduler);
    });
  }
  async function owned(tx, company, id, token) {
    const [a] = await tx`SELECT * FROM admission_attempts WHERE id=${id} AND company_id=${company} FOR UPDATE`;
    if (!a || a.owner_epoch !== epoch || a.token !== token) throw Error('attempt_ownership');
    return a;
  }
  async function wait(tx, id, reason) {
    await tx`UPDATE admission_attempts SET wait_reason=${reason} WHERE id=${id}`;
  }
  return {
    enqueue(input) {
      const { id = randomUUID(), company, project, operation, scopes } = input;
      if (!uuid.test(id) || !uuid.test(company) || !project || !operation ||
          !Array.isArray(scopes) || !scopes.length || scopes.some(x => typeof x !== 'string' || !x)) {
        throw Error('invalid_request');
      }
      const keys = [...new Set(scopes)].sort();
      return locked(async (tx, s) => {
        const [existing] = await tx`SELECT * FROM admission_attempts WHERE id=${id}`;
        if (existing) {
          if (existing.company_id !== company || existing.operation_key !== operation ||
              existing.project_key !== project || JSON.stringify(existing.scopes) !== JSON.stringify(keys)) {
            throw Error('request_identity_changed');
          }
          return existing;
        }
        const [{ count }] = await tx`SELECT count(*)::integer AS count FROM admission_attempts WHERE state='queued'`;
        if (count >= s.pending_limit) throw Error('queue_full');
        const known = await tx`SELECT key FROM admission_scopes WHERE key IN ${tx(keys)}`;
        if (known.length !== keys.length) throw Error('unknown_scope');
        // New projects enter at the current frontier, not ahead of all existing
        // waiters. Otherwise a stream of fresh project IDs can starve old work.
        await tx`INSERT INTO admission_projects(company_id,project_key,last_grant)
          VALUES(${company},${project},${s.sequence}) ON CONFLICT DO NOTHING`;
        const [a] = await tx`INSERT INTO admission_attempts(id,company_id,project_key,operation_key,scopes)
          VALUES(${id},${company},${project},${operation},${keys}) RETURNING *`;
        return a;
      });
    },
    grant() {
      return locked(async (tx, s) => {
        if (s.draining) return null;
        const now = new Date(s.now).getTime();
        const exempt = s.evaluation_exemption_until && new Date(s.evaluation_exemption_until).getTime() > now;
        const fresh = s.recovery_point && new Date(s.recovery_point).getTime() <= now &&
          now - new Date(s.recovery_point).getTime() < 3_600_000;
        if (!exempt && !fresh) {
          await tx`UPDATE admission_attempts SET wait_reason='backup_stale_or_unknown' WHERE state='queued'`;
          return null;
        }
        // Least recently served eligible project; FIFO within each project.
        // Cursor changes only with a committed grant. Ineligible heads can skip.
        const candidates = await tx`SELECT a.* FROM admission_attempts a JOIN admission_projects p
          ON p.company_id=a.company_id AND p.project_key=a.project_key
          WHERE a.state='queued' ORDER BY p.last_grant,a.enqueue_order`;
        for (const a of candidates) {
          if (!a.eligible) { await wait(tx, a.id, 'ineligible'); continue; }
          if (a.not_before && new Date(a.not_before).getTime() > now) { await wait(tx, a.id, 'backoff'); continue; }
          const scopes = await tx`SELECT * FROM admission_scopes WHERE key IN ${tx(a.scopes)} ORDER BY key FOR UPDATE`;
          if (scopes.length !== a.scopes.length) { await wait(tx, a.id, 'unknown_scope'); continue; }
          let reason = null;
          for (const scope of scopes) {
            if (scope.draining) { reason = 'scope_draining'; break; }
            if (scope.not_before && new Date(scope.not_before).getTime() > now) { reason = 'provider_cooldown'; break; }
            const [{ count }] = await tx`SELECT count(*)::integer AS count FROM admission_attempts
              WHERE state IN ${tx(occupied)} AND ${scope.key}=ANY(scopes)`;
            if (count >= scope.capacity) { reason = 'capacity:' + scope.key; break; }
          }
          if (reason) { await wait(tx, a.id, reason); continue; }
          const [counter] = await tx`UPDATE admission_scheduler SET sequence=sequence+1 RETURNING sequence`;
          const [granted] = await tx`UPDATE admission_attempts SET state='reserved',owner_epoch=${epoch},
            token=${randomUUID()},grant_order=${counter.sequence},wait_reason=NULL WHERE id=${a.id} RETURNING *`;
          await tx`UPDATE admission_projects SET last_grant=${counter.sequence}
            WHERE company_id=${a.company_id} AND project_key=${a.project_key}`;
          return granted;
        }
        return null;
      });
    },
    begin(company, id, token, binding) {
      const required = ['agentId','runId','environmentId','leaseId','invocationId'];
      if (!binding || required.some(k => !uuid.test(binding[k])) || !binding.runnerKey) throw Error('incomplete_binding');
      const identity = Object.fromEntries([...required, 'runnerKey'].map(k => [k, binding[k]]));
      return locked(async tx => {
        const a = await owned(tx, company, id, token);
        // Return no reusable launch capability. A lost response stays uncertain.
        if (a.state !== 'reserved') throw Error('already_started_or_stopped');
        if (!a.scopes.includes(identity.runnerKey)) throw Error('runner_binding_changed');
        const [row] = await tx`UPDATE admission_attempts SET state='starting',binding=${tx.json(identity)}
          WHERE id=${id} RETURNING *`;
        return row;
      });
    },
    cancel(company, id) {
      return locked(async tx => {
        const [a] = await tx`SELECT * FROM admission_attempts WHERE company_id=${company} AND id=${id} FOR UPDATE`;
        if (!a) throw Error('unknown_attempt');
        if (['released','cancelled'].includes(a.state)) return a;
        // Reserved is still occupied: a concurrent executor must unwind setup.
        const next = a.state === 'queued' ? 'cancelled' : 'stopping';
        const [row] = await tx`UPDATE admission_attempts SET state=${next},wait_reason=NULL WHERE id=${id} RETURNING *`;
        return row;
      });
    },
    settle(company, id, token, proof) {
      return locked(async tx => {
        const a = await owned(tx, company, id, token);
        if (a.state === 'released') return a;
        if (!occupied.includes(a.state)) throw Error('not_reserved');
        // This host-side boundary consumes verified evidence, not caller claims.
        // The production verifier must read exact remote journal/lease receipts.
        const bound = a.binding;
        if (!bound || !proof || proof.companyId !== company || proof.attemptId !== id ||
            Object.keys(bound).some(k => proof[k] !== bound[k]) ||
            proof.processStopped !== true || proof.restorationComplete !== true) throw Error('unsettled_attempt');
        const evidence = { ...bound, companyId: company, attemptId: id,
          processStopped: true, restorationComplete: true };
        const [row] = await tx`UPDATE admission_attempts SET state='released',stop_evidence=${tx.json(evidence)},
          restoration_complete=true WHERE id=${id} RETURNING *`;
        return row;
      });
    },
    takeover(nextEpoch) {
      if (!uuid.test(nextEpoch) || nextEpoch === epoch) throw Error('invalid_epoch');
      return locked(async tx => {
        await tx`UPDATE admission_scheduler SET epoch=${nextEpoch},draining=true`;
        await tx`UPDATE admission_attempts SET state='uncertain' WHERE state IN ${tx(occupied)}`;
        // No reassignment or slot release: remote fencing/reconciliation is separate.
      });
    },
    configure({ draining, recoveryPoint = null, evaluationExemptionUntil = null }) {
      if (typeof draining !== 'boolean') throw Error('invalid_policy');
      return locked(tx => tx`UPDATE admission_scheduler SET draining=${draining},
        recovery_point=${recoveryPoint},evaluation_exemption_until=${evaluationExemptionUntil}`);
    },
    scope(key, capacity, { draining = false, notBefore = null } = {}) {
      if (!key || !Number.isInteger(capacity) || capacity < 0) throw Error('invalid_capacity');
      return locked(tx => tx`INSERT INTO admission_scopes(key,capacity,draining,not_before)
        VALUES(${key},${capacity},${draining},${notBefore}) ON CONFLICT(key) DO UPDATE
        SET capacity=excluded.capacity,draining=excluded.draining,not_before=excluded.not_before,
          revision=admission_scopes.revision+1`);
    },
    eligibility(company, id, eligible, notBefore = null) {
      if (typeof eligible !== 'boolean') throw Error('invalid_eligibility');
      return locked(tx => tx`UPDATE admission_attempts SET eligible=${eligible},not_before=${notBefore}
        WHERE id=${id} AND company_id=${company} AND state='queued'`);
    },
  };
}
