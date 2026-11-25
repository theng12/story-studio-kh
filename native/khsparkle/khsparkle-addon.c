/* The shim call site for an Electron app. Sparkle must run in the app's own process against the
 * app's own bundle, so the C surface in khsparkle.h is exposed to Node as a small N-API addon.
 * The app calls `start()` once from the main process after the window exists. */
#include <node_api.h>
#include "khsparkle.h"

static napi_value Start(napi_env env, napi_callback_info info) {
  napi_value rc;
  napi_create_int32(env, kh_sparkle_start(), &rc);
  return rc;
}

static napi_value LastError(napi_env env, napi_callback_info info) {
  napi_value message;
  napi_create_string_utf8(env, kh_sparkle_last_error(), NAPI_AUTO_LENGTH, &message);
  return message;
}

static napi_value State(napi_env env, napi_callback_info info) {
  napi_value state;
  napi_create_int32(env, kh_sparkle_state(), &state);
  return state;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, NULL, &fn);
  napi_set_named_property(env, exports, "start", fn);
  napi_create_function(env, "lastError", NAPI_AUTO_LENGTH, LastError, NULL, &fn);
  napi_set_named_property(env, exports, "lastError", fn);
  napi_create_function(env, "state", NAPI_AUTO_LENGTH, State, NULL, &fn);
  napi_set_named_property(env, exports, "state", fn);
  return exports;
}
