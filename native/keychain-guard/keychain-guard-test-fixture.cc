// Test-only N-API addon: compiles the real keychain-guard.cc with all three SecKeychain calls
// redirected to deterministic stubs, so probe() can run without touching a real Keychain.
// Built by scripts/release/__tests__/keychain-guard.test.mjs; never shipped.

#include <node_api.h>

#include <Security/Security.h>

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

std::vector<std::string> trace;
int set_false_calls = 0;

enum Scenario {
  kSuccess,
  kDenied,
  kCancelled,
  kGuardSetupFails,
  kGuardRestoreFails,
  kInteractiveSetFails,
  kAbsent,
};

Scenario scenario = kSuccess;

void Record(const std::string& entry) { trace.push_back(entry); }

}  // namespace

static OSStatus StubSetInteractionAllowed(Boolean state) {
  Record(state ? "set:true" : "set:false");
  if (state) {
    return scenario == kInteractiveSetFails ? errSecInteractionNotAllowed : noErr;
  }
  ++set_false_calls;
  if (scenario == kGuardSetupFails && set_false_calls == 1) return errSecInteractionNotAllowed;
  if (scenario == kGuardRestoreFails && set_false_calls >= 2) return errSecInteractionNotAllowed;
  return noErr;
}

static OSStatus StubFindGenericPassword(CFTypeRef, UInt32 serviceLength, const char* service,
                                        UInt32 accountLength, const char* account,
                                        UInt32* passwordLength, void** passwordData,
                                        SecKeychainItemRef* item) {
  Record("find:" + std::string(service, serviceLength) + "/" +
         std::string(account, accountLength));
  if (scenario == kAbsent) return errSecItemNotFound;
  if (scenario == kDenied) return errSecAuthFailed;
  if (scenario == kCancelled) return errSecUserCanceled;
  if (item != nullptr) *item = reinterpret_cast<SecKeychainItemRef>(1);
  if (passwordData != nullptr) {
    *passwordData = std::malloc(4);
    std::memcpy(*passwordData, "sec!", 4);
    if (passwordLength != nullptr) *passwordLength = 4;
  }
  return noErr;
}

static OSStatus StubFreeContent(SecKeychainAttributeList*, void* data) {
  Record("free");
  std::free(data);
  return noErr;
}

static OSStatus StubDelete(SecKeychainItemRef) {
  Record("delete");
  return scenario == kDenied ? errSecAuthFailed : noErr;
}
static void StubRelease(CFTypeRef) { Record("release"); }

// Redirect only the production source's calls; Security.h was included above under real names.
#define SecKeychainSetUserInteractionAllowed StubSetInteractionAllowed
#define SecKeychainFindGenericPassword StubFindGenericPassword
#define SecKeychainItemFreeContent StubFreeContent
#define SecKeychainItemDelete StubDelete
#define CFRelease StubRelease
#undef NAPI_MODULE_INIT
#define NAPI_MODULE_INIT() static napi_value RegisterProduction(napi_env env, napi_value exports)
#include "keychain-guard.cc"
#undef NAPI_MODULE_INIT
#undef SecKeychainSetUserInteractionAllowed
#undef SecKeychainFindGenericPassword
#undef SecKeychainItemFreeContent
#undef SecKeychainItemDelete
#undef CFRelease

namespace {

napi_value Reset(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    napi_throw_type_error(env, nullptr, "reset expects exactly one scenario name");
    return nullptr;
  }
  char name[64];
  size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &length) != napi_ok) {
    napi_throw_type_error(env, nullptr, "reset expects a scenario name");
    return nullptr;
  }
  const std::string value(name, length);
  if (value == "success") {
    scenario = kSuccess;
  } else if (value == "absent") {
    scenario = kAbsent;
  } else if (value == "denied") {
    scenario = kDenied;
  } else if (value == "cancelled") {
    scenario = kCancelled;
  } else if (value == "guard-setup-fails") {
    scenario = kGuardSetupFails;
  } else if (value == "guard-restore-fails") {
    scenario = kGuardRestoreFails;
  } else if (value == "interactive-set-fails") {
    scenario = kInteractiveSetFails;
  } else {
    napi_throw_error(env, nullptr, "unknown scenario");
    return nullptr;
  }
  trace.clear();
  set_false_calls = 0;
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Trace(napi_env env, napi_callback_info) {
  napi_value array;
  if (napi_create_array_with_length(env, trace.size(), &array) != napi_ok) return nullptr;
  for (size_t i = 0; i < trace.size(); ++i) {
    napi_value entry;
    if (napi_create_string_utf8(env, trace[i].c_str(), trace[i].size(), &entry) != napi_ok ||
        napi_set_element(env, array, i, entry) != napi_ok) {
      return nullptr;
    }
  }
  return array;
}

napi_value InitTest(napi_env env, napi_value exports) {
  if (RegisterProduction(env, exports) == nullptr) return nullptr;
  napi_value function;
  if (napi_create_function(env, "reset", NAPI_AUTO_LENGTH, Reset, nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "reset", function) != napi_ok ||
      napi_create_function(env, "trace", NAPI_AUTO_LENGTH, Trace, nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "trace", function) != napi_ok) {
    napi_throw_error(env, nullptr, "failed to export test helpers");
    return nullptr;
  }
  return exports;
}

}  // namespace

static napi_module test_module = {
    NAPI_MODULE_VERSION,
    0,
    __FILE__,
    InitTest,
    "keychain-guard-test",
    nullptr,
    {nullptr, nullptr, nullptr, nullptr},
};

__attribute__((constructor)) static void RegisterTestModule(void) {
  napi_module_register(&test_module);
}
