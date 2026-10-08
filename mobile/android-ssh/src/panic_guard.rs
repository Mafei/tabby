use std::sync::Once;

/// This is the application's only Rust component. Replace the process-global
/// Rust panic hook so an unexpected dependency panic cannot print a payload
/// (which could contain key material) to Android logcat before catch_unwind.
/// Normal stable bridge errors remain available to the UI; JVM hooks are intact.
pub(crate) fn install_safe_hook() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| std::panic::set_hook(Box::new(|_| {})));
}

#[cfg(test)]
mod tests {
    #[test]
    fn safe_panic_hook_does_not_print_payload() {
        const MARKER: &str = "DUMMY_PRIVATE_KEY_PANIC_MARKER";
        if std::env::var_os("TABBY_PANIC_TEST_CHILD").is_some() {
            super::install_safe_hook();
            assert!(std::panic::catch_unwind(|| panic!("{MARKER}")).is_err());
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("panic_guard::tests::safe_panic_hook_does_not_print_payload")
            .arg("--nocapture")
            .env("TABBY_PANIC_TEST_CHILD", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains(MARKER));
        assert!(!String::from_utf8_lossy(&output.stdout).contains(MARKER));
    }
}
