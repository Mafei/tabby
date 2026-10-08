use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};

use crate::{BridgeError, command_json, destroy, poll_json, start_json};

fn guarded<T>(operation: impl FnOnce() -> Result<T, BridgeError>) -> Result<T, BridgeError> {
    crate::panic_guard::install_safe_hook();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
        .unwrap_or(Err(BridgeError("native_panic")))
}

fn read_string(env: &mut JNIEnv<'_>, value: JString<'_>) -> Result<String, BridgeError> {
    env.get_string(&value)
        .map(|s| s.into())
        .map_err(|_| BridgeError("invalid_jni_string"))
}

fn throw(env: &mut JNIEnv<'_>, error: BridgeError) {
    let _ = env.throw_new("java/lang/IllegalStateException", error.0);
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tabby_android_ssh_NativeSSH_start(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    options: JString<'_>,
) -> jlong {
    match guarded(|| read_string(&mut env, options).and_then(|s| start_json(&s))) {
        Ok(id) => id as jlong,
        Err(error) => {
            throw(&mut env, error);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tabby_android_ssh_NativeSSH_command(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    id: jlong,
    command: JString<'_>,
) {
    let result = guarded(|| {
        read_string(&mut env, command).and_then(|s| {
            let command = zeroize::Zeroizing::new(s);
            command_json(id as u64, &command)
        })
    });
    if let Err(error) = result {
        throw(&mut env, error);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tabby_android_ssh_NativeSSH_poll(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    id: jlong,
) -> jstring {
    match guarded(|| poll_json(id as u64)) {
        Ok(json) => match env.new_string(json) {
            Ok(value) => value.into_raw(),
            Err(_) => {
                throw(&mut env, BridgeError("jni_allocation_failed"));
                std::ptr::null_mut()
            }
        },
        Err(error) => {
            throw(&mut env, error);
            std::ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_org_tabby_android_ssh_NativeSSH_destroy(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    id: jlong,
) {
    if let Err(error) = guarded(|| {
        destroy(id as u64);
        Ok(())
    }) {
        throw(&mut env, error);
    }
}
