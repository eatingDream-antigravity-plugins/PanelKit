//! Compile-time and test-mode refusal guard for host OS side effects.
//!
//! Any OS-level browser/process launcher, display/brightness/lock-screen controller,
//! hardware writer, or billed cloud call should gate real host execution with
//! [`ensure_not_in_test`] (or the [`guard_host_effect!`] macro when used as a crate
//! dependency) so automated test suites can never disturb the live desktop or incur cost.

/// Environment variable that forces [`ensure_not_in_test`] to refuse host side effects
/// even in non-`#[cfg(test)]` builds (for example, integration tests executing a built binary).
pub const TEST_GUARD_ENV: &str = "AGY_TEST_GUARD_DENY";

/// Refuses host side effects during `#[cfg(test)]` builds or when `AGY_TEST_GUARD_DENY`
/// is set to a truthy value (`1`, `true`, `yes`).
///
/// When this file is vendored directly into a plugin crate via `scripts/sync-kit.sh`,
/// `#[cfg(test)]` fires at compile time during `cargo test`. When consumed as an external
/// library crate, prefer [`crate::guard_host_effect!`] at the call site so `#[cfg(test)]`
/// evaluates in the downstream crate.
pub fn ensure_not_in_test(action: &str) -> Result<(), String> {
    #[cfg(test)]
    {
        Err(format!(
            "refusing host side effect during test build: {action}"
        ))
    }
    #[cfg(not(test))]
    {
        if is_runtime_guard_active() {
            return Err(format!(
                "refusing host side effect ({TEST_GUARD_ENV} enabled): {action}"
            ));
        }
        Ok(())
    }
}

/// Evaluates whether the runtime environment safety valve is enabled.
pub fn is_runtime_guard_active() -> bool {
    match std::env::var(TEST_GUARD_ENV) {
        Ok(val) => matches!(
            val.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

/// Evaluates `#[cfg(test)]` at the **caller's** crate site and also checks the runtime
/// [`TEST_GUARD_ENV`] safety valve.
#[macro_export]
macro_rules! guard_host_effect {
    ($action:expr) => {{
        #[cfg(test)]
        {
            Err::<(), String>(format!(
                "refusing host side effect during test build: {}",
                $action
            ))
        }
        #[cfg(not(test))]
        {
            $crate::test_guard::ensure_not_in_test($action)
        }
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_host_side_effects_under_cfg_test() {
        let err = ensure_not_in_test("pmset displaysleepnow").unwrap_err();
        assert!(err.contains("refusing host side effect during test build"));
        assert!(err.contains("pmset displaysleepnow"));

        let macro_err = crate::guard_host_effect!("launch live browser").unwrap_err();
        assert!(macro_err.contains("launch live browser"));
    }
}
