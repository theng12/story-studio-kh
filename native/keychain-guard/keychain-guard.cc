// keychain-guard.cc — minimal N-API addon for the macOS file-based Keychain.
//
// Chromium's queryUIFail alone cannot tell whether this app is allowed to read its own item, so the
// caller needs two process-local facts: the interaction switch can be set, and a read of the exact
// service/account succeeds without a prompt. No secret ever crosses this boundary.
//
// Exports:
//   setInteractionAllowed(boolean) -> OSStatus
//   probe(service, account, interactive) -> OSStatus

#include <node_api.h>

#include <Security/Security.h>

#include <cstdint>
#include <string>

namespace {

void ThrowError(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
}

void ThrowStatus(napi_env env, const char* message, OSStatus status) {
  std::string text = message;
  text += " (OSStatus ";
  text += std::to_string(static_cast<long long>(status));
  text += ")";
  napi_throw_error(env, nullptr, text.c_str());
}

void ThrowType(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
}

// Reads a non-empty UTF-8 string without embedded NUL bytes. Rejects rather than truncating.
bool ReadName(napi_env env, napi_value value, const char* argument, std::string* out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    ThrowType(env, argument);
    return false;
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0 ||
      length > UINT32_MAX) {
    ThrowType(env, argument);
    return false;
  }
  std::string text(length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, &text[0], text.size(), &copied) != napi_ok ||
      copied != length) {
    ThrowType(env, argument);
    return false;
  }
  text.resize(copied);
  if (text.find('\0') != std::string::npos) {
    ThrowType(env, argument);
    return false;
  }
  *out = text;
  return true;
}

bool ReadBoolean(napi_env env, napi_value value, const char* argument, bool* out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_boolean) {
    ThrowType(env, argument);
    return false;
  }
  return napi_get_value_bool(env, value, out) == napi_ok;
}

napi_value SetInteractionAllowed(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    ThrowType(env, "setInteractionAllowed expects exactly one boolean argument");
    return nullptr;
  }
  bool allowed = false;
  if (!ReadBoolean(env, argv[0], "setInteractionAllowed expects a boolean", &allowed)) {
    return nullptr;
  }
  const OSStatus status = SecKeychainSetUserInteractionAllowed(allowed);
  napi_value result;
  if (napi_create_int32(env, status, &result) != napi_ok) {
    ThrowError(env, "setInteractionAllowed could not create its result");
    return nullptr;
  }
  return result;
}

napi_value Probe(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc = 4;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3) {
    ThrowType(env, "probe expects exactly three arguments (service, account, interactive)");
    return nullptr;
  }
  std::string service;
  std::string account;
  bool interactive = false;
  if (!ReadName(env, argv[0], "probe service must be a non-empty string", &service) ||
      !ReadName(env, argv[1], "probe account must be a non-empty string", &account) ||
      !ReadBoolean(env, argv[2], "probe interactive must be a boolean", &interactive)) {
    return nullptr;
  }

  const OSStatus guard = SecKeychainSetUserInteractionAllowed(false);
  if (guard != noErr) {
    ThrowStatus(env, "SecKeychainSetUserInteractionAllowed(false) failed", guard);
    return nullptr;
  }

  if (interactive) {
    const OSStatus allowed = SecKeychainSetUserInteractionAllowed(true);
    if (allowed != noErr) {
      const OSStatus restored = SecKeychainSetUserInteractionAllowed(false);
      if (restored != noErr) {
        ThrowStatus(env, "restoring the keychain interaction guard failed", restored);
      } else {
        ThrowStatus(env, "SecKeychainSetUserInteractionAllowed(true) failed", allowed);
      }
      return nullptr;
    }
  }

  UInt32 passwordLength = 0;
  void* passwordData = nullptr;
  const OSStatus status = SecKeychainFindGenericPassword(
      nullptr, static_cast<UInt32>(service.size()), service.data(),
      static_cast<UInt32>(account.size()), account.data(), &passwordLength, &passwordData, nullptr);
  // Free the secret before anything else, on every path; it is never exposed to JavaScript.
  if (passwordData != nullptr) {
    SecKeychainItemFreeContent(nullptr, passwordData);
    passwordData = nullptr;
  }

  const OSStatus restored = SecKeychainSetUserInteractionAllowed(false);
  if (restored != noErr) {
    ThrowStatus(env, "restoring the keychain interaction guard failed", restored);
    return nullptr;
  }

  napi_value result;
  if (napi_create_int32(env, status, &result) != napi_ok) {
    ThrowError(env, "probe could not create its result");
    return nullptr;
  }
  return result;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "setInteractionAllowed", NAPI_AUTO_LENGTH, SetInteractionAllowed,
                           nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "setInteractionAllowed", function) != napi_ok) {
    ThrowError(env, "failed to export setInteractionAllowed");
    return nullptr;
  }
  if (napi_create_function(env, "probe", NAPI_AUTO_LENGTH, Probe, nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "probe", function) != napi_ok) {
    ThrowError(env, "failed to export probe");
    return nullptr;
  }
  return exports;
}
