use agy_mcp_kit::test_guard::{ensure_not_in_test, TEST_GUARD_ENV};

#[test]
fn macro_refuses_in_downstream_integration_test_and_runtime_env_gates_compiled_lib() {
    // 1. Macro evaluates #[cfg(test)] at the downstream caller's crate site.
    let macro_err = agy_mcp_kit::guard_host_effect!("spawn external browser").unwrap_err();
    assert!(macro_err.contains("refusing host side effect during test build"));
    assert!(macro_err.contains("spawn external browser"));

    // 2. Compiled library function relies on AGY_TEST_GUARD_DENY in non-vendored builds.
    let prev = std::env::var_os(TEST_GUARD_ENV);
    std::env::set_var(TEST_GUARD_ENV, "1");
    let runtime_err = ensure_not_in_test("write hardware register").unwrap_err();
    assert!(runtime_err.contains(TEST_GUARD_ENV));
    assert!(runtime_err.contains("write hardware register"));

    match prev {
        Some(v) => std::env::set_var(TEST_GUARD_ENV, v),
        None => std::env::remove_var(TEST_GUARD_ENV),
    }
}
