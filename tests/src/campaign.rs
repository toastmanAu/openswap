//! Seeded campaign parameters shared by the corpus tests (also included by
//! path from other test crates). With no CAMPAIGN_* variables set, every test
//! keeps its fixed CI seed and case count.
//!
//! Stopping criteria: the case budget (`stop=budget`), the optional wall-clock
//! budget (`stop=time`, a partial run), or the first failing case
//! (`stop=failure`, re-raised after printing the case to reproduce).
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::time::{Duration, Instant};

pub struct Campaign {
    target: &'static str,
    seed: Option<u64>,
    cases: u64,
    deadline: Option<Instant>,
    started: Instant,
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .map(|v| v.parse().unwrap_or_else(|_| panic!("{name} must be a u64")))
}

impl Campaign {
    pub fn from_env(target: &'static str, default_cases: u64) -> Self {
        let started = Instant::now();
        Self {
            target,
            seed: env_u64("CAMPAIGN_SEED"),
            cases: env_u64("CAMPAIGN_CASES").unwrap_or(default_cases),
            deadline: env_u64("CAMPAIGN_SECONDS").map(|s| started + Duration::from_secs(s)),
            started,
        }
    }

    /// The fixed CI state, or a non-zero xorshift state derived from the seed.
    pub fn state(&self, default: u64) -> u64 {
        match self.seed {
            None => default,
            Some(seed) => {
                // splitmix64 finalizer spreads small seeds; xorshift needs non-zero.
                let mut z = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
                z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
                (z ^ (z >> 31)).max(1)
            }
        }
    }

    /// Runs `case` for each index until a stopping criterion and prints one
    /// `CAMPAIGN` summary line.
    pub fn run(&self, mut case: impl FnMut(u64)) {
        let mut executed = 0;
        let mut stop = "budget";
        while executed < self.cases {
            if self.deadline.is_some_and(|d| Instant::now() >= d) {
                stop = "time";
                break;
            }
            if let Err(panic) = catch_unwind(AssertUnwindSafe(|| case(executed))) {
                self.report(executed, "failure", Some(executed));
                resume_unwind(panic);
            }
            executed += 1;
        }
        self.report(executed, stop, None);
    }

    fn report(&self, executed: u64, stop: &str, failed: Option<u64>) {
        let seed = self
            .seed
            .map_or_else(|| "default".to_string(), |s| s.to_string());
        let failed = failed.map_or_else(String::new, |c| format!(" failed_case={c}"));
        println!(
            "CAMPAIGN target={} seed={seed} budget={} executed={executed} stop={stop}{failed} elapsed_ms={}",
            self.target,
            self.cases,
            self.started.elapsed().as_millis()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn campaign(seed: Option<u64>, cases: u64) -> Campaign {
        Campaign {
            target: "self-test",
            seed,
            cases,
            deadline: None,
            started: Instant::now(),
        }
    }

    #[test]
    fn stops_at_first_failure_and_reraises() {
        let mut seen = Vec::new();
        let result = catch_unwind(AssertUnwindSafe(|| {
            campaign(None, 10).run(|case| {
                seen.push(case);
                assert!(case != 3, "injected failure");
            })
        }));
        assert!(result.is_err());
        assert_eq!(seen, [0, 1, 2, 3]);
    }

    #[test]
    fn default_state_is_unchanged_and_seeds_are_distinct_non_zero() {
        assert_eq!(campaign(None, 1).state(42), 42);
        let states: std::collections::BTreeSet<_> =
            (0..1000).map(|s| campaign(Some(s), 1).state(42)).collect();
        assert_eq!(states.len(), 1000);
        assert!(!states.contains(&0));
        let mut count = 0;
        campaign(None, 7).run(|_| count += 1);
        assert_eq!(count, 7);
    }
}
