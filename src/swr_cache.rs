//! Generic thread-safe Single-Flight Background SWR Prewarm & Coalescing Cache.
//!
//! Guarantees:
//! - Warm reads (`get_or_trigger_refresh`) return in `<1 ms` without EVER blocking
//!   the caller on slow CLI, disk, or hardware I/O.
//! - At most one background refresh thread is in-flight at any moment (single-flight
//!   coalescing across concurrent callers).
//! - Monotonic `rev` counter + `is_unchanged(since_rev)` enable 0-byte unchanged polling.
//! - Optional bounded cold wait on initial boot prevents thundering herds while never
//!   hanging indefinitely.

use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Configuration for [`SwrCache`].
#[derive(Debug, Clone)]
pub struct SwrConfig {
    /// Duration a cached value stays fresh before background revalidation triggers.
    pub fresh_ttl: Duration,
    /// Optional bounded wait for cold callers when no cached value exists yet.
    /// Set to `Duration::ZERO` to fail fast without waiting on a cold cache.
    pub cold_wait_timeout: Duration,
    /// Minimum cooldown after a failed background refresh before retrying automatically.
    pub error_backoff: Duration,
    /// Name assigned to spawned background refresh threads.
    pub thread_name: String,
}

impl Default for SwrConfig {
    fn default() -> Self {
        Self {
            fresh_ttl: Duration::from_secs(2),
            cold_wait_timeout: Duration::from_millis(500),
            error_backoff: Duration::ZERO,
            thread_name: "agy-swr-refresh".to_string(),
        }
    }
}

/// Snapshot returned by [`SwrCache::get_or_trigger_refresh`].
#[derive(Debug)]
pub struct SwrSnapshot<T> {
    pub value: Arc<T>,
    pub rev: u64,
    pub stale: bool,
}

impl<T> Clone for SwrSnapshot<T> {
    fn clone(&self) -> Self {
        Self {
            value: Arc::clone(&self.value),
            rev: self.rev,
            stale: self.stale,
        }
    }
}

struct SwrState<T> {
    value: Option<Arc<T>>,
    rev: u64,
    updated_at: Option<Instant>,
    forced_stale: bool,
    in_flight: bool,
    last_error: Option<String>,
    last_error_at: Option<Instant>,
}

struct SwrInner<T> {
    config: SwrConfig,
    loader: Arc<dyn Fn() -> Result<T, String> + Send + Sync>,
    state: Mutex<SwrState<T>>,
    cvar: Condvar,
}

/// Ensures `in_flight` is cleared and waiting threads are woken even if the loader panics.
struct InFlightGuard<T> {
    inner: Arc<SwrInner<T>>,
    completed: bool,
}

impl<T> Drop for InFlightGuard<T> {
    fn drop(&mut self) {
        if !self.completed {
            let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            st.in_flight = false;
            st.last_error = Some("background refresh panicked".to_string());
            st.last_error_at = Some(Instant::now());
            self.inner.cvar.notify_all();
        }
    }
}

/// Thread-safe Single-Flight Background Stale-While-Revalidate (SWR) cache.
pub struct SwrCache<T: Send + Sync + 'static> {
    inner: Arc<SwrInner<T>>,
}

impl<T: Send + Sync + 'static> Clone for SwrCache<T> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<T: Send + Sync + 'static> SwrCache<T> {
    /// Creates a new SWR cache with the given configuration and blocking loader closure.
    pub fn new(
        config: SwrConfig,
        loader: Arc<dyn Fn() -> Result<T, String> + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(SwrInner {
                config,
                loader,
                state: Mutex::new(SwrState {
                    value: None,
                    rev: 0,
                    updated_at: None,
                    forced_stale: false,
                    in_flight: false,
                    last_error: None,
                    last_error_at: None,
                }),
                cvar: Condvar::new(),
            }),
        }
    }

    /// Triggers an asynchronous single-flight prewarm if no refresh is already in-flight.
    pub fn prewarm(&self) {
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let _ = self.spawn_refresh_locked(&mut st);
    }

    /// Triggers an asynchronous single-flight refresh even if the cached value is still fresh.
    ///
    /// Returns `true` if a new background refresh was started, `false` if one was already in-flight.
    pub fn force_refresh_async(&self) -> bool {
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        self.spawn_refresh_locked(&mut st)
    }

    /// Marks the currently cached value stale without dropping it so subsequent warm reads
    /// still return immediately while kicking off a background revalidation.
    pub fn invalidate(&self) {
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        st.forced_stale = true;
    }

    /// Directly installs a freshly computed value (for example, after a mutating command),
    /// increments the monotonic `rev` counter, marks it fresh, and returns the new `rev`.
    pub fn set_value(&self, value: T) -> u64 {
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        st.rev = st.rev.saturating_add(1);
        st.value = Some(Arc::new(value));
        st.updated_at = Some(Instant::now());
        st.forced_stale = false;
        st.last_error = None;
        st.last_error_at = None;
        let rev = st.rev;
        self.inner.cvar.notify_all();
        rev
    }

    /// Returns the current monotonic revision (`0` if no value has been loaded yet).
    pub fn current_rev(&self) -> u64 {
        let st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        st.rev
    }

    /// Returns `true` when `since_rev > 0` and the cached revision has not changed.
    ///
    /// Useful for 0-byte unchanged polling responses (`{ "unchanged": true, "rev": rev }`).
    pub fn is_unchanged(&self, since_rev: u64) -> bool {
        if since_rev == 0 {
            return false;
        }
        let st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        st.rev == since_rev && st.value.is_some()
    }

    /// Checks whether `since_rev` still matches the cached revision AND kicks off a
    /// non-blocking background refresh if the entry is stale.
    pub fn is_unchanged_and_revalidate(&self, since_rev: u64) -> bool {
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let unchanged = since_rev > 0 && st.rev == since_rev && st.value.is_some();
        if self.is_stale_locked(&st) && !self.in_error_backoff_locked(&st) {
            let _ = self.spawn_refresh_locked(&mut st);
        }
        unchanged
    }

    /// Returns `true` if a background refresh thread is currently executing.
    pub fn in_flight(&self) -> bool {
        let st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        st.in_flight
    }

    /// Returns the most recent background refresh error, if the last refresh failed.
    pub fn last_error(&self) -> Option<String> {
        let st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        st.last_error.clone()
    }

    /// Returns the cached snapshot immediately on warm hits (triggering at most one background
    /// refresh if stale), or performs a bounded single-flight wait on cold boot.
    pub fn get_or_trigger_refresh(&self) -> Result<SwrSnapshot<T>, String> {
        let mut st = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());

        // Warm path: NEVER block on I/O.
        if let Some(ref val) = st.value {
            let stale = self.is_stale_locked(&st);
            let snap = SwrSnapshot {
                value: Arc::clone(val),
                rev: st.rev,
                stale,
            };
            if stale && !self.in_error_backoff_locked(&st) {
                let _ = self.spawn_refresh_locked(&mut st);
            }
            return Ok(snap);
        }

        // Cold path: start (or coalesce onto) the single in-flight refresh.
        let _ = self.spawn_refresh_locked(&mut st);

        let timeout = self.inner.config.cold_wait_timeout;
        if timeout.is_zero() {
            return Err(st
                .last_error
                .clone()
                .unwrap_or_else(|| "cache warming in background".to_string()));
        }

        let deadline = Instant::now() + timeout;
        while st.value.is_none() && st.in_flight {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            if remaining.is_zero() {
                break;
            }
            let (guard, wait_res) = self
                .inner
                .cvar
                .wait_timeout(st, remaining)
                .unwrap_or_else(|e| e.into_inner());
            st = guard;
            if wait_res.timed_out() {
                break;
            }
        }

        if let Some(ref val) = st.value {
            Ok(SwrSnapshot {
                value: Arc::clone(val),
                rev: st.rev,
                stale: self.is_stale_locked(&st),
            })
        } else if let Some(ref err) = st.last_error {
            Err(err.clone())
        } else {
            Err("cache cold wait timed out while refresh in flight".to_string())
        }
    }

    fn is_stale_locked(&self, st: &SwrState<T>) -> bool {
        if st.forced_stale {
            return true;
        }
        match st.updated_at {
            Some(at) => at.elapsed() >= self.inner.config.fresh_ttl,
            None => true,
        }
    }

    fn in_error_backoff_locked(&self, st: &SwrState<T>) -> bool {
        if self.inner.config.error_backoff.is_zero() {
            return false;
        }
        match st.last_error_at {
            Some(at) => at.elapsed() < self.inner.config.error_backoff,
            None => false,
        }
    }

    fn spawn_refresh_locked(&self, st: &mut SwrState<T>) -> bool {
        if st.in_flight {
            return false;
        }
        st.in_flight = true;

        let inner = Arc::clone(&self.inner);
        let thread_name = inner.config.thread_name.clone();
        let spawn_res = thread::Builder::new().name(thread_name).spawn(move || {
            let mut guard = InFlightGuard {
                inner: Arc::clone(&inner),
                completed: false,
            };
            let res = (inner.loader)();
            let mut st = inner.state.lock().unwrap_or_else(|e| e.into_inner());
            match res {
                Ok(val) => {
                    st.rev = st.rev.saturating_add(1);
                    st.value = Some(Arc::new(val));
                    st.updated_at = Some(Instant::now());
                    st.forced_stale = false;
                    st.last_error = None;
                    st.last_error_at = None;
                }
                Err(err) => {
                    st.last_error = Some(err);
                    st.last_error_at = Some(Instant::now());
                }
            }
            st.in_flight = false;
            guard.completed = true;
            inner.cvar.notify_all();
        });

        if let Err(err) = spawn_res {
            st.in_flight = false;
            st.last_error = Some(format!("failed to spawn refresh thread: {err}"));
            st.last_error_at = Some(Instant::now());
            self.inner.cvar.notify_all();
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    #[test]
    fn coalesces_concurrent_cold_callers_into_single_flight_refresh() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_clone = Arc::clone(&calls);

        let cache = SwrCache::new(
            SwrConfig {
                fresh_ttl: Duration::from_secs(5),
                cold_wait_timeout: Duration::from_secs(2),
                error_backoff: Duration::ZERO,
                thread_name: "test-swr-cold".into(),
            },
            Arc::new(move || {
                calls_clone.fetch_add(1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(60));
                Ok("fresh-value".to_string())
            }),
        );

        let workers = 8;
        let barrier = Arc::new(Barrier::new(workers));
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            let c = cache.clone();
            let b = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                b.wait();
                c.get_or_trigger_refresh()
            }));
        }

        for h in handles {
            let snap = h.join().unwrap().expect("cold wait succeeds");
            assert_eq!(*snap.value, "fresh-value");
            assert_eq!(snap.rev, 1);
            assert!(!snap.stale);
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "all concurrent cold callers must coalesce onto 1 loader invocation"
        );
    }

    #[test]
    fn warm_stale_read_returns_sub_millisecond_without_blocking_on_slow_loader() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_clone = Arc::clone(&calls);

        let cache = SwrCache::new(
            SwrConfig {
                fresh_ttl: Duration::from_millis(80),
                cold_wait_timeout: Duration::from_millis(200),
                error_backoff: Duration::ZERO,
                thread_name: "test-swr-warm".into(),
            },
            Arc::new(move || {
                let n = calls_clone.fetch_add(1, Ordering::SeqCst) + 1;
                if n > 1 {
                    // Simulate slow CLI/hardware I/O (150ms)
                    thread::sleep(Duration::from_millis(150));
                }
                Ok(n)
            }),
        );

        let s1 = cache.get_or_trigger_refresh().unwrap();
        assert_eq!(*s1.value, 1);
        assert_eq!(s1.rev, 1);
        assert!(!s1.stale);
        assert!(cache.is_unchanged(1));
        assert!(!cache.is_unchanged(0));
        assert!(!cache.is_unchanged(2));

        // Wait for TTL expiry
        thread::sleep(Duration::from_millis(95));

        // Trigger multiple stale reads concurrently: MUST return immediately (< 15ms even under CI load)
        // and launch AT MOST 1 background refresh thread!
        let t0 = Instant::now();
        for _ in 0..10 {
            let snap = cache.get_or_trigger_refresh().unwrap();
            assert_eq!(*snap.value, 1);
            assert_eq!(snap.rev, 1);
            assert!(snap.stale);
        }
        assert!(
            t0.elapsed() < Duration::from_millis(50),
            "warm stale reads must never block on slow loader (elapsed {:?})",
            t0.elapsed()
        );
        assert!(cache.in_flight());

        // Wait promptly for the single-flight background refresh to complete
        let wait_start = Instant::now();
        while cache.in_flight() && wait_start.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "at most 1 background refresh spawned"
        );

        let s2 = cache.get_or_trigger_refresh().unwrap();
        assert_eq!(*s2.value, 2);
        assert_eq!(s2.rev, 2);
        assert!(!s2.stale);
        assert!(!cache.is_unchanged(1));
        assert!(cache.is_unchanged(2));
    }

    #[test]
    fn preserves_stale_value_on_refresh_error_and_supports_set_value() {
        let should_fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fail_flag = Arc::clone(&should_fail);

        let cache = SwrCache::new(
            SwrConfig {
                fresh_ttl: Duration::from_secs(10),
                cold_wait_timeout: Duration::from_millis(200),
                error_backoff: Duration::ZERO,
                thread_name: "test-swr-err".into(),
            },
            Arc::new(move || {
                if fail_flag.load(Ordering::SeqCst) {
                    Err("device offline".to_string())
                } else {
                    Ok("initial".to_string())
                }
            }),
        );

        let rev = cache.set_value("seeded".to_string());
        assert_eq!(rev, 1);
        assert!(cache.is_unchanged(1));

        should_fail.store(true, Ordering::SeqCst);
        cache.invalidate();
        let snap = cache.get_or_trigger_refresh().unwrap();
        assert_eq!(*snap.value, "seeded");
        assert!(snap.stale);

        // Wait for failed background refresh
        let start = Instant::now();
        while cache.in_flight() && start.elapsed() < Duration::from_secs(1) {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(cache.last_error().as_deref(), Some("device offline"));
        // Stale value still served safely
        let snap2 = cache.get_or_trigger_refresh().unwrap();
        assert_eq!(*snap2.value, "seeded");
        assert_eq!(snap2.rev, 1);
    }

    #[test]
    fn cold_zero_timeout_returns_without_blocking() {
        let cache = SwrCache::new(
            SwrConfig {
                fresh_ttl: Duration::from_secs(5),
                cold_wait_timeout: Duration::ZERO,
                error_backoff: Duration::ZERO,
                thread_name: "test-swr-nonblock".into(),
            },
            Arc::new(|| {
                thread::sleep(Duration::from_millis(120));
                Ok(42usize)
            }),
        );

        let t0 = Instant::now();
        let err = cache.get_or_trigger_refresh().unwrap_err();
        assert!(t0.elapsed() < Duration::from_millis(50));
        assert!(err.contains("warming"));

        // Once prewarm completes, warm read succeeds
        thread::sleep(Duration::from_millis(160));
        let snap = cache.get_or_trigger_refresh().unwrap();
        assert_eq!(*snap.value, 42);
    }
}
