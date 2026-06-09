-- M2: strengthen reconcile single-flight from per-STEP to per-DEPLOYMENT.
--
-- The 000029 index (provisioning_jobs_reconcile_step_inflight) is keyed on
-- operation_step_id, so two CONCURRENT applies — each creating its own
-- operation_step for the same deployment — produced different step IDs and
-- both enqueued a reconcile job for that deployment (the decideApplyStep
-- busy-check is a SELECT that can't see the other tx's uncommitted insert).
-- That double-applied: two restarts racing the Convex single-writer lease,
-- or two creates colliding on the container name.
--
-- This index makes "at most one un-finished reconcile job per deployment" a
-- DB invariant regardless of step. EnqueueReconcile uses ON CONFLICT DO
-- NOTHING against it, so the loser of the race is cleanly skipped, not a
-- second mutation.

-- Defensive: if a pre-index race already left >1 in-flight reconcile job for
-- a deployment, fail the extras (keep the lowest id) so CREATE UNIQUE INDEX
-- can build on a populated DB instead of erroring and bricking startup.
UPDATE provisioning_jobs p
   SET status = 'failed', finished_at = now(),
       error = COALESCE(NULLIF(error, ''),
                        'superseded: duplicate in-flight reconcile (single-flight migration)')
 WHERE p.kind = 'reconcile'
   AND p.status IN ('pending', 'claimed')
   AND EXISTS (
       SELECT 1 FROM provisioning_jobs q
        WHERE q.deployment_id = p.deployment_id
          AND q.kind = 'reconcile'
          AND q.status IN ('pending', 'claimed')
          AND q.id < p.id
   );

CREATE UNIQUE INDEX provisioning_jobs_reconcile_deployment_inflight
    ON provisioning_jobs (deployment_id)
    WHERE kind = 'reconcile' AND status IN ('pending', 'claimed');
