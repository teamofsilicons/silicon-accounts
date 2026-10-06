//! The claim pipeline the webhook and message loops run on.
//!
//! A claim (a webhook delivery's lease, an outbound message's claim) makes a row exclusive to
//! one worker for 60 s; after that any node may claim it again. So a worker must never hold a
//! claim it isn't working on: a claimed row that waits in a local queue while its claim runs
//! down gets claimed and sent a second time by another node.
//!
//! The pipeline therefore claims only as many rows as it has free slots (`concurrency`) and
//! starts each one the moment it is claimed. Every claimed row is in flight, and one send is
//! bounded by its HTTP timeout (10 s), far inside the claim. When a slot frees up the pipeline
//! claims again (right away while work keeps coming, every `idle_poll` otherwise), so a slow
//! endpoint only ever holds its own slot. On shutdown it stops claiming and lets the rows in
//! flight finish, which takes at most about one send timeout.
//!
//! Each row's work also gets a deadline, [`CLAIM_BUDGET`] after the claim was requested, which
//! callers enforce (`tokio::time::timeout_at`): whatever stalls past it (a database outage) is
//! abandoned instead of outliving the claim, and the row is retried once its claim ends.

use std::future::Future;
use std::time::Duration;

use accounts_core::ApiResult;
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::Shutdown;

/// How long a claim is exclusive: core's message claim (`delivery::CLAIM_SECONDS`) and the
/// webhook lease ([`crate::webhooks::LEASE_SECONDS`]).
pub const CLAIM_SECONDS: u64 = accounts_core::delivery::CLAIM_SECONDS as u64;

/// Longest one claimed row may be worked on, counted from just before the claim was requested:
/// 10 s inside the 60 s claim, leaving room for clock and database latency. A send takes at most
/// its 10 s HTTP timeout, so only a stall (a database outage) ever reaches it.
pub const CLAIM_BUDGET: Duration = Duration::from_secs(50);

/// The deadline for rows claimed at `claimed_at`.
pub fn deadline(claimed_at: Instant) -> Instant {
    claimed_at + CLAIM_BUDGET
}

/// How a loop claims and works.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pipeline {
    /// Loop name for logs (`webhooks`, `messages`).
    pub name: &'static str,
    /// Rows in flight at most (≥ 1).
    pub concurrency: usize,
    /// Wait before looking again when fewer rows were due than slots were free.
    pub idle_poll: Duration,
    /// Wait before claiming again after a claim failed (database unavailable).
    pub error_backoff: Duration,
}

impl Pipeline {
    /// Runs until `shutdown` triggers and the rows in flight have finished.
    ///
    /// `claim(n)` claims up to `n` due rows; `work(row, claimed_at)` handles one claimed row
    /// (its own errors included) and is spawned at once.
    pub(crate) async fn run<T, Claim, ClaimFut, Work, WorkFut>(
        self,
        mut shutdown: Shutdown,
        mut claim: Claim,
        work: Work,
    ) where
        T: Send + 'static,
        Claim: FnMut(usize) -> ClaimFut,
        ClaimFut: Future<Output = ApiResult<Vec<T>>>,
        Work: Fn(T, Instant) -> WorkFut,
        WorkFut: Future<Output = ()> + Send + 'static,
    {
        let concurrency = self.concurrency.max(1);
        let mut in_flight: JoinSet<()> = JoinSet::new();
        let mut next_claim = Instant::now();
        loop {
            let stopping = shutdown.is_triggered();
            if !stopping && in_flight.len() < concurrency && Instant::now() >= next_claim {
                let free = concurrency - in_flight.len();
                let claimed_at = Instant::now();
                match claim(free).await {
                    Ok(rows) => {
                        // A full claim means more may be due: claim again as soon as a slot
                        // frees up. Otherwise look again after the idle poll.
                        next_claim = if rows.len() >= free {
                            claimed_at
                        } else {
                            claimed_at + self.idle_poll
                        };
                        for row in rows {
                            in_flight.spawn(work(row, claimed_at));
                        }
                    }
                    Err(e) => {
                        tracing::error!(
                            worker_loop = self.name,
                            error = %e,
                            retry_in_seconds = self.error_backoff.as_secs(),
                            "could not claim due work; trying again shortly"
                        );
                        next_claim = Instant::now() + self.error_backoff;
                    }
                }
                continue;
            }
            if stopping && in_flight.is_empty() {
                break;
            }
            // At least one branch is always enabled: while not stopping the shutdown branch is,
            // and while stopping there is work in flight (otherwise the loop ended above).
            tokio::select! {
                joined = in_flight.join_next(), if !in_flight.is_empty() => {
                    if let Some(Err(e)) = joined
                        && e.is_panic()
                    {
                        tracing::error!(worker_loop = self.name, error = %e, "a worker task panicked; its row is retried when its claim ends");
                    }
                }
                _ = tokio::time::sleep_until(next_claim), if !stopping && in_flight.len() < concurrency => {}
                _ = shutdown.triggered(), if !stopping => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// A queue of `total` rows claimed through the pipeline by a slow worker.
    #[tokio::test]
    async fn claims_only_free_slots_and_drains_on_shutdown() {
        let total = 23usize;
        let next = Arc::new(AtomicUsize::new(0));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_claimed_unfinished = Arc::new(AtomicUsize::new(0));
        let claimed_unfinished = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(Mutex::new(Vec::new()));
        let (stop, shutdown) = Shutdown::channel();
        let pipeline = Pipeline {
            name: "test",
            concurrency: 4,
            idle_poll: Duration::from_millis(20),
            error_backoff: Duration::from_millis(20),
        };
        let run = {
            let next = next.clone();
            let in_flight = in_flight.clone();
            let max_cu = max_claimed_unfinished.clone();
            let cu = claimed_unfinished.clone();
            let cu2 = claimed_unfinished.clone();
            let done = done.clone();
            tokio::spawn(pipeline.run(
                shutdown,
                move |n| {
                    let next = next.clone();
                    let cu = cu.clone();
                    let max_cu = max_cu.clone();
                    async move {
                        // The pipeline claims from one task, one claim at a time.
                        let start = next.load(Ordering::SeqCst);
                        let end = (start + n).min(total);
                        next.store(end, Ordering::SeqCst);
                        let now = cu.fetch_add(end - start, Ordering::SeqCst) + (end - start);
                        max_cu.fetch_max(now, Ordering::SeqCst);
                        Ok((start..end).collect::<Vec<usize>>())
                    }
                },
                move |row, _claimed_at| {
                    let in_flight = in_flight.clone();
                    let cu = cu2.clone();
                    let done = done.clone();
                    async move {
                        in_flight.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30 + (row as u64 % 3) * 20)).await;
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                        cu.fetch_sub(1, Ordering::SeqCst);
                        done.lock().expect("lock").push(row);
                    }
                },
            ))
        };
        // Everything is worked once, never more than 4 claimed at a time.
        for _ in 0..200 {
            if done.lock().expect("lock").len() == total {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        stop.send(true).expect("stop");
        tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .expect("the pipeline stops")
            .expect("no panic");
        let mut rows = done.lock().expect("lock").clone();
        rows.sort_unstable();
        assert_eq!(rows, (0..total).collect::<Vec<_>>());
        assert!(
            max_claimed_unfinished.load(Ordering::SeqCst) <= 4,
            "claimed {} rows at once with 4 slots",
            max_claimed_unfinished.load(Ordering::SeqCst)
        );
    }

    #[tokio::test]
    async fn shutdown_waits_for_rows_in_flight_and_claims_nothing_new() {
        let claims = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let (stop, shutdown) = Shutdown::channel();
        let pipeline = Pipeline {
            name: "test",
            concurrency: 2,
            idle_poll: Duration::from_millis(10),
            error_backoff: Duration::from_millis(10),
        };
        let run = {
            let claims = claims.clone();
            let finished = finished.clone();
            tokio::spawn(pipeline.run(
                shutdown,
                move |n| {
                    let claims = claims.clone();
                    async move {
                        claims.fetch_add(n, Ordering::SeqCst);
                        Ok(vec![(); n])
                    }
                },
                move |(), _| {
                    let finished = finished.clone();
                    async move {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        finished.fetch_add(1, Ordering::SeqCst);
                    }
                },
            ))
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop.send(true).expect("stop");
        tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .expect("the pipeline stops")
            .expect("no panic");
        assert_eq!(
            claims.load(Ordering::SeqCst),
            2,
            "nothing claimed after the first full claim"
        );
        assert_eq!(
            finished.load(Ordering::SeqCst),
            2,
            "rows in flight finish before it returns"
        );
    }

    #[tokio::test]
    async fn claim_errors_back_off_and_recover() {
        let calls = Arc::new(AtomicUsize::new(0));
        let worked = Arc::new(AtomicUsize::new(0));
        let (stop, shutdown) = Shutdown::channel();
        let pipeline = Pipeline {
            name: "test",
            concurrency: 3,
            idle_poll: Duration::from_millis(10),
            error_backoff: Duration::from_millis(50),
        };
        let run = {
            let calls = calls.clone();
            let worked = worked.clone();
            tokio::spawn(pipeline.run(
                shutdown,
                move |_n| {
                    let calls = calls.clone();
                    async move {
                        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            Err(accounts_core::ApiError::internal("database down"))
                        } else {
                            Ok(vec![1u8])
                        }
                    }
                },
                move |_, _| {
                    let worked = worked.clone();
                    async move {
                        worked.fetch_add(1, Ordering::SeqCst);
                    }
                },
            ))
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        stop.send(true).expect("stop");
        tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .expect("the pipeline stops")
            .expect("no panic");
        assert!(
            worked.load(Ordering::SeqCst) >= 1,
            "it recovers after the error"
        );
        // 200 ms with a 50 ms backoff then 10 ms polls: far fewer calls than a busy loop.
        assert!(
            calls.load(Ordering::SeqCst) < 40,
            "{}",
            calls.load(Ordering::SeqCst)
        );
    }
}
